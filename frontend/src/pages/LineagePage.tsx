// The signature feature: a normalized OCSF event beside its reconstructed raw line, with
// byte-level cross-highlighting in both directions (spec 6.14, 8.4).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge, BlockSkeleton, Callout, EmptyState, ErrorState, MetaItem, PageHead, Panel,
  ParseStatusBadge, Spinner, VerifiedSeal,
} from '../components/Bits';
import type { Recheck } from '../components/Bits';
import { IconInbox } from '../components/Icons';
import { OcsfTree } from '../components/OcsfTree';
import { RawLine } from '../components/RawLine';
import { api } from '../lib/api';
import { byteLen, sha256Hex } from '../lib/lineage';
import { useAsync } from '../lib/useAsync';

export function LineagePage() {
  const { eventUid } = useParams<{ eventUid?: string }>();
  const navigate = useNavigate();
  const [active, setActive] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<Recheck | undefined>(undefined);

  // Only fetch the picker list when no event is selected yet.
  const picker = useAsync(
    () => (eventUid ? Promise.resolve(null) : api.listEvents({ limit: 100 })),
    [eventUid],
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

  if (!eventUid) {
    return (
      <div className="stack">
        <PageHead title="Lineage viewer">
          Pick an event. Its normalized OCSF fields and its reconstructed raw line are shown side by
          side, and either one highlights the other down to the byte.
        </PageHead>
        <Panel title="Recent events" subtitle={picker.data ? `${picker.data.events.length} shown` : undefined} flush>
          {picker.loading && <div className="panel-pad"><Spinner label="Loading events" /></div>}
          {picker.error && <div className="panel-pad"><ErrorState error={picker.error} what="events" /></div>}
          {picker.data?.events.length === 0 && (
            <EmptyState title="No events yet" icon={<IconInbox size={22} />}
              action={<Link className="btn-link" to="/demo">Open the Demo Console</Link>}>
              Run <strong>Start traffic</strong> in the Demo Console, or seed the store with{' '}
              <code>bench/seed_clickhouse.py</code>.
            </EmptyState>
          )}
          {picker.data && picker.data.events.length > 0 && (
            <div className="pick-list">
              {picker.data.events.map((ev) => (
                <button
                  key={ev.aletheia.event_uid}
                  className="pick-item"
                  type="button"
                  onClick={() => navigate(`/lineage/${ev.aletheia.event_uid}`)}
                >
                  <span className="t mono truncate">{ev.aletheia.event_uid}</span>
                  <span className="m">
                    {ev.aletheia.source_id} · template {ev.aletheia.template_id || 'none'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>
    );
  }

  const d = lineage.data;
  const span = active && d ? d.spans[active] : undefined;

  return (
    <div className="stack">
      <PageHead
        title="Lineage viewer"
        right={<Link className="btn-link" to="/lineage">Choose another event</Link>}
      >
        Click any OCSF field to highlight the exact bytes it came from — or click a highlighted byte
        range to find the field it fed.
      </PageHead>

      {lineage.loading && <BlockSkeleton lines={6} />}
      {lineage.error && <ErrorState error={lineage.error} what="this event's lineage" />}

      {d && (
        <>
          <Panel
            title="Provenance"
            right={<VerifiedSeal verified={d.verified} sha256={d.raw_sha256} recheck={recheck} />}
          >
            <div className="meta-list">
              <MetaItem label="Event" value={<span className="mono">{d.event_uid}</span>} />
              <MetaItem label="Parse status" value={<ParseStatusBadge status={d.parse_status} />} />
              <MetaItem label="Storage" value={<Badge kind="plain">{d.storage_mode}</Badge>} />
              <MetaItem label="Template" value={d.template_id || 'none'} />
              <MetaItem
                label="Pack"
                value={d.pack ? `${d.pack} v${d.pack_version}` : `v${d.pack_version}`}
              />
              <MetaItem label="Merkle batch" value={<span className="mono">{d.merkle_batch || 'n/a'}</span>} />
            </div>
          </Panel>

          <div className="lineage-grid">
            <Panel
              title="Reconstructed raw line"
              right={<Badge kind="plain" mono>{byteLen(d.raw)} bytes</Badge>}
            >
              <RawLine
                raw={d.raw}
                spans={d.spans}
                tokens={d.tokens}
                active={active}
                onActive={setActive}
                onPick={setActive}
              />
              <p className="hint">
                {span
                  ? <>slot <b>{active}</b> occupies bytes <b>[{span[0]}, {span[1]})</b> of {byteLen(d.raw)}</>
                  : 'Hover a field or a byte range to link the two.'}
              </p>
            </Panel>

            <Panel
              title="Normalized OCSF event"
              right={<Badge kind="plain">{d.vars.length} variables</Badge>}
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
