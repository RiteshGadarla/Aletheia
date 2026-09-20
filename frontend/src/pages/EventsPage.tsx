// Events explorer: every source lands in one OCSF table. Pagination is server-side —
// `limit`/`offset` go to the API and `total` comes back from it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, EmptyState, ErrorState, PageHead, Panel, ParseStatusBadge, TableSkeleton,
} from '../components/Bits';
import { IconInbox, IconSearch } from '../components/Icons';
import { Pagination } from '../components/Pagination';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { Endpoint, EventQuery, NormalizedEvent, ParseStatus } from '../lib/types';

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
};

const fmtEndpoint = (e?: Endpoint): string => {
  if (!e) return '—';
  const host = e.ip ?? e.hostname ?? e.interface_name;
  if (!host) return '—';
  // The API sends `port: null` for protocols that have none, and `!== undefined` let that
  // through as the literal text ":null".
  return e.port != null ? `${host}:${e.port}` : host;
};

/** One human-readable summary column, whichever field this OCSF class populated. */
const summaryOf = (ev: NormalizedEvent): string => {
  const finding = ev.finding_info as { title?: string } | undefined;
  return ev.message
    ?? finding?.title
    ?? ev.http_request?.url?.text
    ?? ev.actor?.user?.name
    ?? ev.user?.name
    ?? '';
};

const SEVERITY: Record<number, { label: string; tone: 'ok' | 'warn' | 'bad' | 'plain' }> = {
  1: { label: 'Informational', tone: 'plain' },
  2: { label: 'Low', tone: 'plain' },
  3: { label: 'Medium', tone: 'warn' },
  4: { label: 'High', tone: 'warn' },
  5: { label: 'Critical', tone: 'bad' },
  6: { label: 'Fatal', tone: 'bad' },
};

