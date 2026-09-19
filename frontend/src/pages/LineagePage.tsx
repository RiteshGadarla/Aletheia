// The signature feature: a normalized OCSF event beside its reconstructed raw line,
// with click/hover byte-level cross-highlighting (spec 6.14, 8.4).
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge, Empty, ErrorBox, Loading, Panel, ParseStatusBadge, VerifiedBadge,
} from '../components/Bits';
import { OcsfTree } from '../components/OcsfTree';
import { RawLine } from '../components/RawLine';
import { api } from '../lib/api';
import { byteLen } from '../lib/lineage';
import { useAsync } from '../lib/useAsync';

export function LineagePage() {
  const { eventUid } = useParams<{ eventUid?: string }>();
  const navigate = useNavigate();
  const [active, setActive] = useState<string | null>(null);

  // Only fetch the picker list when no event is selected yet.
  const picker = useAsync(
    () => (eventUid ? Promise.resolve(null) : api.listEvents({ limit: 100 })),
    [eventUid],
  );

  const lineage = useAsync(
    () => (eventUid ? api.getLineage(eventUid) : Promise.reject(new Error('no event selected'))),
    [eventUid],
  );

  if (!eventUid) {
    return (
      <div className="stack">
        <div>
          <h1>Lineage viewer</h1>
          <p className="sub">
            Pick an event. Its normalized OCSF fields and reconstructed raw line are shown side by
            side, and either one can highlight the other.
          </p>
        </div>
        <Panel title="Recent events">
          {picker.loading && <Loading what="events" />}
          {picker.error && <ErrorBox error={picker.error} />}
          {picker.data && picker.data.events.length === 0 && <Empty>No events yet.</Empty>}
          {picker.data && picker.data.events.length > 0 && (
            <div className="selectable-list">
              {picker.data.events.map((ev) => (
                <button
                  key={ev.aletheia.event_uid}
                  className="sel-item"
                  type="button"
                  onClick={() => navigate(`/lineage/${ev.aletheia.event_uid}`)}
                >
                  <div className="title">{ev.aletheia.event_uid}</div>
                  <div className="meta">
                    {ev.aletheia.source_id} &middot; {ev.aletheia.parse_status} &middot; template{' '}
                    {ev.aletheia.template_id || 'none'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Lineage viewer</h1>
          <p className="sub">
            Click any OCSF field to highlight the exact bytes it came from, or click a highlighted
            byte range to highlight the field it fed.
          </p>
        </div>
        <Link to="/lineage">choose a different event</Link>
      </div>

      {lineage.loading && <Loading what="lineage" />}
      {lineage.error && <ErrorBox error={lineage.error} />}

      {lineage.data && (
        <>
          <Panel title="Provenance" right={<Link to="/events">open events explorer</Link>}>
            <div className="row">
              <ParseStatusBadge status={lineage.data.parse_status} />
              <VerifiedBadge verified={lineage.data.verified} sha256={lineage.data.raw_sha256} />
              <Badge kind="plain">storage {lineage.data.storage_mode}</Badge>
              <Badge kind="plain">template {lineage.data.template_id || 'none'}</Badge>
              <Badge kind="plain">
                pack {lineage.data.pack ? `${lineage.data.pack} v${lineage.data.pack_version}` : 'none'}
              </Badge>
              <Badge kind="plain">batch {lineage.data.merkle_batch || 'n/a'}</Badge>
            </div>
          </Panel>

          <div className="grid-2">
            <Panel title="Reconstructed raw line">
              <RawLine
                raw={lineage.data.raw}
                spans={lineage.data.spans}
                tokens={lineage.data.tokens}
                active={active}
                onActive={setActive}
                onPick={setActive}
              />
              <p className="hint" style={{ marginTop: 8 }}>
                {active && lineage.data.spans[active]
                  ? (
                    <>
                      slot <b>{active}</b>: bytes [{lineage.data.spans[active][0]}, {lineage.data.spans[active][1]})
                      of {byteLen(lineage.data.raw)} total
                    </>
                  )
                  : `${byteLen(lineage.data.raw)} bytes total. Hover a field or a byte range to link them.`}
              </p>
            </Panel>
            <Panel title="Normalized OCSF event">
              <OcsfTree
                value={lineage.data.event}
                fieldMap={lineage.data.field_map}
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
