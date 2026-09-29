// First-visit guided tour: provider → any demo server → collection → human decision → dashboard + Grafana.
// Interactive: the ring and tip follow the exact next control live; nothing is forced, every step skippable.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { GrafanaLogo, grafanaOverviewUrl, useAlertingStatus } from '../lib/alerting';
import type { LlmSettings, Provider, SourceInfo } from '../lib/types';

const KEY = 'aletheia.tour';
const EVT = 'aletheia:tour';
const MIN_LINES = 100;

type Signal = 'provider';

/** Pages call this when the user completes a tour action. */
export const tourSignal = (s: Signal) => window.dispatchEvent(new CustomEvent(EVT, { detail: s }));

/** Clears the saved state and restarts the tour. */
export const restartTour = () => { store('0'); window.dispatchEvent(new CustomEvent(EVT, { detail: 'restart' })); };

function load(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }
function store(v: string) { try { localStorage.setItem(KEY, v); } catch { /* ignore */ } }

const OVERLAYS = '.modal-scrim, .modal-backdrop';

/** First visible match not hidden behind a dialog it is not part of; `text` filters by label. */
function find(sel: string, text?: RegExp): Element | null {
  const overlays = [...document.querySelectorAll(OVERLAYS)];
  return [...document.querySelectorAll(sel)].find((el) =>
    el.getClientRects().length > 0
    && !overlays.some((o) => !o.contains(el))
    && (!text || text.test((el.textContent ?? '').trim()))) ?? null;
}

/** One possible next action; the first move whose element is on screen is the one highlighted. */
interface Move { find: () => Element | null; tip: string; wait?: boolean }

interface Ctx { done: boolean; sources: SourceInfo[]; grafana: string | null; provider: Provider }

interface Step {
  path?: string;
  center?: boolean;
  kicker: string;
  title: string;
  body: (c: Ctx) => ReactNode;
  moves?: Move[];
  idle?: (c: Ctx) => ReactNode;   // status while waiting on the app rather than the user
  doneMsg?: string;
  next?: string;
  skipNext?: string;      // primary label while the step is unfinished: proceeding is a real choice
}

const collecting = (xs: SourceInfo[]) => [...xs].reverse().find((x) => x.state === 'collecting') ?? xs[xs.length - 1];

function Progress({ s }: { s?: SourceInfo }) {
  if (!s) return <>Waiting for the source to appear…</>;
  if (s.state === 'collecting' && (s.ready_for_review || s.lines >= MIN_LINES)) {
    return <>Sample collected. <b>Deriving the template</b> and mapping fields…</>;
  }
  const pct = Math.min(100, Math.round((s.lines / MIN_LINES) * 100));
  return (
    <span className="tour-prog">
      <span>Collecting <b>{s.name || s.id}</b> · {s.lines.toLocaleString()} lines</span>
      <span className="tour-bar"><i style={{ width: `${pct}%` }} /></span>
    </span>
  );
}

