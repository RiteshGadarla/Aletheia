// Onboarding Studio: cluster -> proposed template/mappings -> gate -> replay diff -> approve/reject
// (spec 8.6-8.11, 8.12.4). Ask AI must degrade gracefully when no provider is configured or flaky.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, Cli, Confidence, Empty, ErrorBox, Loading, Panel, ParseStatusBadge,
} from '../components/Bits';
import { TemplateView } from '../components/TemplateView';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type {
  ApprovalState, AskAiResult, GateResult, MappingProposal, PackProposal, ReplayDiff,
} from '../lib/types';

interface ActionState<T> { loading: boolean; data: T | null; error: string | null }

/** Runs an async action on demand (button click), tracking loading/data/error locally. */
function useAction<T>() {
  const [state, setState] = useState<ActionState<T>>({ loading: false, data: null, error: null });
  const run = useCallback(async (fn: () => Promise<T>) => {
    setState({ loading: true, data: null, error: null });
    try {
      const data = await fn();
      setState({ loading: false, data, error: null });
    } catch (e) {
      setState({ loading: false, data: null, error: errMessage(e) });
    }
  }, []);
  const reset = useCallback(() => setState({ loading: false, data: null, error: null }), []);
  return { ...state, run, reset };
}

function originBadge(origin: string) {
  return <Badge kind={origin === 'heuristic' ? 'plain' : 'info'}>{origin}</Badge>;
}

