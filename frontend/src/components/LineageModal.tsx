import { useEffect, useState } from 'react';
import {
  Badge, BlockSkeleton, Callout, ErrorState, MetaItem, Panel, ParseStatusBadge, VerifiedSeal,
} from './Bits';
import type { Recheck } from './Bits';
import { IconCheck, IconClose, IconCopy, IconLineage } from './Icons';
import { OcsfTree } from './OcsfTree';
import { RawLine } from './RawLine';
import { api } from '../lib/api';
import { byteLen, sha256Hex } from '../lib/lineage';
import { useAsync } from '../lib/useAsync';

interface LineageModalProps {
  eventUid: string;
  onClose: () => void;
}

export function LineageModal({ eventUid, onClose }: LineageModalProps) {
  const [active, setActive] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<Recheck | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lineage = useAsync(() => api.getLineage(eventUid), [eventUid]);

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

  const d = lineage.data;
  const span = active && d ? d.spans[active] : undefined;
  const mappedPath = active && d?.field_map ? Object.entries(d.field_map).find(([, slot]) => slot === active)?.[0] : null;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal lineage-modal" onClick={(e) => e.stopPropagation()} tabIndex={-1}>
        <div className="modal-head">
          <div className="grow">
            <h2 className="flex align-center" style={{ gap: 8 }}>
              <IconLineage size={20} />
              <span>Byte Lineage Inspector</span>
            </h2>
            <div className="hint mono" style={{ fontSize: 'var(--fs-xs, 12px)', marginTop: 4, wordBreak: 'break-all' }}>
              {eventUid}
            </div>
          </div>
          <div className="row-tight" style={{ gap: 8 }}>
            {d && (
              <button
                type="button"
                className="ghost sm flex align-center"
                style={{ gap: 4 }}
                onClick={() => copyText(d.event_uid)}
                title="Copy Event UID"
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                <span>{copied ? 'Copied' : 'Copy UID'}</span>
              </button>
            )}
            <button
              type="button"
              className="ghost icon sidebar-close"
              onClick={onClose}
              aria-label="Close lineage inspection"
            >
              <IconClose size={18} />
            </button>
          </div>
        </div>

        <div className="modal-body stack" style={{ gap: 'var(--s4)' }}>
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
        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