const STEPS: Step[] = [
  {
    path: '/dashboard', center: true, kicker: 'Welcome', title: 'Welcome to Aletheia',
    body: () => (
      <>
        <p>Logs from any vendor, turned into one OCSF schema, <b>losslessly</b>, and a human signs off before anything is normalized.</p>
        <ol className="tour-plan">
          <li><span>1</span>Choose how mappings get suggested</li>
          <li><span>2</span>Start any demo log server you like</li>
          <li><span>3</span>Watch it get collected and mapped</li>
          <li><span>4</span>Approve or reject the mapping</li>
        </ol>
        <p className="hint">About three minutes, hands on. Leave any time.</p>
      </>
    ),
    next: 'Start the tour',
  },
  {
    path: '/dashboard/settings', kicker: 'Step 1 of 4', title: 'How should mappings be suggested?',
    body: () => (
      <>
        <p>Aletheia maps fields with built-in heuristics. A model, if you connect one, only fills the slots the
          heuristics could not place, and it never sees a live event.</p>
        <ul className="tour-plan tour-choices">
          <li><b>None</b> heuristics alone. Nothing leaves this machine, and nothing here needs a key.</li>
          <li><b>Local model</b> Ollama, llama.cpp, vLLM or LM Studio on your own hardware.</li>
          <li><b>Gemini</b> cloud, with samples masked before they are sent.</li>
        </ul>
        <p className="hint">Pick whichever suits you. The rest of the tour works the same either way, and you can
          change it later on this page.</p>
      </>
    ),
    moves: [
      { find: () => find(`:is(${OVERLAYS}) :is(.modal-foot, footer, .modal-footer) button.primary`), tip: 'Save your choice' },
      { find: () => find('.provider-grid'), tip: 'Pick whichever you prefer' },
    ],
    doneMsg: 'Saved. That choice is yours to change any time.',
    next: 'Continue to Demo',
    skipNext: 'Keep what I have',
  },
  {
    path: '/dashboard/demo', kicker: 'Step 2 of 4', title: 'Pick a demo server',
    body: () => (
      <p>Fictional servers speaking real vendor formats: firewalls, VPNs, a web shop, an LLM training cluster.
        <b> Choose whichever looks interesting</b> and press Start. Peek at <b>Live logs</b> or try <b>Simulate
        attack</b> if you are curious, then press Connect.</p>
    ),
    moves: [
      { find: () => find('.sample-card:not(.off) button.primary', /^Connect$/), tip: 'Now press Connect' },
      { find: () => find('.sample-grid'), tip: 'Choose any server and press Start' },
    ],
  },
  {
    path: '/dashboard/sources', kicker: 'Step 3 of 4', title: 'Collecting and mapping',
    body: ({ sources, provider }) => {
      const s = collecting(sources);
      // The bundled servers onboard rules-only, so on this path nothing is sent anywhere at all.
      if (s?.rules_only || provider === 'none') {
        return (
          <p>Raw lines are stored first, untouched. The bundled servers are mapped by the built-in heuristics
            on this machine, so <b>nothing is sent anywhere</b>, whichever provider you picked.</p>
        );
      }
      return (
        <p>Raw lines are stored first, untouched. Your own sources ask {provider === 'local' ? 'your local model'
          : 'Gemini'} about the slots the heuristics could not place, and IPs, users, hosts and secrets are
          <b> masked</b> into typed placeholders first, so the model sees the shape, never your data.</p>
      );
    },
    moves: [
      { find: () => find('.src-connect .modal-foot button.primary'), tip: 'Confirm with Connect' },
      { find: () => find('.src-card:not(.ready)'), tip: 'Collecting and masking…', wait: true },
    ],
    idle: ({ sources }) => <Progress s={collecting(sources)} />,
    doneMsg: 'A mapping is ready.',
    next: 'Review it',
  },
  {
    path: '/dashboard/sources', kicker: 'Step 4 of 4', title: 'You make the call',
    body: () => (
      <>
        <p>Each pattern shows which raw token became which OCSF field. Take your time reading it.</p>
        <p><b>Approve</b> publishes the parser, <b>Retry</b> regroups with your feedback, <b>Reject</b> keeps the logs raw.
          Your name goes into the audit trail.</p>
      </>
    ),
    moves: [
      { find: () => find('.modal-foot button.primary', /^(Approve|Retry|Reject|Working…)$/), tip: 'Add your name and confirm' },
      { find: () => find('.modal button', /^Generate proposal$/), tip: 'Generate the proposal' },
      { find: () => find('.modal .btn-row', /Approve/), tip: 'Read the patterns below, then decide' },
      { find: () => find('.ready-banner:not(.pipe-down) button.primary'), tip: 'Open the review' },
    ],
    doneMsg: 'Decision recorded in the audit trail.',
    next: 'See the dashboard',
  },
  {
    path: '/dashboard', kicker: 'All set', title: 'Your live dashboard',
    body: ({ grafana }) => (
      <>
        <p>This is the Overview. Approved logs land here as OCSF events, live.</p>
        {grafana && (
          <a className="tour-gf-btn" href={grafana} target="_blank" rel="noopener noreferrer">
            <GrafanaLogo size={16} />View on Grafana ↗
          </a>
        )}
      </>
    ),
    moves: [{ find: () => find('.btn-grafana'), tip: 'Also on Grafana' }],
    next: 'Explore on my own',
  },
];

type Spot = { r: DOMRect; tip: string; wait?: boolean };
const same = (a: Spot | null, b: Spot | null) => !!a && !!b && a.tip === b.tip
  && a.r.x === b.r.x && a.r.y === b.r.y && a.r.width === b.r.width && a.r.height === b.r.height;

/** Re-resolves the step's moves every 250 ms, so the ring follows dialogs, scrolling and state. */
function useSpot(moves: Move[] | undefined) {
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    if (!moves) { setSpot(null); return; }
    let t = 0;
    const tick = () => {
      let next: Spot | null = null;
      for (const m of moves) {
        const el = m.find();
        if (el) { next = { r: el.getBoundingClientRect(), tip: m.tip, wait: m.wait }; break; }
      }
      setSpot((p) => (same(p, next) ? p : next));
      t = window.setTimeout(tick, 250);
    };
    tick();
    return () => window.clearTimeout(t);
  }, [moves]);
  return spot;
}

