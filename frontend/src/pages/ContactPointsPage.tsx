// Contact points: who receives notifications and how. Secrets are write-only (CONTRACTS 13.2).
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Callout, EmptyState, ErrorState, Panel, Spinner } from '../components/Bits';
import {
  IconAlert, IconBell, IconCheck, IconHash, IconInfo, IconLink, IconMail, IconMonitor, IconPencil, IconPlus, IconSend,
  IconSpinner, IconTrash,
} from '../components/Icons';
import { Modal } from '../components/Modal';
import { SyncBadge } from './AlertRulesPage';
import { useAlertingVersion } from './AlertingPage';
import { api, errMessage } from '../lib/api';
import { refreshAlertingStatus, useAlertingStatus, useNotificationPermission } from '../lib/alerting';
import type { NotifPermission } from '../lib/alerting';
import { useNotify } from '../lib/notify';
import { receiverUsage } from '../lib/routing';
import { useAsync } from '../lib/useAsync';
import type { ContactPoint, ContactPointInput, ContactPointType } from '../lib/types';
import '../styles/alerting-routing.css';

type IconC = (p: { size?: number }) => ReactNode;
/** Label, icon and one-line blurb per integration; the policies page shares it. */
export const INTEGRATION: Record<ContactPointType, { label: string; Icon: IconC; blurb: string }> = {
  browser: { label: 'Browser', Icon: IconMonitor, blurb: 'In-app toast and OS notification' },
  webhook: { label: 'Webhook', Icon: IconLink, blurb: 'JSON payload to any HTTP endpoint' },
  email: { label: 'Email', Icon: IconMail, blurb: 'Through Grafana\'s SMTP settings' },
  slack: { label: 'Slack', Icon: IconHash, blurb: 'Incoming webhook or bot token' },
};

