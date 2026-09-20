// COMPATIBILITY SHIM — delete once the Studio API matches docs/CONTRACTS.md.
//
// GET /studio/clusters/{id}/proposal currently returns a nested shape
// ({template:{tokens,slots}, mapping:{class_uid,activity_id,mappings,...}}) instead of the flat
// PackProposal in types.ts, and each mapping uses `path`/`enum`/`evidence[]` instead of
// `ocsf_path`/`enum_map`/`evidence`. GET /proposals/{id}/approval returns a single
// `approver`/`approved_at`/`reason` instead of an `approvals[]` array. Reading both shapes keeps
// the page alive either way; types.ts stays the contract.

import type {
  ApprovalState, AskAiResult, MappingProposal, PackProposal, SlotSample, SlotType, Token,
} from './types';

type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag => (v && typeof v === 'object' ? v as Bag : {});
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Evidence is a sentence in the contract but a list of sentences on the wire. */
const evidenceText = (v: unknown): string =>
  Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).join('; ') : str(v);

function toMapping(raw: unknown, parentOrigin: string): MappingProposal {
  const m = bag(raw);
  const enumMap = bag(m.enum_map ?? m.enum) as Record<string, number>;
  return {
    slot: str(m.slot),
    ocsf_path: str(m.ocsf_path ?? m.path),
    confidence: num(m.confidence),
    evidence: evidenceText(m.evidence),
    origin: (str(m.origin) || parentOrigin || 'heuristic') as MappingProposal['origin'],
    ...(Object.keys(enumMap).length ? { enum_map: enumMap } : {}),
    ...(m.transform ? { transform: m.transform as MappingProposal['transform'] } : {}),
  };
}

function toSlot(raw: unknown): SlotSample {
  const s = bag(raw);
  return {
    slot: str(s.slot ?? s.name),
    type: (str(s.type) || 'word') as SlotType,
    examples: arr(s.examples ?? s.values).map((v) => str(v)),
  };
}

/** Accepts the flat contract shape and the current nested one. */
export function normalizeProposal(raw: unknown): PackProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = bag(raw);
  const template = bag(p.template);
  const mapping = bag(p.mapping);
  const origin = str(p.origin ?? mapping.origin, 'heuristic');

  return {
    proposal_id: str(p.proposal_id),
    cluster_id: str(p.cluster_id),
    source_id: str(p.source_id),
    pack: str(p.pack),
    template_id: str(p.template_id ?? template.template_id),
    pack_version: num(p.pack_version, 1),
    origin: origin as PackProposal['origin'],
    tokens: arr(p.tokens ?? template.tokens) as Token[],
    slots: arr(p.slots ?? template.slots).map(toSlot),
    class_uid: num(p.class_uid ?? mapping.class_uid),
    activity_id: num(p.activity_id ?? mapping.activity_id),
    mappings: arr(p.mappings ?? mapping.mappings).map((m) => toMapping(m, origin)),
    unmapped_keep: arr(p.unmapped_keep ?? mapping.unmapped_keep).map((v) => str(v)),
    created_at: str(p.created_at),
  };
}

const APPROVAL_STATES: ApprovalState['state'][] = [
  'pending', 'awaiting_second_approval', 'approved', 'rejected',
];

export function normalizeApproval(raw: unknown): ApprovalState | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = bag(raw);
  const wire = str(a.state, 'pending');
  // The API still says "proposed" for what the contract calls "pending".
  const state = (APPROVAL_STATES as string[]).includes(wire)
    ? wire as ApprovalState['state']
    : wire === 'proposed' ? 'pending' : 'pending';

  const approvals = Array.isArray(a.approvals)
    ? a.approvals as ApprovalState['approvals']
    : a.approver && state === 'approved'
      ? [{ approver: str(a.approver), at: str(a.approved_at), report_sha256: str(a.report_sha256) }]
      : [];

  const rejection = bag(a.rejection).approver
    ? a.rejection as ApprovalState['rejection']
    : state === 'rejected'
      ? { approver: str(a.approver), at: str(a.approved_at), reason: str(a.reason) }
      : undefined;

  return {
    proposal_id: str(a.proposal_id),
    state,
    approvals,
    required_approvals: num(a.required_approvals, 1),
    ...(rejection ? { rejection } : {}),
  };
}

const REASONS: NonNullable<AskAiResult['reason']>[] = [
  'no_provider', 'airgap_blocked', 'invalid_output', 'transport',
];

/** The endpoint answers `{available:false, reason:"<sentence>"}`; the contract wants ok/error. */
export function normalizeAskAi(raw: unknown): AskAiResult {
  const a = bag(raw);
  const ok = typeof a.ok === 'boolean' ? a.ok
    : typeof a.available === 'boolean' ? a.available
      : false;
  const reasonText = str(a.reason);
  const isEnum = (REASONS as string[]).includes(reasonText);
  const proposal = normalizeProposal(a.proposal);

  return {
    ok,
    // Only surface the AI proposal when the call actually succeeded.
    ...(ok && proposal ? { proposal } : {}),
    ...(isEnum ? { reason: reasonText as AskAiResult['reason'] } : {}),
    error: str(a.error) || (!isEnum && reasonText ? reasonText : '') || undefined,
    provider: str(a.provider) || undefined,
    model: str(a.model) || undefined,
  };
}
