// Events explorer: every source normalized to identical OCSF columns (spec scenario 1).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, Empty, ErrorBox, Loading, Panel, ParseStatusBadge,
} from '../components/Bits';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type {
  Endpoint, EventQuery, NormalizedEvent, ParseStatus,
} from '../lib/types';

const fmtTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

const fmtEndpoint = (e?: Endpoint): string => {
  if (!e) return '—';
  const host = e.ip ?? e.hostname ?? e.interface_name ?? '—';
  return e.port !== undefined ? `${host}:${e.port}` : host;
};

/** One human-readable summary column, whichever field this OCSF class populated. */
const summaryOf = (ev: NormalizedEvent): string =>
  ev.message ?? ev.http_request?.url?.text ?? ev.actor?.user?.name ?? ev.user?.name ?? '';

export function EventsPage() {
  const navigate = useNavigate();
  const [sourceId, setSourceId] = useState('');
  const [classUid, setClassUid] = useState('');
  const [parseStatus, setParseStatus] = useState('');
  const [q, setQ] = useState('');

  const query = useMemo<EventQuery>(() => ({
    source_id: sourceId || undefined,
    class_uid: classUid ? Number(classUid) : undefined,
    parse_status: (parseStatus || undefined) as ParseStatus | undefined,
    q: q || undefined,
    limit: 500,
  }), [sourceId, classUid, parseStatus, q]);

  const { data, loading, error } = useAsync(() => api.listEvents(query), [JSON.stringify(query)]);

  return (
    <div className="stack">
      <div>
        <h1>Events explorer</h1>
        <p className="sub">
          All sources land in one table with identical OCSF columns. Filter by source, class or parse
          status, then open any row in the lineage viewer to see its exact byte provenance.
        </p>
      </div>

      <Panel title="Filters">
        <div className="row">
          <div style={{ minWidth: 160 }}>
            <label>Source</label>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">all sources</option>
              {data?.sources.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 220 }}>
            <label>Class</label>
            <select value={classUid} onChange={(e) => setClassUid(e.target.value)}>
              <option value="">all classes</option>
              {data?.classes.map((c) => (
                <option key={c.class_uid} value={c.class_uid}>{c.name} ({c.class_uid})</option>
              ))}
            </select>
          </div>
          <div style={{ minWidth: 160 }}>
            <label>Parse status</label>
            <select value={parseStatus} onChange={(e) => setParseStatus(e.target.value)}>
              <option value="">all</option>
              <option value="full">full</option>
              <option value="partial">partial</option>
              <option value="raw_only">raw_only</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label>Search</label>
            <input placeholder="substring over the event JSON" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      </Panel>

      <Panel title={data ? `${data.total} events` : 'Events'}>
        {loading && <Loading what="events" />}
        {error && <ErrorBox error={error} />}
        {data && data.events.length === 0 && <Empty>No events match these filters.</Empty>}
        {data && data.events.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th><th>Source</th><th>Class</th><th>Parse</th>
                  <th>Src</th><th>Dst</th><th>Summary</th><th>Template</th><th>Event UID</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((ev) => (
                  <tr
                    key={ev.aletheia.event_uid}
                    className="clickable"
                    onClick={() => navigate(`/lineage/${ev.aletheia.event_uid}`)}
                  >
                    <td>{fmtTime(ev.time)}</td>
                    <td>{ev.aletheia.source_id}</td>
                    <td>{data.classes.find((c) => c.class_uid === ev.class_uid)?.name ?? ev.class_uid}</td>
                    <td><ParseStatusBadge status={ev.aletheia.parse_status} /></td>
                    <td>{fmtEndpoint(ev.src_endpoint)}</td>
                    <td>{fmtEndpoint(ev.dst_endpoint)}</td>
                    <td className="wrap">{summaryOf(ev)}</td>
                    <td>{ev.aletheia.template_id || <Badge kind="plain">none</Badge>}</td>
                    <td>{ev.aletheia.event_uid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
