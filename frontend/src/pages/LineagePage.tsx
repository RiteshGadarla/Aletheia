// The signature feature: a normalized OCSF event beside its reconstructed raw line, with
// byte-level cross-highlighting in both directions (spec 6.14, 8.4).
import { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge, BlockSkeleton, Callout, EmptyState, ErrorState, MetaItem, PageHead, Panel,
  ParseStatusBadge, Spinner, VerifiedSeal,
} from '../components/Bits';
import type { Recheck } from '../components/Bits';
import { IconCheck, IconCopy, IconInbox, IconLineage, IconSearch, IconSources } from '../components/Icons';
import { OcsfTree } from '../components/OcsfTree';
import { Pagination } from '../components/Pagination';
import { RawLine } from '../components/RawLine';
import { api } from '../lib/api';
import { GrafanaEventLink } from '../lib/alerting';
import { byteLen, sha256Hex } from '../lib/lineage';
import { useAsync } from '../lib/useAsync';

export function LineagePage() {
  const { eventUid } = useParams<{ eventUid?: string }>();
  const navigate = useNavigate();
  const [active, setActive] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<Recheck | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  // A different event has different slots, so a highlight carried over from the last one is
  // pointing at bytes that are no longer there.
  useEffect(() => { setActive(null); }, [eventUid]);

  useEffect(() => { setOffset(0); }, [search]);

  // Only fetch the picker list when no event is selected yet.
  const picker = useAsync(
    () => (eventUid ? Promise.resolve(null) : api.listEvents({ limit, offset, q: search.trim() || undefined })),
    [eventUid, limit, offset, search],
  );

  const lineage = useAsync(
    () => (eventUid ? api.getLineage(eventUid) : Promise.reject(new Error('no event selected'))),
    [eventUid],
  );

  const raw = lineage.data?.raw;
  const expected = lineage.data?.raw_sha256;
  useEffect(() => {
    if (raw === undefined || !expected) { setRecheck(undefined); return; }
    let live = true;
    setRecheck('pending');
    void sha256Hex(raw).then((got) => {
      if (!live) return;
      setRecheck(got === null ? 'unavailable' : got === expected.toUpperCase() ? 'match' : 'mismatch');
    });
    return () => { live = false; };
  }, [raw, expected]);

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const filteredEvents = useMemo(() => {
    if (!picker.data?.events) return [];
    if (!search.trim()) return picker.data.events;
    const q = search.toLowerCase().trim();
    return picker.data.events.filter((ev, i) => {
      const uid = (ev.aletheia?.event_uid || ev.metadata?.uid || `event-${i}`).toLowerCase();
      const src = (ev.aletheia?.source_id || ev.metadata?.log_name || '').toLowerCase();
      const tpl = String(ev.aletheia?.template_id || '').toLowerCase();
      return uid.includes(q) || src.includes(q) || tpl.includes(q);
    });
  }, [picker.data, search]);

  if (!eventUid) {
    return (
      <div className="stack">
        <PageHead title="Lineage Viewer">
          Inspect normalized OCSF fields and reconstructed raw lines with byte-level provenance.
        </PageHead>

        <Panel
          title="Select an Event to Inspect"
          right={
            <div className="row-tight" style={{ gap: 'var(--s3)' }}>
              <div className="lineage-search-box">
                <IconSearch size={14} />
                <input
                  type="text"
                  placeholder="Search UID, source..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button type="button" className="ghost icon-sm" onClick={() => setSearch('')}>×</button>
                )}
              </div>
              {picker.data && <Badge kind="info">{filteredEvents.length} events</Badge>}
            </div>
          }
          flush
        >
          {picker.loading && <div className="panel-pad"><Spinner label="Loading events" /></div>}
          {picker.error && <div className="panel-pad"><ErrorState error={picker.error} what="events" /></div>}
          {picker.data?.events.length === 0 && (
            <EmptyState title="No events yet" icon={<IconInbox size={22} />}
              action={<Link className="btn-link" to="/dashboard/sources">Open Sources</Link>}>
              Connect a source and approve its mapping. Its events show up here.
            </EmptyState>
          )}

          {picker.data && picker.data.events.length > 0 && filteredEvents.length === 0 && (
            <div className="panel-pad">
              <p className="hint">No events match "{search}". Try searching for another keyword or clear search.</p>
            </div>
          )}

          {filteredEvents.length > 0 && (
            <div className="pick-table-wrap">
              <table className="pick-table">
                <thead>
                  <tr>
                    <th>Event UID</th>
                    <th>Source ID</th>
                    <th>Template</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((ev, i) => {
                    const uid = ev.aletheia?.event_uid || ev.metadata?.uid || `event-${i}`;
                    const src = ev.aletheia?.source_id || ev.metadata?.log_name || 'unknown';
                    const tpl = ev.aletheia?.template_id;
                    return (
                      <tr
                        key={`${uid}:${i}`}
                        className="pick-row"
                        onClick={() => navigate(`/dashboard/lineage/${uid}`)}
                      >
                        <td>
                          <span className="mono bold">{uid}</span>
                        </td>
                        <td>
                          <span className="source-pill">
                            <IconSources size={13} />
                            {src}
                          </span>
                        </td>
                        <td>
                          <Badge kind="plain">Template {tpl || 'none'}</Badge>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="primary btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/dashboard/lineage/${uid}`);
                            }}
                          >
                            Inspect →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {picker.data && (
            <Pagination
              offset={offset}
              limit={limit}
              total={picker.data.total}
              onOffset={(next) => setOffset(next)}
              onLimit={setLimit}
              noun="events"
              busy={picker.loading}
            />
          )}
        </Panel>
      </div>
    );
  }

  const d = lineage.data;
  const span = active && d ? d.spans[active] : undefined;
  const mappedPath = active && d?.field_map ? Object.entries(d.field_map).find(([, slot]) => slot === active)?.[0] : null;

  return (
    <div className="stack">
      <PageHead
        title="Lineage Viewer"
        right={
          <div className="row-tight" style={{ gap: 'var(--s3)' }}>
            {eventUid && <GrafanaEventLink eventUid={eventUid} event={d?.event?.aletheia} label="Open in Grafana" />}
            {d && (
              <button
                type="button"
                className="ghost"
                onClick={() => copyText(d.event_uid)}
                title="Copy Event UID"
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                <span>{copied ? 'Copied' : 'Copy UID'}</span>
              </button>
            )}
            <Link className="button" to="/dashboard/lineage">
              ← Choose another event
            </Link>
          </div>
        }
      >
        Click any OCSF field to highlight the exact bytes it came from — or click a raw byte segment to find its normalized field.
      </PageHead>

      {lineage.loading && <BlockSkeleton lines={6} />}
      {lineage.error && <ErrorState error={lineage.error} what="this event's lineage" />}

      {d && (
        <>
          <Panel
            title="Provenance Metadata"
            right={<VerifiedSeal verified={d.verified} sha256={d.raw_sha256} recheck={recheck} />}
          >
            <div className="meta-list">
              <MetaItem label="Event UID" value={<span className="mono bold">{d.event_uid}</span>} />
              <MetaItem label="Parse Status" value={<ParseStatusBadge status={d.parse_status} />} />
              <MetaItem label="Storage Mode" value={<Badge kind="ok">{d.storage_mode}</Badge>} />
              <MetaItem label="Template ID" value={<Badge kind="plain">Template {d.template_id || 'none'}</Badge>} />
              <MetaItem
                label="Parser Pack"
                value={<Badge kind="info">{d.pack ? `${d.pack} v${d.pack_version}` : `v${d.pack_version}`}</Badge>}
              />
              <MetaItem label="Merkle Batch" value={<span className="mono hint">{d.merkle_batch || 'n/a'}</span>} />
            </div>
          </Panel>

          {/* Interactive Inspection Bar */}
          <div className={`lineage-inspect-bar ${active ? 'active' : ''}`}>
            {active && span ? (
              <div className="lib-content">
                <span className="lib-badge">Active Slot: <b>{active}</b></span>
                <span className="lib-detail">Bytes <b>[{span[0]}, {span[1]})</b> of {byteLen(d.raw)}</span>
                {mappedPath ? (
                  <span className="lib-path">Mapped OCSF Path: <code>{mappedPath}</code></span>
                ) : (
                  <span className="lib-path hint">Unmapped raw slot (preserved in raw store)</span>
                )}
                <button type="button" className="ghost icon-sm lib-close" onClick={() => setActive(null)} title="Clear highlight">×</button>
              </div>
            ) : (
              <div className="lib-hint">
                <IconLineage size={15} />
                <span>Hover or click any field or raw byte segment to link provenance byte-for-byte.</span>
              </div>
            )}
          </div>

          <div className="lineage-grid">
            <Panel
              title="Reconstructed Raw Line"
              right={
                <div className="row-tight" style={{ gap: 'var(--s2)' }}>
                  <Badge kind="plain" mono>{byteLen(d.raw)} bytes</Badge>
                  <button
                    type="button"
                    className="ghost icon-sm"
                    onClick={() => copyText(d.raw)}
                    title="Copy Raw Line"
                  >
                    <IconCopy size={14} />
                  </button>
                </div>
              }
            >
              {/* Token Legend */}
              <div className="slot-legend">
                <span className="sl-item"><i className="slot-ip-dot" /> IP</span>
                <span className="sl-item"><i className="slot-ts-dot" /> Timestamp</span>
                <span className="sl-item"><i className="slot-num-dot" /> Number</span>
                <span className="sl-item"><i className="slot-host-dot" /> Host</span>
                <span className="sl-item"><i className="slot-enum-dot" /> Enum</span>
                <span className="sl-item"><i className="slot-text-dot" /> Text</span>
              </div>

              <RawLine
                raw={d.raw}
                spans={d.spans}
                tokens={d.tokens}
                active={active}
                onActive={setActive}
                onPick={setActive}
              />
            </Panel>

            <Panel
              title="Normalized OCSF Event"
              right={
                <div className="row-tight" style={{ gap: 'var(--s2)' }}>
                  <Badge kind="plain">{d.vars.length} variables</Badge>
                  <button
                    type="button"
                    className="ghost icon-sm"
                    onClick={() => copyText(JSON.stringify(d.event, null, 2))}
                    title="Copy OCSF Event JSON"
                  >
                    <IconCopy size={14} />
                  </button>
                </div>
              }
            >
              {Object.keys(d.field_map).length === 0 && (
                <Callout kind="warn">
                  The API returned an empty <code>field_map</code> for this event, so OCSF fields
                  cannot be traced back to a slot yet. Highlighting still works from the raw line.
                </Callout>
              )}
              <OcsfTree
                value={d.event}
                fieldMap={d.field_map}
                active={active}
                onActive={setActive}
                onPick={setActive}
              />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