/** Tinted tile with the integration's icon; decorative, the label is always shown next to it. */
export function IntegrationIcon({ type, size = 16 }: { type: ContactPointType | undefined; size?: number }) {
  const m = type ? INTEGRATION[type] : undefined;
  const Icon = m?.Icon ?? IconAlert;
  const kind = type ?? 'missing';
  return <span className={`alr-int alr-int-${kind}${size < 16 ? ' alr-tile-sm' : ''}`} aria-hidden="true"><Icon size={size} /></span>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** One-line "where does it go", never revealing a secret. */
function targetOf(p: ContactPoint): string {
  const s = p.settings;
  switch (p.type) {
    case 'browser': return 'In-app toast + OS notification in open Aletheia tabs';
    case 'webhook': return `${str(s.http_method) || 'POST'} ${str(s.url)}`;
    case 'email': {
      const all = str(s.addresses).split(/[;,]/).map((a) => a.trim()).filter(Boolean);
      return all.length ? `${all.slice(0, 2).join(', ')}${all.length > 2 ? ` +${all.length - 2} more` : ''}` : 'no addresses';
    }
    case 'slack': {
      const ch = str(s.recipient);
      if (p.secure_fields.includes('token')) return `${ch || 'no channel'} via bot token ••••`;
      if (p.secure_fields.includes('url')) return `https://hooks.slack.com/services/••••${ch ? ` → ${ch}` : ''}`;
      return 'not configured';
    }
    default: return '';
  }
}

// ------------------------------------------------------------------ permission callout
type Tone = 'ok' | 'bad' | 'info' | 'plain';
const PERM: Record<NotifPermission, { tone: Tone; Icon: IconC; title: string; body: ReactNode }> = {
  granted: {
    tone: 'ok', Icon: IconCheck, title: 'Browser notifications are on',
    body: 'Firing alerts sent to a Browser contact point also pop up as OS notifications, even when this tab is in the background.',
  },
  denied: {
    tone: 'bad', Icon: IconAlert, title: 'Browser notifications are blocked',
    body: <>To fix: click the site icon left of the address bar, set <b>Notifications</b> to <b>Allow</b>, then reload. In-app toasts still work.</>,
  },
  default: {
    tone: 'info', Icon: IconBell, title: 'Get alerts while this tab is in the background',
    body: 'Allow OS notifications so Browser contact points can reach you outside this tab. In-app toasts work either way.',
  },
  unsupported: {
    tone: 'plain', Icon: IconInfo, title: 'OS notifications are not available here',
    body: 'This browser has no Notification API, or the page is not on a secure origin (https or localhost). In-app toasts still work.',
  },
};

function BrowserNotifications() {
  const { perm, request } = useNotificationPermission();
  const m = PERM[perm];
  return (
    <div className={`alr-perm alr-tone-${m.tone}`} role="status">
      <span className="alr-perm-icon" aria-hidden="true"><m.Icon size={16} /></span>
      <div className="alr-perm-text">
        <b>{m.title}</b>
        <span>{m.body}</span>
      </div>
      {perm === 'default' && (
        <button type="button" className="primary btn-sm" onClick={() => void request()}><IconBell size={13} />Enable</button>
      )}
      {perm === 'granted' && <Badge kind="ok"><IconCheck size={12} />Allowed</Badge>}
    </div>
  );
}

// ------------------------------------------------------------------ dialog
interface Draft {
  name: string; type: ContactPointType; disable_resolve_message: boolean;
  url: string; http_method: 'POST' | 'PUT';          // webhook
  addresses: string; single_email: boolean;          // email
  slackMode: 'url' | 'token'; slackUrl: string; token: string; recipient: string; clear: string[];  // slack
}

function draftOf(p: ContactPoint | null): Draft {
  const s = p?.settings ?? {};
  return {
    name: p?.name ?? '', type: p?.type ?? 'webhook', disable_resolve_message: p?.disable_resolve_message ?? false,
    url: p?.type === 'webhook' ? str(s.url) : '', http_method: str(s.http_method) === 'PUT' ? 'PUT' : 'POST',
    addresses: str(s.addresses), single_email: s.single_email === true,
    slackMode: p?.secure_fields.includes('token') ? 'token' : 'url', slackUrl: '', token: '', recipient: str(s.recipient), clear: [],
  };
}

/** A write-only field: shows "configured" when set, sends a value only when the user types one. */
function SecretField({ label, name, configured, value, cleared, onChange, onClear, placeholder, help }: {
  label: string; name: string; configured: boolean; value: string; cleared: boolean;
  onChange: (v: string) => void; onClear: () => void; placeholder: string; help?: string;
}) {
  const isSet = configured && !cleared;
  return (
    <label className="field"><span className="lbl">{label} {isSet && <Badge kind="ok">configured</Badge>}</span>
      <div className="row-tight row-nowrap">
        <input type="password" autoComplete="off" name={name} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={isSet ? 'Configured; leave blank to keep' : placeholder} />
        {isSet && !value && <button type="button" className="ghost" onClick={onClear}>Clear</button>}
      </div>
      {help && <span className="help">{help}</span>}
    </label>
  );
}

function PointDialog({ point, receiverUrl, onClose, onSaved }: {
  point: ContactPoint | null; receiverUrl?: string; onClose: () => void; onSaved: (p: ContactPoint) => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(point));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  // Stored secrets only mean something while the type is still the stored one.
  const secure = point && point.type === d.type ? point.secure_fields : [];
  const has = (k: string) => secure.includes(k) && !d.clear.includes(k);

  const build = (): { body: ContactPointInput } | { error: string } => {
    if (!d.name.trim()) return { error: 'Give the contact point a name.' };
    const settings: Record<string, unknown> = {};
    if (d.type === 'webhook') {
      if (!/^https?:\/\/\S+$/i.test(d.url.trim())) return { error: 'Webhook URL must start with http:// or https://.' };
      settings.url = d.url.trim(); settings.http_method = d.http_method;
    } else if (d.type === 'email') {
      const all = d.addresses.split(/[;,\s]+/).filter(Boolean);
      if (!all.length) return { error: 'Add at least one email address.' };
      const bad = all.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
      if (bad) return { error: `"${bad}" does not look like an email address.` };
      settings.addresses = all.join(';'); settings.single_email = d.single_email;
    } else if (d.type === 'slack') {
      // Secrets: omitted keeps the stored value, "" clears it (CONTRACTS 13.2).
      const secret = (k: 'url' | 'token', typed: string, active: boolean) => {
        if (active && typed.trim()) settings[k] = typed.trim();
        else if (secure.includes(k) && (!active || d.clear.includes(k))) settings[k] = '';
      };
      secret('url', d.slackUrl, d.slackMode === 'url');
      secret('token', d.token, d.slackMode === 'token');
      if (d.recipient.trim()) settings.recipient = d.recipient.trim();
      if (d.slackMode === 'url' && !d.slackUrl.trim() && !has('url')) return { error: 'Paste the Slack incoming-webhook URL.' };
      if (d.slackMode === 'token') {
        if (!d.token.trim() && !has('token')) return { error: 'Paste the Slack bot token (xoxb-…).' };
        if (!d.recipient.trim()) return { error: 'A bot token needs a channel, e.g. #alerts.' };
      }
    }
    return { body: { name: d.name.trim(), type: d.type, settings, disable_resolve_message: d.disable_resolve_message } };
  };

  const save = async () => {
    const b = build();
    if ('error' in b) { setErr(b.error); return; }
    setBusy(true); setErr(null);
    try { onSaved(point ? await api.updateContactPoint(point.id, b.body) : await api.createContactPoint(b.body)); }
    catch (e) { setErr(errMessage(e)); setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={point ? `Edit ${point.name}` : 'New contact point'}
      subtitle="Grafana receives it as a receiver of the same name."
      footer={<>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : point ? 'Save' : 'Create'}</button>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span className="lbl">Name</span>
          <input autoFocus={!point} value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="SecOps Slack" /></label>
        <div className="field"><span className="lbl" id="cp-type-lbl">Integration</span>
          <div className="alr-typepick" role="group" aria-labelledby="cp-type-lbl">
            {(Object.keys(INTEGRATION) as ContactPointType[]).map((t) => (
              <button key={t} type="button" aria-pressed={d.type === t} className={`alr-typecard${d.type === t ? ' on' : ''}`}
                disabled={point?.builtin && t !== d.type} onClick={() => set('type', t)}>
                <IntegrationIcon type={t} />
                <span className="alr-typecard-text"><b>{INTEGRATION[t].label}</b><span>{INTEGRATION[t].blurb}</span></span>
              </button>
            ))}
          </div>
          {point?.builtin && <span className="help">The built-in Browser contact point keeps its type.</span>}</div>

        {d.type === 'browser' && (
          <Callout kind="info" icon={<IconBell size={15} />}>
            Grafana sends alerts to Studio{receiverUrl ? <> at <code>{receiverUrl}</code></> : ''}, and every open Aletheia tab shows
            them as an in-app toast, plus an OS notification once you allow browser notifications. Nothing else to configure.
          </Callout>
        )}

        {d.type === 'webhook' && (
          <div className="al-cond">
            <label className="field al-grow"><span className="lbl">URL</span>
              <input type="url" value={d.url} onChange={(e) => set('url', e.target.value)} placeholder="https://hooks.example.com/alerts" /></label>
            <label className="field"><span className="lbl">Method</span>
              <select value={d.http_method} onChange={(e) => set('http_method', e.target.value as 'POST' | 'PUT')}>
                <option>POST</option><option>PUT</option></select></label>
          </div>
        )}

        {d.type === 'email' && (
          <>
            <label className="field"><span className="lbl">Addresses</span>
              <textarea rows={2} value={d.addresses} onChange={(e) => set('addresses', e.target.value)} placeholder="soc@example.com; oncall@example.com" />
              <span className="help">Separate with ; or ,. Grafana needs SMTP configured to deliver email.</span></label>
            <label className="checkbox-label">
              <input type="checkbox" checked={d.single_email} onChange={(e) => set('single_email', e.target.checked)} />
              Send one email to all addresses instead of one each
            </label>
          </>
        )}

        {d.type === 'slack' && (
          <>
            <div className="radio-group" role="group" aria-label="Slack connection">
              {([['url', 'Incoming webhook'], ['token', 'Bot token + channel']] as const).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={d.slackMode === k} className={`radio-pill${d.slackMode === k ? ' checked' : ''}`}
                  onClick={() => set('slackMode', k)}>{label}</button>
              ))}
            </div>
            {d.slackMode === 'url' ? (
              <SecretField label="Webhook URL" name="slack-url" configured={secure.includes('url')} value={d.slackUrl}
                cleared={d.clear.includes('url')} onChange={(v) => set('slackUrl', v)} onClear={() => set('clear', [...d.clear, 'url'])}
                placeholder="https://hooks.slack.com/services/…" />
            ) : (
              <SecretField label="Bot token" name="slack-token" configured={secure.includes('token')} value={d.token}
                cleared={d.clear.includes('token')} onChange={(v) => set('token', v)} onClear={() => set('clear', [...d.clear, 'token'])}
                placeholder="xoxb-…" help="Needs the chat:write scope." />
            )}
            <label className="field"><span className="lbl">Channel {d.slackMode === 'url' && <span className="faint">(optional override)</span>}</span>
              <input value={d.recipient} onChange={(e) => set('recipient', e.target.value)} placeholder="#alerts" /></label>
            {point?.type === 'slack' && secure.length > 0 && !secure.includes(d.slackMode) && (
              <p className="hint">Saving switches the connection method and clears the stored {d.slackMode === 'url' ? 'bot token' : 'webhook URL'}.</p>
            )}
          </>
        )}

        <label className="checkbox-label">
          <input type="checkbox" checked={d.disable_resolve_message} onChange={(e) => set('disable_resolve_message', e.target.checked)} />
          Don't send a message when an alert resolves
        </label>
        {err && <p className="hint err" role="alert">{err}</p>}
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ page
function Usage({ n, failed }: { n: number | undefined; failed: boolean }) {
  if (failed) return null;
  if (n === undefined) return <span className="alr-usage none">…</span>;
  if (n === 0) return <span className="alr-usage none" title="No notification policy sends to this contact point">Not used</span>;
  return (
    <Link className="alr-usage" to="/dashboard/alerting/policies" title="Open notification policies">
      Used by {n} {n === 1 ? 'policy' : 'policies'}
    </Link>
  );
}

function PointRow({ p, used, usageFailed, testing, onTest, onEdit, onDelete }: {
  p: ContactPoint; used: number | undefined; usageFailed: boolean; testing: boolean; onTest: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const why = p.builtin ? 'The built-in Browser contact point cannot be deleted'
    : used ? `Used by ${used} notification ${used === 1 ? 'policy' : 'policies'}; re-route ${used === 1 ? 'it' : 'them'} first` : undefined;
  const target = targetOf(p);
  const mono = p.type !== 'browser';
  return (
    <li className="alr-cp">
      <IntegrationIcon type={p.type} size={18} />
      <div className="alr-cp-main">
        <div className="alr-cp-name">
          <button type="button" className="alr-namebtn" onClick={onEdit} title={`Edit ${p.name}`}>{p.name}</button>
          {p.builtin && <Badge kind="info" title="Created by Aletheia; cannot be deleted">built-in</Badge>}
          {p.disable_resolve_message && <span className="alr-tag" title="Resolved alerts are not announced">no resolve messages</span>}
        </div>
        <div className="alr-cp-target">
          <span className="alr-cp-kind">{INTEGRATION[p.type]?.label ?? p.type}</span>
          <span className={mono ? 'alr-cp-dest mono' : 'alr-cp-dest'} title={target}>{target}</span>
        </div>
      </div>
      <div className="alr-cp-meta">
        <span className="alr-cp-use"><Usage n={used} failed={usageFailed} /></span>
        <span className="alr-cp-sync"><SyncBadge sync={p.sync} /></span>
      </div>
      <div className="alr-actions">
        <button type="button" className="ghost icon" disabled={testing} onClick={onTest}
          aria-label={`Send a test notification to ${p.name}`} title="Send a test notification">
          {testing ? <IconSpinner size={15} /> : <IconSend size={15} />}
        </button>
        <button type="button" className="ghost icon" onClick={onEdit} aria-label={`Edit ${p.name}`} title="Edit"><IconPencil size={15} /></button>
        {/* A disabled button swallows hover, so the reason lives on a wrapper too. */}
        <span className="alr-tipwrap" title={why}>
          <button type="button" className="ghost icon alr-danger" disabled={!!why} onClick={onDelete}
            aria-label={why ? `Delete ${p.name} (unavailable: ${why})` : `Delete ${p.name}`} title={why ?? 'Delete'}>
            <IconTrash size={15} />
          </button>
        </span>
      </div>
    </li>
  );
}

export function ContactPointsPage() {
  const version = useAlertingVersion();
  const list = useAsync(() => api.listContactPoints(), [version]);
  const pol = useAsync(() => api.getPolicies(), [version]);
  const { status } = useAlertingStatus();
  const { toast } = useNotify();
  const [editing, setEditing] = useState<ContactPoint | 'new' | null>(null);
  const [removing, setRemoving] = useState<ContactPoint | null>(null);
  const [rmErr, setRmErr] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const points = list.data?.contact_points ?? [];
  const usage = pol.data ? receiverUsage(pol.data.policy) : null;

  const changed = () => { list.reload(); pol.reload(); void refreshAlertingStatus(); };

  const test = async (p: ContactPoint) => {
    setTesting(p.id);
    try {
      const r = await api.testContactPoint(p.id);
      toast({ kind: r.ok ? 'ok' : 'bad', title: r.ok ? `Test sent to ${p.name}` : `Test to ${p.name} failed`, body: r.detail });
    } catch (e) { toast({ kind: 'bad', title: `Test to ${p.name} failed`, body: errMessage(e) }); }
    finally { setTesting(null); }
  };

  const remove = async () => {
    if (!removing) return;
    setRmErr(null);
    try {
      await api.deleteContactPoint(removing.id);
      toast({ title: `${removing.name} deleted` });
      setRemoving(null); changed();
    } catch (e) { setRmErr(errMessage(e)); }
  };

  return (
    <>
      <BrowserNotifications />
      <Panel flush title="Contact points" subtitle={list.data ? `${points.length} configured` : undefined}
        right={<button type="button" className="primary btn-sm" onClick={() => setEditing('new')}><IconPlus size={13} />New contact point</button>}>
        {list.error && <div className="panel-pad"><ErrorState error={list.error} what="contact points" /></div>}
        {list.loading && !list.data && <div className="panel-pad"><Spinner label="Loading contact points" /></div>}
        {list.data && points.length === 0 && (
          <EmptyState title="No contact points" action={<button type="button" className="primary" onClick={() => setEditing('new')}>Add one</button>}>
            The built-in Browser contact point is created when the alerting store starts empty.
          </EmptyState>
        )}
        {points.length > 0 && (
          <ul className="alr-cp-list" aria-label="Contact points">
            {points.map((p) => (
              <PointRow key={p.id} p={p} used={usage ? usage.get(p.id) ?? 0 : undefined} usageFailed={!!pol.error} testing={testing === p.id}
                onTest={() => void test(p)} onEdit={() => setEditing(p)} onDelete={() => { setRmErr(null); setRemoving(p); }} />
            ))}
          </ul>
        )}
      </Panel>

      {editing && (
        <PointDialog key={editing === 'new' ? 'new' : editing.id} point={editing === 'new' ? null : editing} receiverUrl={status?.receiver_url}
          onClose={() => setEditing(null)}
          onSaved={(p) => { toast({ kind: 'ok', title: editing === 'new' ? `${p.name} created` : `${p.name} saved` }); setEditing(null); changed(); }} />
      )}
      {removing && (
        <Modal title={`Delete ${removing.name}?`} onClose={() => setRemoving(null)}
          footer={<><button type="button" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="danger" onClick={() => void remove()}>Delete</button></>}>
          <p>Notifications routed here stop. A contact point still used by a notification policy cannot be deleted; re-route it first.</p>
          {rmErr && <Callout kind="bad">{rmErr}</Callout>}
        </Modal>
      )}
    </>
  );
}
