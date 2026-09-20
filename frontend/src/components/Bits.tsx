import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  IconAlert, IconCaret, IconCheck, IconCopy, IconInbox, IconShield, IconShieldAlert,
  IconSpinner, IconTerminal,
} from './Icons';
import type { ParseStatus } from '../lib/types';

/* ---------------------------------------------------------------- surfaces */

export function Panel(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  // An empty array is truthy, so a page that maps an empty list into `right` would otherwise
  // open a header slot with nothing in it.
  const right = Array.isArray(props.right) && props.right.length === 0 ? undefined : props.right;
  const hasHeader = props.title !== undefined || right !== undefined;
  return (
    <section className={`panel ${props.className ?? ''}`}>
      {hasHeader && (
        <header>
          <div className="panel-title">
            {props.title}
            {props.subtitle && <span className="panel-sub">{props.subtitle}</span>}
          </div>
          {right && <div className="panel-right">{right}</div>}
        </header>
      )}
      <div className={`panel-body${props.flush ? ' flush' : ''}`}>{props.children}</div>
    </section>
  );
}

/** Every page opens the same way: title, one line of purpose, optional action on the right. */
export function PageHead({ title, children, right }: { title: string; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="page-head-row">
      <div className="page-head">
        <h1>{title}</h1>
        {children && <p className="sub">{children}</p>}
      </div>
      {right && <div className="page-head-actions">{right}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- badges */

export type BadgeKind = 'ok' | 'warn' | 'bad' | 'info' | 'plain';

export function Badge({ kind = 'plain', title, mono, children }: {
  kind?: BadgeKind; title?: string; mono?: boolean; children: ReactNode;
}) {
  const cls = kind === 'plain' ? '' : kind;
  return <span className={`badge ${cls}${mono ? ' mono' : ''}`} title={title}>{children}</span>;
}

const STATUS_HELP: Record<ParseStatus, string> = {
  full: 'Every slot matched a template and mapped to OCSF.',
  partial: 'The line matched, but some fields stayed unmapped.',
  raw_only: 'No template matched. Stored verbatim — nothing was dropped.',
};

/** CONTRACTS section 5 enum, one colour per value everywhere in the product. */
export function ParseStatusBadge({ status }: { status: ParseStatus }) {
  return (
    <span className={`status-pill status-${status}`} title={STATUS_HELP[status]}>
      <span className="dot" />
      {status}
    </span>
  );
}

/** Losslessness proof: the hash taken at ingest, and whether reconstruction still matches it. */
export type Recheck = 'pending' | 'match' | 'mismatch' | 'unavailable';

const RECHECK_TEXT: Record<Recheck, string> = {
  pending: 're-hashing in your browser…',
  match: 're-hashed here: the bytes match raw_sha256',
  mismatch: 're-hashed here: the bytes do NOT match raw_sha256',
  unavailable: 'browser re-check needs a secure origin',
};

export function VerifiedSeal({ verified, sha256, recheck }: {
  verified: boolean; sha256: string; recheck?: Recheck;
}) {
  // A mismatch means the reconstruction is not byte-identical, whatever the server claims.
  const bad = !verified || recheck === 'mismatch';
  return (
    <div className={`proof${bad ? ' bad' : ''}`}>
      <span className="seal">{bad ? <IconShieldAlert size={24} /> : <IconShield size={24} />}</span>
      <div className="proof-text">
        <div className="proof-title">
          {recheck === 'mismatch' ? 'Reconstruction does not match'
            : verified ? 'Verified lossless' : 'Verification failed'}
        </div>
        <div className="hash">
          <span className="faint">raw_sha256</span>
          <span className="full" title={sha256}>{sha256 || 'n/a'}</span>
          <CopyButton text={sha256} label="Copy hash" />
        </div>
        {recheck && (
          <div className={`recheck ${recheck}`}>{RECHECK_TEXT[recheck]}</div>
        )}
      </div>
    </div>
  );
}

export function Confidence({ value }: { value: number }) {
  const cls = value >= 0.85 ? '' : value >= 0.65 ? 'low' : 'vlow';
  return (
    <span className="row-tight row-nowrap" title={`confidence ${value.toFixed(2)}`}>
      <span className={`meter ${cls}`}><i style={{ width: `${Math.round(value * 100)}%` }} /></span>
      <span className="conf-val mono">{value.toFixed(2)}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- actions */

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ghost icon"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** The equivalent CLI command. Available, but never the headline. */
export function CliDisclosure({ cmd, label = 'Show equivalent command' }: { cmd: string; label?: string }) {
  return (
    <details className="disclosure">
      <summary>
        <IconCaret size={12} className="caret" />
        <IconTerminal size={13} />
        {label}
      </summary>
      <Cli cmd={cmd} />
    </details>
  );
}

export function Cli({ cmd }: { cmd: string }) {
  return (
    <div className="cli">
      <span className="prompt">$</span>
      <span className="cmd">{cmd}</span>
      <CopyButton text={cmd} label="Copy command" />
    </div>
  );
}

/* ---------------------------------------------------------------- states */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner row-tight row-nowrap muted">
      <IconSpinner size={14} />
      {label}
    </span>
  );
}

/** Table-shaped loading skeleton: same rhythm as the real rows, so nothing jumps. */
export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="skel-rows" aria-busy="true" aria-label="loading">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skel-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <span
              key={c}
              className="skel"
              style={{ flex: c === cols - 1 ? 2 : 1, opacity: 1 - r * 0.07 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function BlockSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="skel-rows" aria-busy="true" aria-label="loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skel" style={{ width: `${100 - i * 11}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: {
  title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="icon">{icon ?? <IconInbox size={22} />}</span>
      <div className="title">{title}</div>
      {children && <div className="body">{children}</div>}
      {action}
    </div>
  );
}

/** Errors always say what to do next, not just what broke. */
export function ErrorState({ error, what, fix }: { error: string; what?: string; fix?: ReactNode }) {
  const proxyish = /not JSON|Failed to fetch|NetworkError|ECONNREFUSED/i.test(error);
  return (
    <div className="error-state" role="alert">
      <IconAlert size={18} />
      <div className="grow">
        <div className="title">{what ? `Could not load ${what}` : 'Something went wrong'}</div>
        <div className="detail">{error}</div>
        <div className="fix">
          {fix ?? (proxyish
            ? 'The server looks unreachable. Make sure it is running, then retry.'
            : 'Retry. If it keeps failing, check the server logs.')}
        </div>
      </div>
    </div>
  );
}

export function Callout({ kind = 'info', icon, children }: {
  kind?: 'info' | 'ok' | 'warn' | 'bad'; icon?: ReactNode; children: ReactNode;
}) {
  return (
    <div className={`callout ${kind}`}>
      {icon ?? <IconAlert size={15} />}
      <div className="grow">{children}</div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className={`v ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

export function MetaItem({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="meta-item" title={title}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}