export function EventsPage() {
  const navigate = useNavigate();
  const [sourceId, setSourceId] = useState('');
  const [classUid, setClassUid] = useState('');
  const [parseStatus, setParseStatus] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  // Any filter change invalidates the current page position.
  useEffect(() => { setOffset(0); }, [sourceId, classUid, parseStatus, debouncedQ]);

  const query = useMemo<EventQuery>(() => ({
    source_id: sourceId || undefined,
    class_uid: classUid ? Number(classUid) : undefined,
    parse_status: (parseStatus || undefined) as ParseStatus | undefined,
    q: debouncedQ || undefined,
    limit,
    offset,
  }), [sourceId, classUid, parseStatus, debouncedQ, limit, offset]);

  const { data, loading, error } = useAsync(() => api.listEvents(query), [JSON.stringify(query)]);

  // Keep filter dropdowns populated while a later request is in flight.
  const facetsRef = useRef<{ sources: string[]; classes: { class_uid: number; name: string }[] }>({
    sources: [], classes: [],
  });
  if (data) facetsRef.current = { sources: data.sources, classes: data.classes };
  const facets = facetsRef.current;

  const className = (uid: number) =>
    facets.classes.find((c) => c.class_uid === uid)?.name ?? String(uid);

  const filtered = !!(sourceId || classUid || parseStatus || debouncedQ);
  const total = data?.total ?? 0;

  useEffect(() => {
    if (data && data.events.length === 0 && data.total > 0 && offset > 0) setOffset(0);
  }, [data, offset]);

  const goPage = (next: number) => {
    setOffset(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const clearAll = () => { setSourceId(''); setClassUid(''); setParseStatus(''); setQ(''); };

  // One line of scope, so the page does not need a row of stat boxes above the table.
  const summary = data
    ? `${total.toLocaleString()}${filtered ? ' matching' : ''} events · ${facets.sources.length} sources`
      + ` · ${facets.classes.length} OCSF classes`
    : error ? 'unavailable' : 'loading…';

  return (
    <div className="stack">
      <PageHead title="Events">
        Every source normalises to the same OCSF columns. Filter, then open any row to see the exact
        bytes each field came from.
      </PageHead>

      {/* One panel holds filters, table and pager, so the page is a single box, not three. */}
      <Panel
        flush
        title="Event stream"
        subtitle={loading ? 'refreshing…' : summary}
        right={filtered && <button type="button" className="ghost" onClick={clearAll}>Clear filters</button>}
      >
        <div className="panel-pad">
          <div className="filter-bar">
            <label className="field">
              <span className="lbl">Source</span>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">All sources</option>
                {facets.sources.map((s2) => <option key={s2} value={s2}>{s2}</option>)}
              </select>
            </label>

            <label className="field">
              <span className="lbl">OCSF class</span>
              <select value={classUid} onChange={(e) => setClassUid(e.target.value)}>
                <option value="">All classes</option>
                {facets.classes.map((c) => (
                  <option key={c.class_uid} value={c.class_uid}>{c.name} · {c.class_uid}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="lbl">Parse status</span>
              <select value={parseStatus} onChange={(e) => setParseStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="full">full</option>
                <option value="partial">partial</option>
                <option value="raw_only">raw_only</option>
              </select>
            </label>

            <label className="field search">
              <span className="lbl"><IconSearch size={12} /> Search</span>
              <input
                placeholder="substring across the event JSON — IP, user, message…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
          </div>
        </div>

        {error && <div className="panel-pad"><ErrorState error={error} what="events" /></div>}

        {!error && loading && !data && <TableSkeleton rows={9} cols={9} />}

        {!error && data && data.events.length === 0 && (
          <EmptyState
            title={filtered ? 'No events match these filters' : 'No events yet'}
            icon={<IconInbox size={22} />}
            action={filtered ? <button type="button" onClick={clearAll}>Clear filters</button> : undefined}
          >
            {filtered
              ? 'Try widening the source, class or parse-status filter, or clearing the search text.'
              : 'Nothing has been ingested yet. Open the Demo console and run “Start traffic” to stream the seeded sources in.'}
          </EmptyState>
        )}

        {!error && data && data.events.length > 0 && (
          <>
            <div className="table-scroll" ref={scrollRef}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Time (UTC)</th>
                    <th>Source</th>
                    <th>Class</th>
                    <th>Status</th>
                    <th>Severity</th>
                    <th>Source endpoint</th>
                    <th>Destination</th>
                    <th>Summary</th>
                    <th>Template</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((ev, i) => {
                    const sev = SEVERITY[ev.severity_id];
                    return (
                      <tr
                        // The API can repeat a row at deep offsets, so the uid alone is not
                        // unique within a page and React drops the duplicates.
                        key={`${ev.aletheia.event_uid}:${i}`}
                        className="clickable"
                        onClick={() => navigate(`/dashboard/lineage/${ev.aletheia.event_uid}`)}
                        title="Open byte lineage for this event"
                      >
                        <td className="mono nowrap">{fmtTime(ev.time)}</td>
                        <td className="nowrap">{ev.aletheia.source_id}</td>
                        <td className="nowrap">{className(ev.class_uid)}</td>
                        <td><ParseStatusBadge status={ev.aletheia.parse_status} /></td>
                        <td className="nowrap">
                          {sev
                            ? <Badge kind={sev.tone === 'plain' ? 'plain' : sev.tone}>{sev.label}</Badge>
                            : <span className="dim">—</span>}
                        </td>
                        <td className="mono nowrap clip" title={fmtEndpoint(ev.src_endpoint)}>
                          {fmtEndpoint(ev.src_endpoint)}
                        </td>
                        <td className="mono nowrap clip" title={fmtEndpoint(ev.dst_endpoint)}>
                          {fmtEndpoint(ev.dst_endpoint)}
                        </td>
                        <td className="wrap" title={summaryOf(ev) || undefined}>
                          <span className="clamp2">{summaryOf(ev) || <span className="dim">—</span>}</span>
                        </td>
                        <td className="mono nowrap clip" title={ev.aletheia.template_id || undefined}>
                          {ev.aletheia.template_id || <span className="dim">none</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              offset={offset}
              limit={limit}
              total={total}
              onOffset={goPage}
              onLimit={setLimit}
              noun="events"
              busy={loading}
            />
          </>
        )}
      </Panel>
    </div>
  );
}