function MappingTable({ mappings, hover, onHover }: {
  mappings: MappingProposal[]; hover: string | null; onHover: (slot: string | null) => void;
}) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr><th>Slot</th><th>OCSF path</th><th>Confidence</th><th>Origin</th><th>Evidence</th></tr>
        </thead>
        <tbody>
          {mappings.map((m) => (
            <tr
              key={m.slot}
              onMouseEnter={() => onHover(m.slot)}
              onMouseLeave={() => onHover(null)}
              style={hover === m.slot ? { background: 'var(--bg-3)' } : undefined}
            >
              <td>{m.slot}</td>
              <td>{m.ocsf_path}</td>
              <td><Confidence value={m.confidence} /></td>
              <td>{originBadge(m.origin)}</td>
              <td className="wrap">{m.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pinpoints one failing byte offset inside a sample, reusing the raw-line highlight styles. */
function FailureLine({ sample, offset }: { sample: string; offset: number }) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(sample);
  const before = dec.decode(bytes.subarray(0, offset));
  const at = dec.decode(bytes.subarray(offset, offset + 1)) || '␀';
  const after = dec.decode(bytes.subarray(offset + 1));
  return (
    <div className="raw">
      <span className="lit">{before}</span>
      <span className="slot hit">{at}</span>
      <span className="lit">{after}</span>
    </div>
  );
}

export function StudioPage() {
  const clusters = useAsync(() => api.listClusters(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [override, setOverride] = useState<PackProposal | null>(null);
  const [approver, setApprover] = useState('riteshcode12@gmail.com');
  const [rejectReason, setRejectReason] = useState('');

  const proposal = useAsync(
    () => (selected ? api.getProposal(selected) : Promise.resolve(null)),
    [selected],
  );
  const active = override ?? proposal.data;

  const ai = useAction<AskAiResult>();
  const gate = useAction<GateResult>();
  const replay = useAction<ReplayDiff>();
  const approveAction = useAction<ApprovalState>();
  const rejectAction = useAction<ApprovalState>();
  const approvalLoad = useAsync(
    () => (active ? api.getApproval(active.proposal_id) : Promise.resolve(null)),
    [active?.proposal_id],
  );
  const approvalState = approveAction.data ?? rejectAction.data ?? approvalLoad.data;

  useEffect(() => {
    setOverride(null);
    setRejectReason('');
    ai.reset(); gate.reset(); replay.reset(); approveAction.reset(); rejectAction.reset();
    // Cluster changed: every downstream step (mappings, gate, replay, approval) starts over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function useAiMappings() {
    if (ai.data?.ok && ai.data.proposal) setOverride(ai.data.proposal);
  }

  function doApprove() {
    const rd = replay.data;
    if (!active || !rd) return;
    const proposalId = active.proposal_id;
    void approveAction.run(() => api.approve(proposalId, approver, rd.report_sha256));
  }

  function doReject() {
    if (!active || !rejectReason) return;
    const proposalId = active.proposal_id;
    void rejectAction.run(() => api.reject(proposalId, approver, rejectReason));
  }

  return (
    <div className="stack">
      <div>
        <h1>Onboarding Studio</h1>
        <p className="sub">
          Quarantined clusters get a proposed template and mappings, must clear the reconstruction
          gate and a replay diff, and only then can be approved. AI is an optional second opinion,
          never a shortcut past the gate.
        </p>
      </div>

      <div className="grid-side">
        <Panel title="Quarantine clusters">
          {clusters.loading && <Loading what="clusters" />}
          {clusters.error && <ErrorBox error={clusters.error} />}
          {clusters.data && clusters.data.length === 0 && (
            <Empty>No quarantined clusters. Trigger drift from the Demo Console.</Empty>
          )}
          {clusters.data && clusters.data.length > 0 && (
            <div className="selectable-list">
              {clusters.data.map((c) => (
                <button
                  key={c.cluster_id}
                  type="button"
                  className={`sel-item ${selected === c.cluster_id ? 'active' : ''}`}
                  onClick={() => setSelected(c.cluster_id)}
                >
                  <div className="title">{c.cluster_id}</div>
                  <div className="meta">{c.source_id} &middot; {c.sample_count} samples</div>
                  <div className="meta mono" style={{ marginTop: 4 }}>{c.drain_template}</div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <div className="stack">
          {!selected && <Empty>Select a quarantine cluster to see its proposed template.</Empty>}
          {selected && proposal.loading && <Loading what="proposal" />}
          {selected && proposal.error && <ErrorBox error={proposal.error} />}

          {active && (
            <>
              <Panel title="Proposed template" right={originBadge(active.origin)}>
                <TemplateView tokens={active.tokens} active={hover} onActive={setHover} />
                <p className="hint" style={{ marginTop: 10 }}>
                  pack {active.pack} v{active.pack_version} &middot; class_uid {active.class_uid}{' '}
                  &middot; activity_id {active.activity_id}
                </p>
              </Panel>

              <Panel
                title="Proposed mappings"
                right={(
                  <button
                    type="button"
                    onClick={() => void ai.run(() => api.askAi(active.cluster_id))}
                    disabled={ai.loading}
                  >
                    {ai.loading ? 'asking...' : 'Ask AI'}
                  </button>
                )}
              >
                <MappingTable mappings={active.mappings} hover={hover} onHover={setHover} />
              </Panel>

              {(ai.error || (ai.data && !ai.data.ok)) && (
                <div className="blocking">
                  <h4>AI suggestion unavailable</h4>
                  <p style={{ margin: '0 0 6px' }}>Heuristic proposal is unaffected.</p>
                  <p className="hint">
                    {ai.data?.error ?? ai.error}{ai.data?.reason ? ` (${ai.data.reason})` : ''}
                  </p>
                  <Link to="/settings">Configure a provider in Settings</Link>
                </div>
              )}

              {ai.data?.ok && ai.data.proposal && (
                <Panel
                  title={`AI suggestion: ${ai.data.provider ?? 'unknown'}/${ai.data.model ?? 'unknown'}`}
                  right={<button type="button" onClick={useAiMappings}>Use AI mappings</button>}
                >
                  <MappingTable mappings={ai.data.proposal.mappings} hover={hover} onHover={setHover} />
                </Panel>
              )}

              <Panel
                title="Reconstruction gate"
                right={(
                  <span className="row">
                    <button
                      type="button"
                      onClick={() => void gate.run(() => api.runGate(active.proposal_id, false))}
                      disabled={gate.loading}
                    >
                      {gate.loading ? 'running...' : 'Run gate'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void gate.run(() => api.runGate(active.proposal_id, true))}
                      disabled={gate.loading}
                    >
                      Try a faulty template
                    </button>
                  </span>
                )}
              >
                {gate.error && <ErrorBox error={gate.error} />}
                {!gate.data && !gate.error && <p className="hint">Not run yet.</p>}
                {gate.data && (
                  <div className="stack">
                    <div className="row">
                      <Badge kind={gate.data.ok ? 'ok' : 'bad'}>{gate.data.ok ? 'PASS' : 'REJECTED'}</Badge>
                      <span className="hint">
                        {gate.data.reconstructed}/{gate.data.samples} reconstructed &middot; coverage{' '}
                        {(gate.data.coverage * 100).toFixed(0)}%
                      </span>
                      <Badge kind={gate.data.type_validation_ok ? 'ok' : 'bad'}>type validation</Badge>
                      <Badge kind={gate.data.golden_tests_ok ? 'ok' : 'bad'}>golden tests</Badge>
                      <Badge kind={gate.data.no_adjacent_slots_ok ? 'ok' : 'bad'}>no adjacent slots</Badge>
                    </div>
                    {gate.data.failures.map((f, i) => (
                      <div key={i} className="blocking">
                        <h4>Failure: {f.reason}</h4>
                        <p className="hint">byte offset {f.offset}</p>
                        <FailureLine sample={f.sample} offset={f.offset} />
                      </div>
                    ))}
                    <Cli cmd={gate.data.cli} />
                  </div>
                )}
              </Panel>

              <Panel
                title="Replay diff"
                right={(
                  <button
                    type="button"
                    onClick={() => void replay.run(() => api.runReplay(active.proposal_id))}
                    disabled={replay.loading}
                  >
                    {replay.loading ? 'running...' : 'Run replay diff'}
                  </button>
                )}
              >
                {replay.error && <ErrorBox error={replay.error} />}
                {!replay.data && !replay.error && <p className="hint">Not run yet.</p>}
                {replay.data && (
                  <div className="stack">
                    <div className="row">
                      <span className="hint">
                        {replay.data.events_examined} events examined, v{replay.data.from_version} &rarr;{' '}
                        v{replay.data.to_version}
                      </span>
                      <Badge kind="ok">newly matched {replay.data.newly_matched}</Badge>
                      <Badge kind="info">template changed {replay.data.template_changed}</Badge>
                      <Badge kind={replay.data.regressions.length ? 'bad' : 'ok'}>
                        regressions {replay.data.regressions.length}
                      </Badge>
                    </div>
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead><tr><th>Field</th><th>Changed</th><th>Before</th><th>After</th></tr></thead>
                        <tbody>
                          {replay.data.fields.map((f) => (
                            <tr key={f.path}>
                              <td>{f.path}</td>
                              <td>{f.changed}</td>
                              <td>{f.before_example ?? '—'}</td>
                              <td>{f.after_example ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {replay.data.regressions.length > 0 && (
                      <div className="blocking">
                        <h4>Regressions &mdash; blocking, an event would get worse</h4>
                        {replay.data.regressions.map((r) => (
                          <div key={r.event_uid} className="stack" style={{ marginBottom: 8 }}>
                            <div className="row">
                              <span className="mono">{r.event_uid}</span>
                              <ParseStatusBadge status={r.from} /> &rarr; <ParseStatusBadge status={r.to} />
                            </div>
                            <div className="raw">{r.raw}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <Cli cmd={replay.data.cli} />
                  </div>
                )}
              </Panel>

              <Panel title="Approval">
                {approvalLoad.loading && <Loading what="approval state" />}
                {approvalLoad.error && <ErrorBox error={approvalLoad.error} />}
                {approvalState && (
                  <div className="stack">
                    <Badge kind={
                      approvalState.state === 'approved' ? 'ok'
                        : approvalState.state === 'rejected' ? 'bad'
                          : 'warn'
                    }
                    >
                      {approvalState.state}
                    </Badge>
                    {approvalState.approvals.map((a) => (
                      <div key={a.approver + a.at} className="hint">
                        {a.approver} at {a.at} &middot; report {a.report_sha256.slice(0, 12)}...
                      </div>
                    ))}
                    {approvalState.rejection && (
                      <div className="hint err">
                        rejected by {approvalState.rejection.approver}: {approvalState.rejection.reason}
                      </div>
                    )}
                    {replay.data && replay.data.regressions.length > 0 && (
                      <p className="hint err">Regressions are blocking: review carefully before approving.</p>
                    )}
                    <div className="row">
                      <div style={{ minWidth: 220 }}>
                        <label>Approver</label>
                        <input value={approver} onChange={(e) => setApprover(e.target.value)} />
                      </div>
                      <button
                        type="button"
                        className="primary"
                        disabled={!replay.data || approveAction.loading}
                        title={!replay.data ? 'Run replay diff first, so the approval carries its report hash' : undefined}
                        onClick={doApprove}
                      >
                        {approveAction.loading ? 'approving...' : 'Approve'}
                      </button>
                    </div>
                    <div className="row">
                      <div style={{ flex: 1 }}>
                        <label>Rejection reason</label>
                        <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                      </div>
                      <button
                        type="button"
                        className="danger"
                        disabled={!rejectReason || rejectAction.loading}
                        onClick={doReject}
                      >
                        {rejectAction.loading ? 'rejecting...' : 'Reject'}
                      </button>
                    </div>
                    {approveAction.error && <ErrorBox error={approveAction.error} />}
                    {rejectAction.error && <ErrorBox error={rejectAction.error} />}
                  </div>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
