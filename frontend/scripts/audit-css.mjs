#!/usr/bin/env node
// Guards the bug that produced the "inconsistent layout" complaint: global.css was rewritten to a
// new class vocabulary while pages still used the old one, so ~18 classes rendered with no rule at
// all. tsc cannot see that and review misses it, so it gets a check of its own.
//   node scripts/audit-css.mjs          -> full report
//   node scripts/audit-css.mjs --strict -> exit 1 if a class is used in JSX with no CSS rule
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src'));
const code = files.filter((f) => /\.tsx?$/.test(f));
const sheets = files.filter((f) => f.endsWith('.css'));

const NAME = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const used = new Map();      // class -> Set<file>, seen as a literal inside className
const prefixes = new Set();  // `slot-${kind}` -> "slot-", so slot-ip is not reported dead
const literals = new Set();  // every string literal in src, for the dead-rule check only

// One nesting level of ${ } is enough for the ternaries this codebase uses.
const INTERP = /\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/;

function addStatic(tok, file) {
  if (!tok || !NAME.test(tok)) return;
  if (!used.has(tok)) used.set(tok, new Set());
  used.get(tok).add(relative(ROOT, file));
}

/** Template literals split into static parts; a part touching a ${} boundary is a fragment. */
function addTemplate(raw, file) {
  const parts = raw.split(new RegExp(INTERP.source, 'g'));
  parts.forEach((part, i) => {
    const toks = part.split(/\s+/);
    const touchesNext = i < parts.length - 1 && !/\s$/.test(part);
    const touchesPrev = i > 0 && !/^\s/.test(part);
    toks.forEach((tok, j) => {
      if (!tok) return;
      // A token glued to ${} is ambiguous: `slot-${k}` builds a name, while
      // `sidebar${open ? ' open' : ''}` is a whole class with an optional one appended.
      // Record it as a prefix either way, and also as a real class unless it ends in a
      // separator, which only a built name does.
      if (touchesNext && j === toks.length - 1) {
        prefixes.add(tok);
        if (!/[-_]$/.test(tok)) addStatic(tok, file);
        return;
      }
      // `${x}-b` leaves "-b": the tail of a name that was built at runtime. Unknowable.
      if (touchesPrev && j === 0) return;
      addStatic(tok, file);
    });
  });
}

const CLASSNAME = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g;
for (const file of code) {
  const src = readFileSync(file, 'utf8');
  // Split on whitespace: a class applied through a variable is often written as ' done'.
  for (const m of src.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)) {
    for (const tok of (m[1] ?? m[2]).split(/\s+/)) if (tok) literals.add(tok);
  }
  CLASSNAME.lastIndex = 0;
  let m;
  while ((m = CLASSNAME.exec(src))) {
    if (m[1] !== undefined || m[2] !== undefined) {
      for (const tok of (m[1] ?? m[2]).split(/\s+/)) addStatic(tok, file);
      continue;
    }
    // className={...}: walk to the matching brace, then read every literal inside it.
    let depth = 1;
    let i = CLASSNAME.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const expr = src.slice(CLASSNAME.lastIndex, i - 1);
    for (const lit of expr.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      for (const tok of (lit[1] ?? lit[2]).split(/\s+/)) addStatic(tok, file);
    }
    for (const lit of expr.matchAll(/`([^`]*)`/g)) addTemplate(lit[1], file);
    CLASSNAME.lastIndex = i;
  }
}

const defined = new Map();
for (const file of sheets) {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // prose in comments names classes too
    .replace(/@import[^;]*;/g, ' ')      // './tokens.css' is a path, not a .css class
    .replace(/\{[^{}]*\}/g, ' {} ');    // keep selectors, drop declaration bodies
  for (const m of src.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
    if (!defined.has(m[1])) defined.set(m[1], new Set());
    defined.get(m[1]).add(relative(ROOT, file));
  }
}

// Deliberately kept although nothing uses them today: `sr-only` is the accessibility escape
// hatch, and `btn` is what pairs every `button` rule so an anchor can be styled as one.
const KEEP = new Set(['sr-only', 'btn']);
const dynamic = (c) => [...prefixes].some((p) => c.startsWith(p) && c !== p);
const orphans = [...used.keys()].filter((c) => !defined.has(c) && !dynamic(c)).sort();
const unused = [...defined.keys()].filter((c) => !used.has(c) && !dynamic(c) && !KEEP.has(c)).sort();
// A rule whose name appears as a plain string somewhere is almost certainly applied via a
// variable or lookup table; report it separately so the dead list stays worth reading.
const indirect = unused.filter((c) => literals.has(c));
const dead = unused.filter((c) => !literals.has(c));

console.log(`css audit: ${used.size} classes + ${prefixes.size} dynamic prefixes across ${code.length} files, ${defined.size} rules in ${sheets.length} stylesheets`);
console.log(`\nUSED WITH NO RULE (${orphans.length}) — these render unstyled:`);
for (const c of orphans) console.log(`  .${c}  <- ${[...used.get(c)].join(', ')}`);
console.log(`\nprobably dynamic, name appears as a bare string (${indirect.length}):`);
console.log(indirect.length ? `  ${indirect.map((c) => '.' + c).join(' ')}` : '  none');
console.log(`\nDEAD RULES (${dead.length}) — defined, never referenced:`);
for (const c of dead) console.log(`  .${c}  <- ${[...defined.get(c)].join(', ')}`);

if (process.argv.includes('--strict') && orphans.length > 0) {
  console.error(`\nFAIL: ${orphans.length} class(es) used in JSX have no CSS rule.`);
  process.exit(1);
}