function Confetti() {
  return (
    <div className="tour-confetti" aria-hidden="true">
      {Array.from({ length: 36 }, (_, i) => (
        <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 9) * 60}ms`, ['--h' as string]: `${(i * 47) % 360}` }} />
      ))}
    </div>
  );
}

export function Tour() {
  const [step, setStep] = useState<number | null>(() => {
    const v = load();
    if (v === 'done') return null;
    const n = Number(v ?? 0);
    return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : 0;
  });
  const [done, setDone] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [provider, setProvider] = useState<Provider>('none');
  const baseline = useRef<Record<string, string> | null>(null);
  const grafana = grafanaOverviewUrl(useAlertingStatus().status);
  const nav = useNavigate();
  const loc = useLocation();
  const here = useRef(loc.pathname);
  here.current = loc.pathname;
  const s = step === null ? null : STEPS[step];
  const spot = useSpot(s && !s.center && !done ? s.moves : undefined);

  const go = useCallback((n: number | null) => {
    setDone(false);
    if (n === null || n >= STEPS.length) { store('done'); setStep(null); return; }
    store(String(n));
    setStep(n);
    const p = STEPS[n].path;
    if (p && here.current !== p) nav(p);
  }, [nav]);

  // Signals from pages, plus restart from the sidebar.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === 'restart') go(0);
      else if (d === 'provider') {
        api.getSettings().then((x: LlmSettings) => setProvider(x.provider)).catch(() => { /* keep the last value */ });
        if (step === 1) setDone(true);
      }
    };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, [go, step]);

  // Whatever the user already had before the tour started.
  useEffect(() => {
    if (step === null) return;
    api.getSettings().then((x: LlmSettings) => setProvider(x.provider)).catch(() => { /* keep the default */ });
  }, [step]);

  // Connect on the Demo page lands on Sources, which completes step 2.
  useEffect(() => {
    if (step === 2 && loc.pathname.startsWith('/dashboard/sources')) go(3);
  }, [step, loc.pathname, go]);

  // Steps 3–4 watch source state; a decision is a source leaving 'review' after step 4 began.
  useEffect(() => {
    if (step !== 3 && step !== 4) return;
    let alive = true;
    let t: number | undefined;
    baseline.current = null;
    const poll = async () => {
      try {
        const r = await api.listSources();
        if (!alive) return;
        setSources(r.sources);
        if (step === 3 && r.sources.some((x) => x.state === 'review')) setDone(true);
        if (step === 4) {
          const b = baseline.current;
          if (!b) baseline.current = Object.fromEntries(r.sources.map((x) => [x.id, x.state]));
          else if (r.sources.some((x) => b[x.id] === 'review' && (x.state === 'approved' || x.state === 'rejected'))) setDone(true);
        }
      } catch { /* the page shows its own errors */ }
      if (alive) t = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(t); };
  }, [step]);

  useEffect(() => {
    if (step === null || !STEPS[step].center) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') go(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, go]);

  if (step === null || !s) return null;
  const ctx: Ctx = { done, sources, grafana, provider };
  const last = step === STEPS.length - 1;
  const pad = 6;
  const status = !s.moves || last ? null
    : done ? s.doneMsg
      : spot && !(spot.wait && s.idle) ? <>Next: <b>{spot.tip}</b></>
        : s.idle?.(ctx) ?? 'Follow the highlight.';
  const tipBelow = !!spot && spot.r.top < 48;

  return createPortal(
    <>
      {s.center && <div className="tour-scrim" onClick={() => go(null)} />}
      {spot && (
        <>
          <div className="tour-ring" style={{
            top: spot.r.top - pad, left: spot.r.left - pad, width: spot.r.width + pad * 2, height: spot.r.height + pad * 2,
          }} />
          <div className={`tour-tip${tipBelow ? ' below' : ''}`} style={{
            top: tipBelow ? spot.r.top + pad + 8 : spot.r.top - pad - 8,
            left: Math.max(8, Math.min(spot.r.left - pad, window.innerWidth - 280)),
          }}>{spot.tip}</div>
        </>
      )}
      <section className={`tour-card${s.center ? ' center' : ''}`} role="dialog" aria-label={s.title} key={step}>
        {last && <Confetti />}
        <div className="tour-top">
          <span className="tour-kicker">{s.kicker}</span>
          <div className="tour-dots" aria-hidden="true">
            {STEPS.map((_, i) => <i key={i} className={i === step ? 'on' : i < step ? 'past' : ''} />)}
          </div>
        </div>
        <h3>{s.title}</h3>
        <div className="tour-body">{s.body(ctx)}</div>
        {status && (
          <div className={`tour-status${done ? ' ok' : ''}`} aria-live="polite">
            <span className="tour-pip" />
            <span className="grow">{status}</span>
          </div>
        )}
        <div className="tour-actions">
          {!last && <button className="ghost" onClick={() => go(null)}>Skip tour</button>}
          <span className="grow" />
          {step > 0 && !last && <button onClick={() => go(step - 1)}>Back</button>}
          <button className={`primary${done ? ' tour-pulse' : ''}`} onClick={() => go(step + 1)}>
            {(!done && s.skipNext) || s.next || (s.moves && !done ? 'Skip step' : 'Next')}
          </button>
        </div>
      </section>
    </>,
    document.body,
  );
}
