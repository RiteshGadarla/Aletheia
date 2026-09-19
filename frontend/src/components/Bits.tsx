import type { ReactNode } from 'react';
import type { ParseStatus } from '../lib/types';

export function Panel(props: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      {(props.title || props.right) && (
        <header>
          <span>{props.title}</span>
          {props.right && <span className="spacer">{props.right}</span>}
        </header>
      )}
      <div className="body">{props.children}</div>
    </section>
  );
}

export function Badge(props: { kind?: 'ok' | 'warn' | 'bad' | 'info' | 'plain'; title?: string; children: ReactNode }) {
  return <span className={`badge ${props.kind ?? ''}`} title={props.title}>{props.children}</span>;
}

export function ParseStatusBadge({ status }: { status: ParseStatus }) {
  const kind = status === 'full' ? 'ok' : status === 'partial' ? 'warn' : 'bad';
  return <Badge kind={kind} title="CONTRACTS section 5: full | partial | raw_only">{status}</Badge>;
}

/** Losslessness proof: hash of the raw bytes plus whether reconstruction matched it. */
export function VerifiedBadge({ verified, sha256 }: { verified: boolean; sha256: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <Badge kind={verified ? 'ok' : 'bad'} title="Reconstruction hashed and compared with the hash taken at ingest">
        {verified ? 'verified' : 'NOT VERIFIED'}
      </Badge>
      <Badge kind="plain" title={`raw_sha256 = ${sha256}`}>
        raw_sha256 {sha256 ? `${sha256.slice(0, 12)}...${sha256.slice(-4)}` : 'n/a'}
      </Badge>
    </span>
  );
}

export function Confidence({ value }: { value: number }) {
  const cls = value >= 0.85 ? '' : value >= 0.65 ? 'low' : 'vlow';
  return (
    <span className="row" style={{ gap: 6 }} title={`confidence ${value.toFixed(2)}`}>
      <span className={`meter ${cls}`}><i style={{ width: `${Math.round(value * 100)}%` }} /></span>
      <span className="mono" style={{ fontSize: 11 }}>{value.toFixed(2)}</span>
    </span>
  );
}

/** The equivalent CLI command, always shown in the open (spec 21.1). */
export function Cli({ cmd }: { cmd: string }) {
  return (
    <div className="cli">
      <span className="prompt">$</span>
      <span className="cmd">{cmd}</span>
      <button
        type="button"
        className="ghost"
        title="Copy command"
        onClick={() => { void navigator.clipboard?.writeText(cmd); }}
      >
        copy
      </button>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="spinner">loading {what}...</div>;
}

export function ErrorBox({ error }: { error: string }) {
  return <pre className="out bad">{error}</pre>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
