// Fixture-backed implementation of the API, enabled with VITE_USE_MOCKS=1.
// It computes spans and reconstructions with the same code the UI uses, so a
// mocked page shows real byte lineage over real (fixture) bytes.

import { CLUSTERS, EVENTS, RAW_SHA256, SCENARIOS, TEMPLATES } from './fixtures';
import type { EventFixture, MapRule, TemplateFixture } from './fixtures';
import { computeSpans, reconstruct } from './lineage';
import type {
  ApprovalState, AskAiResult, ConnTest, DemoRunResult, DemoScenario, EventPage, EventQuery,
  GateResult, LineageResponse, LlmSettings, LlmSettingsUpdate, MappingProposal, NormalizedEvent,
  PackProposal, QuarantineCluster, ReplayDiff, SlotType, Token,
  AlertingStatus, AlertNotification, AlertOp, AlertPreview, AlertPreviewRequest, AlertRule, AlertRuleInput,
  ContactPoint, ContactPointInput, NotificationPolicy, PolicyRoute, Sync, SupplyConfigUpdate, SupplyStatus,
} from './types';
import { isCloudProvider } from './types';

/* ---------------- OCSF assembly (CONTRACTS section 5) ---------------- */

const SEVERITY_BY_SYSLOG: Record<number, number> = { 0: 6, 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1 };

function categoryOf(classUid: number): number {
  if (classUid >= 4000 && classUid < 5000) return 4;
  if (classUid >= 3000 && classUid < 4000) return 3;
  if (classUid >= 2000 && classUid < 3000) return 2;
  return 1;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function applyRule(rule: MapRule, raw: string): { path: string; value: unknown } {
  if (typeof rule === 'string') return { path: rule, value: raw };
  let value: unknown = raw;
  if (rule.enum) value = rule.enum[raw] ?? rule.enum[raw.toLowerCase()] ?? null;
  else if (rule.transform === 'to_int') value = Number.parseInt(raw, 10);
  else if (rule.transform === 'lowercase') value = raw.toLowerCase();
  return { path: rule.path, value };
}

const minuteOf = (ms: number): string => new Date(ms - (ms % 60000)).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');

const templateOf = (id: string): TemplateFixture | undefined => TEMPLATES.find((t) => t.template_id === id);

/** Value of a named slot in an event's vars. */
function slotValue(tpl: TemplateFixture, ev: EventFixture, slot: string): string | undefined {
  let vi = 0;
  for (const t of tpl.tokens) {
    if (!t.slot) continue;
    if (t.slot === slot) return ev.vars[vi];
    vi += 1;
  }
  return undefined;
}

export interface BuiltEvent {
  event: NormalizedEvent;
  raw: string;
  /** OCSF dotted path -> slot name. */
  field_map: Record<string, string>;
  tokens: Token[];
  vars: string[];
}

function buildEvent(ev: EventFixture): BuiltEvent {
  const tpl = templateOf(ev.template_id);
  const merkle = (sourceId: string) => `${sourceId}/p${ev.partition}/${minuteOf(ev.recv_ms)}`;

  if (!tpl) {
    // Quarantined line: nothing matched, so it is stored verbatim and kept as raw_only.
    const raw = ev.verbatim_raw ?? '';
    const event: NormalizedEvent = {
      class_uid: 0, category_uid: 0, activity_id: 0, type_uid: 0,
      time: ev.recv_ms, severity_id: 1,
      metadata: {
        version: '1.3.0', uid: ev.event_uid, original_time: '',
        product: { vendor_name: 'unknown', name: 'unknown' }, log_name: 'fw01',
      },
      unmapped: {},
      aletheia: {
        event_uid: ev.event_uid, source_id: 'fw01', parse_status: 'raw_only',
        storage_mode: 'verbatim', template_id: '', pack: '', pack_version: 0,
        raw_sha256: RAW_SHA256[ev.event_uid] ?? '', verified: true, merkle_batch: merkle('fw01'),
      },
    };
    return { event, raw, field_map: {}, tokens: [], vars: [] };
  }

  const raw = reconstruct(tpl.tokens, ev.vars);
  const out: Record<string, unknown> = {};
  const field_map: Record<string, string> = {};

  for (const [path, value] of Object.entries(tpl.constants)) setPath(out, path, value);

  let vi = 0;
  for (const t of tpl.tokens) {
    if (!t.slot) continue;
    const value = ev.vars[vi++] ?? '';
    const rule = tpl.map[t.slot];
    if (rule) {
      const { path, value: typed } = applyRule(rule, value);
      setPath(out, path, typed);
      field_map[path] = t.slot;
    } else if (tpl.unmapped_keep.includes(t.slot)) {
      // CONTRACTS section 5: unmapped holds exact raw substrings, strings only.
      setPath(out, `unmapped.${t.slot}`, value);
      field_map[`unmapped.${t.slot}`] = t.slot;
    }
  }

  const priRaw = tpl.pri_slot ? slotValue(tpl, ev, tpl.pri_slot) : undefined;
  const severity = priRaw !== undefined
    ? SEVERITY_BY_SYSLOG[Number.parseInt(priRaw, 10) % 8] ?? 1
    : tpl.severity_id ?? 1;
  if (tpl.pri_slot) field_map['severity_id'] = tpl.pri_slot;
  if (tpl.time_slot) field_map['time'] = tpl.time_slot;

  const originalTime = tpl.time_slot ? slotValue(tpl, ev, tpl.time_slot) ?? '' : '';
  const logName = slotValue(tpl, ev, 'host') ?? tpl.source_id;

  const event: NormalizedEvent = {
    class_uid: tpl.class_uid,
    category_uid: categoryOf(tpl.class_uid),
    activity_id: tpl.activity_id,
    type_uid: tpl.class_uid * 100 + tpl.activity_id,
    time: ev.recv_ms,
    severity_id: severity,
    ...(out as Partial<NormalizedEvent>),
    metadata: {
      version: '1.3.0',
      uid: ev.event_uid,
      original_time: originalTime,
      product: { vendor_name: tpl.vendor, name: tpl.product },
      log_name: logName,
      ...((out.metadata as object) ?? {}),
    },
    unmapped: (out.unmapped as Record<string, string>) ?? {},
    aletheia: {
      event_uid: ev.event_uid,
      source_id: tpl.source_id,
      parse_status: ev.parse_status ?? 'full',
      storage_mode: 'template',
      template_id: tpl.template_id,
      pack: tpl.pack,
      pack_version: tpl.pack_version,
      raw_sha256: RAW_SHA256[ev.event_uid] ?? '',
      verified: true,
      merkle_batch: merkle(tpl.source_id),
    },
  };
  field_map['metadata.original_time'] = field_map['metadata.original_time'] ?? (tpl.time_slot ?? '');
  if (!field_map['metadata.original_time']) delete field_map['metadata.original_time'];

  return { event, raw, field_map, tokens: tpl.tokens, vars: ev.vars };
}

export const BUILT: BuiltEvent[] = EVENTS.map(buildEvent);

/** Raw line of every fixture event, used by the hash generator and by verify output. */
export const rawLines = (): { event_uid: string; raw: string }[] =>
  BUILT.map((b) => ({ event_uid: b.event.aletheia.event_uid, raw: b.raw }));

/* ---------------- mutable demo state ---------------- */

const CLASS_NAMES: Record<number, string> = {
  4001: 'Network Activity', 4002: 'HTTP Activity', 4003: 'DNS Activity',
  3002: 'Authentication', 2004: 'Detection Finding', 0: 'Unparsed',
};

interface MockState {
  settings: LlmSettings;
  approvals: Record<string, ApprovalState>;
  tampered: boolean;
  trafficStarted: boolean;
  driftTriggered: boolean;
}

const defaultSettings = (): LlmSettings => ({
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  base_url: 'https://generativelanguage.googleapis.com/v1beta',
  send_samples: 'masked',
  api_key_last4: null,
  api_key_set: false,
  airgap: false,
  sources: { provider: 'default', model: 'default', base_url: 'default', send_samples: 'default' },
  usage: { requests: 0, tokens: null, window: 'last 1h', cap_per_hour: 20 },
  updated_at: null,
});

const freshState = (): MockState => ({
  settings: defaultSettings(),
  approvals: {},
  tampered: false,
  trafficStarted: true,
  driftTriggered: true,
});

let state: MockState = freshState();

const delay = <T,>(value: T, ms = 140): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

/* ---------------- proposals (spec 8.7, 8.8) ---------------- */

const L = (lit: string): Token => ({ lit });
const S = (slot: string, type: SlotType, values?: string[]): Token =>
  values ? { slot, type, values } : { slot, type };

/** Derived template for the drifted ASA line: the old one plus duration and user. */
const DRIFT_TOKENS: Token[] = [
  L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
  L(' %ASA-6-302013: Built '), S('direction', 'enum', ['inbound', 'outbound']),
  L(' TCP connection '), S('conn_id', 'int'),
  L(' for '), S('if_a', 'hostname'), L(':'), S('ip_a', 'ip'), L('/'), S('port_a', 'port'),
  L(' ('), S('mip_a', 'ip'), L('/'), S('mport_a', 'port'),
  L(') to '), S('if_b', 'hostname'), L(':'), S('ip_b', 'ip'), L('/'), S('port_b', 'port'),
  L(' ('), S('mip_b', 'ip'), L('/'), S('mport_b', 'port'),
  L(') duration '), S('duration', 'word'), L(' user '), S('user', 'word'),
];

const HEURISTIC_MAPPINGS: MappingProposal[] = [
  { slot: 'ts', ocsf_path: 'metadata.original_time', confidence: 0.99, origin: 'heuristic', evidence: 'All 412 samples match syslog3164_ts; slot sits inside the RFC 3164 envelope.' },
  { slot: 'host', ocsf_path: 'metadata.log_name', confidence: 0.97, origin: 'heuristic', evidence: 'Envelope HOSTNAME position; constant value fw01 across samples.' },
  { slot: 'direction', ocsf_path: 'connection_info.direction_id', confidence: 0.93, origin: 'heuristic', evidence: 'Two distinct values (inbound, outbound); enum table maps outbound to 2.', enum_map: { inbound: 1, outbound: 2 } },
  { slot: 'conn_id', ocsf_path: 'connection_info.uid', confidence: 0.88, origin: 'heuristic', evidence: 'Preceding literal "TCP connection "; integer, monotonically increasing.' },
  { slot: 'ip_b', ocsf_path: 'src_endpoint.ip', confidence: 0.91, origin: 'heuristic', evidence: 'IPv4 in every sample; preceded by "to inside:" and direction is outbound.' },
  { slot: 'port_b', ocsf_path: 'src_endpoint.port', confidence: 0.9, origin: 'heuristic', evidence: 'Integer 0-65535 following "/" after an IP.', transform: 'to_int' },
  { slot: 'ip_a', ocsf_path: 'dst_endpoint.ip', confidence: 0.91, origin: 'heuristic', evidence: 'IPv4 in every sample; preceded by "for outside:".' },
  { slot: 'port_a', ocsf_path: 'dst_endpoint.port', confidence: 0.9, origin: 'heuristic', evidence: 'Integer 0-65535 following "/" after an IP.', transform: 'to_int' },
  { slot: 'if_a', ocsf_path: 'dst_endpoint.interface_name', confidence: 0.72, origin: 'heuristic', evidence: 'Small word set (outside, inside, dmz) before ":" and an IP.' },
  { slot: 'if_b', ocsf_path: 'src_endpoint.interface_name', confidence: 0.72, origin: 'heuristic', evidence: 'Small word set before ":" and an IP, after the literal "to ".' },
  { slot: 'user', ocsf_path: 'actor.user.name', confidence: 0.61, origin: 'heuristic', evidence: 'New slot; preceded by literal "user ". Synonym table maps user to actor.user.name.' },
];

const AI_MAPPINGS: MappingProposal[] = HEURISTIC_MAPPINGS.map((m) =>
  m.slot === 'user'
    ? { ...m, ocsf_path: 'user.name', confidence: 0.84, origin: 'ai:gemini/gemini-3.5-flash-lite' as const, evidence: 'Literal "user " immediately precedes the slot; values look like account names (r.menon, a.iyer, svc_backup).' }
    : { ...m, origin: 'ai:gemini/gemini-3.5-flash-lite' as const },
).concat([
  { slot: 'duration', ocsf_path: 'connection_info.uid', confidence: 0.41, origin: 'ai:gemini/gemini-3.5-flash-lite', evidence: 'Low confidence: h:mm:ss shape; the model suggested reusing the connection id field, which the reviewer should reject.' },
]);

const SLOT_SAMPLES = [
  { slot: 'pri', type: 'int' as SlotType, examples: ['166', '166', '166'] },
  { slot: 'ts', type: 'syslog3164_ts' as SlotType, examples: ['Sep 19 14:32:02', 'Sep 19 14:32:03', 'Sep 19 14:32:07'] },
  { slot: 'host', type: 'hostname' as SlotType, examples: ['fw01', 'fw01', 'fw01'] },
  { slot: 'direction', type: 'enum' as SlotType, examples: ['outbound', 'outbound', 'inbound'] },
  { slot: 'conn_id', type: 'int' as SlotType, examples: ['1301', '1302', '1303'] },
  { slot: 'if_a', type: 'hostname' as SlotType, examples: ['outside', 'outside', 'outside'] },
  { slot: 'ip_a', type: 'ip' as SlotType, examples: ['203.0.113.5', '93.184.216.34', '198.51.100.23'] },
  { slot: 'port_a', type: 'port' as SlotType, examples: ['443', '80', '51500'] },
  { slot: 'mip_a', type: 'ip' as SlotType, examples: ['203.0.113.5', '93.184.216.34', '198.51.100.23'] },
  { slot: 'mport_a', type: 'port' as SlotType, examples: ['443', '80', '51500'] },
  { slot: 'if_b', type: 'hostname' as SlotType, examples: ['inside', 'inside', 'inside'] },
  { slot: 'ip_b', type: 'ip' as SlotType, examples: ['10.0.0.5', '10.0.0.23', '10.0.0.9'] },
  { slot: 'port_b', type: 'port' as SlotType, examples: ['52190', '51390', '22'] },
  { slot: 'mip_b', type: 'ip' as SlotType, examples: ['198.51.100.7', '198.51.100.7', '198.51.100.7'] },
  { slot: 'mport_b', type: 'port' as SlotType, examples: ['52190', '51390', '22'] },
  { slot: 'duration', type: 'word' as SlotType, examples: ['0:00:00', '0:00:00', '0:00:00'] },
  { slot: 'user', type: 'word' as SlotType, examples: ['r.menon', 'a.iyer', 'svc_backup'] },
];

function proposal(origin: 'heuristic' | 'ai:gemini/gemini-3.5-flash-lite'): PackProposal {
  return {
    proposal_id: origin === 'heuristic' ? 'pr_asa_302013_v5' : 'pr_asa_302013_v5_ai',
    cluster_id: 'cl_asa_302013_v2',
    source_id: 'fw01',
    pack: 'cisco_asa',
    template_id: 'asa_302013_v2',
    pack_version: 5,
    origin,
    tokens: DRIFT_TOKENS,
    slots: SLOT_SAMPLES,
    class_uid: 4001,
    activity_id: 1,
    mappings: origin === 'heuristic' ? HEURISTIC_MAPPINGS : AI_MAPPINGS,
    unmapped_keep: ['mip_a', 'mport_a', 'mip_b', 'mport_b', 'duration'],
    created_at: '2026-09-19T14:40:11Z',
  };
}

const FAULTY_SAMPLE = CLUSTERS[0].samples[0];

function gateResult(proposalId: string, faulty: boolean): GateResult {
  if (faulty) {
    return {
      ok: false,
      samples: 412,
      reconstructed: 0,
      failures: [{
        sample: FAULTY_SAMPLE,
        reason: 'literal mismatch: template expects " duratlon " but sample has " duration "',
        offset: 168,
      }],
      type_validation_ok: true,
      golden_tests_ok: true,
      no_adjacent_slots_ok: true,
      coverage: 0,
      ran_at: new Date().toISOString(),
      cli: 'aletheia test-pack --pack /tmp/faulty.yaml --samples /data/quarantine/fw01 --json',
    };
  }
  return {
    ok: true,
    samples: 412,
    reconstructed: 412,
    failures: [],
    type_validation_ok: true,
    golden_tests_ok: true,
    no_adjacent_slots_ok: true,
    coverage: 1,
    ran_at: new Date().toISOString(),
    cli: `aletheia test-pack --pack /data/packs/cisco_asa.v5.yaml --samples /data/quarantine/fw01 --json  # ${proposalId}`,
  };
}

function replayDiff(proposalId: string): ReplayDiff {
  const ai = proposalId.endsWith('_ai');
  return {
    proposal_id: proposalId,
    source_id: 'fw01',
    events_examined: 5000,
    from_version: 4,
    to_version: 5,
    newly_matched: 412,
    template_changed: 412,
    fields: [
      { path: 'src_endpoint.ip', changed: 412, before_example: null, after_example: '10.0.0.5' },
      { path: 'src_endpoint.port', changed: 412, before_example: null, after_example: '52190' },
      { path: 'dst_endpoint.ip', changed: 412, before_example: null, after_example: '203.0.113.5' },
      { path: 'connection_info.direction_id', changed: 412, before_example: null, after_example: '2' },
      ai
        ? { path: 'user.name', changed: 412, before_example: null, after_example: 'r.menon' }
        : { path: 'actor.user.name', changed: 412, before_example: null, after_example: 'r.menon' },
      ...(ai
        ? [{ path: 'connection_info.uid', changed: 412, before_example: '1301', after_example: '0:00:00' }]
        : []),
    ],
    regressions: ai
      ? [
        {
          event_uid: '01K5HQXH4W0X2Y4Z6A8B0C2D4E',
          from: 'full' as const,
          to: 'partial' as const,
          raw: '<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234 for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52144 (198.51.100.7/52144)',
        },
        {
          event_uid: '01K5HQXJ5X1Y3Z5A7B9C1D3E5F',
          from: 'full' as const,
          to: 'partial' as const,
          raw: '<166>Sep 19 14:31:03 fw01 %ASA-6-302013: Built outbound TCP connection 1235 for outside:93.184.216.34/80 (93.184.216.34/80) to inside:10.0.0.23/51344 (198.51.100.7/51344)',
        },
      ]
      : [],
    report_sha256: ai
      ? 'b41d9f0ca2de5c0b6a77ee2c3f1b0d4a8e9c7f2a1b3d5e7f9a1c3e5d7b9f1a3c'
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    cli: `aletheia replay --source fw01 --from-version 4 --to-version 5 --last 5000 --json  # ${proposalId}`,
  };
}

function approvalOf(proposalId: string): ApprovalState {
  return state.approvals[proposalId] ?? {
    proposal_id: proposalId,
    state: 'pending',
    approvals: [],
    required_approvals: 2,
  };
}

/* ---------------- demo actions ---------------- */

function demoOutput(id: string): { ok: boolean; output: string } {
  switch (id) {
    case 'scn0':
      return { ok: true, output: 'CONTAINER  STATUS\naletheia   Up 4 minutes (healthy)\nUI http://localhost:6156   Grafana http://localhost:6156/grafana/' };
    case 'scn1':
      state.trafficStarted = true;
      return { ok: true, output: 'generators started (seed 26156)\n  fw01 ASA   fgt01 FortiGate   cef01 CEF   proxy01 Squid\n  pf01 filterlog   vpn01 OpenVPN   ids01 Suricata   win01 winlog\nrate 500 eps' };
    case 'scn2':
      return { ok: true, output: 'event 01K5HQX3M8Z4V7N2P0R6T9WXYA\n  template asa_302013 (cisco_asa v4)\n  src_endpoint.ip <- slot ip_b, bytes [132,140)\n  open the lineage viewer to see the highlight' };
    case 'scn3':
      return state.tampered
        ? {
          ok: false,
          output: 'verify FAILED\n  batch fw01/p3/2026-09-19T14:31Z\n    event 01K5HQX3M8Z4V7N2P0R6T9WXYA: reconstructed hash mismatch\n      stored   raw_sha256 = ' + (RAW_SHA256['01K5HQX3M8Z4V7N2P0R6T9WXYA'] ?? '') + '\n      computed raw_sha256 = 7d1f0b2c9a4e6f8013245678abcdef90a1b2c3d4e5f60718293a4b5c6d7e8f90\n    merkle root differs from sealed root; chained root broken from this batch onward\n  1 batch failed, 1 event failed',
        }
        : { ok: true, output: 'verify OK\n  batches 15, events 7421, reconstructed 7421, verbatim 2\n  every recomputed root matches the sealed root and the signed anchor' };
    case 'scn3t':
      state.tampered = true;
      return { ok: true, output: 'ALTER TABLE events UPDATE vars[12] = \'10.0.0.6\' WHERE event_uid = \'01K5HQX3M8Z4V7N2P0R6T9WXYA\' SETTINGS mutations_sync = 2\nmutation applied directly in ClickHouse, bypassing Aletheia. Run Verify again.' };
    case 'scn4':
      return { ok: true, output: 'storage report (live from ClickHouse, 7,421,000 events)\n  raw + normalized copies      14.81 GB\n  compressed raw (zstd)         3.92 GB\n  Aletheia template + vars      1.14 GB\n  ratio vs raw+normalized       13.0x     vs compressed raw  3.4x' };
    case 'scn5':
      state.driftTriggered = true;
      return { ok: true, output: 'drift enabled on fw01 (variant asa_302013_v2)\n  412 events now raw_only + quarantined in 00:02:31\n  Studio clustered them as cl_asa_302013_v2' };
    case 'scn5b':
      return { ok: false, output: 'gate REJECTED\n  samples 412, reconstructed 0\n  sample 1: literal mismatch at byte offset 168\n  a pack that cannot rebuild the original byte for byte is never approved' };
    case 'scn5c':
      return state.settings.provider === 'none'
        ? { ok: false, output: 'no LLM provider configured. Set one on the Settings page, or run with ALETHEIA_LLM_PROVIDER=local and a local model.' }
        : { ok: true, output: `asked ${state.settings.provider}/${state.settings.model} (samples ${state.settings.send_samples})\n  1 request for the whole cluster, 0 on the hot path\n  suggestion returned and labelled ai:${state.settings.provider}/${state.settings.model}` };
    case 'scn6':
      return { ok: true, output: 'replay diff fw01 v4 -> v5 over 5000 events\n  newly matched 412 (raw_only -> full)\n  regressions 0\n  report sha256 e3b0c442...b855 recorded with the approval' };
    case 'scn7':
      return { ok: true, output: 'loki   {source_id="fw01", class="network_activity"} 412 lines/min\nkafka  topic normalized, 7 partitions, lag 0\ncef    re-emit to 127.0.0.1:1514, 498 eps' };
    case 'scn8':
      return { ok: true, output: 'bench (this machine)\n  workers 1   38,200 eps\n  workers 2   71,900 eps\n  workers 4  134,500 eps\nreference (team, 8 vCPU): 1/42,100  2/80,400  4/151,300 eps' };
    case 'scn9':
      return { ok: true, output: 'air-gap checklist\n  UI bundles all fonts, icons and JS: no external origins\n  ALETHEIA_AIRGAP=true refuses every cloud provider\n  outbound connections observed during the full demo: 0' };
    case 'scn10':
      return { ok: true, output: 'send any line to port 26514. Known formats normalize at once; unknown ones appear as a new quarantine cluster in the Studio.' };
    default:
      return { ok: false, output: `unknown scenario ${id}` };
  }
}

/* ---------------- alerting (CONTRACTS section 13), in-memory, seeded per 13.4 ---------------- */

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const mockUid = (): string => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
/** Error carrying an HTTP-like status, as the real client's ApiError would. */
const fail = (status: number, detail: string): Promise<never> =>
  Promise.reject(Object.assign(new Error(detail), { status }));

const SYNCED = (): Sync => ({ state: 'synced', at: isoAgo(40_000) });

function seedRule(id: string, r: Partial<AlertRule> & Pick<AlertRule, 'name' | 'datasource' | 'query' | 'condition' | 'severity' | 'summary'>): AlertRule {
  return {
    id, group: 'aletheia', reducer: 'last', for: '0s', interval: '1m', labels: {}, description: '',
    enabled: true, no_data_state: 'OK', created_at: isoAgo(86_400_000), updated_at: isoAgo(3_600_000),
    sync: SYNCED(), state: 'normal', last_value: 0, last_eval: isoAgo(20_000), ...r,
  };
}

/** A past browser delivery, `minAgo` minutes old, so the notification feed is not empty on first load. */
function seedNote(id: number, minAgo: number, status: AlertNotification['status'], source: AlertNotification['source'],
  ruleId: string | null, ruleName: string, severity: string, summary: string, value: number | null): AlertNotification {
  const at = isoAgo(minAgo * 60_000);
  return {
    id, received_at: at, status, source, rule_id: ruleId, rule_name: ruleName, severity, summary, description: '',
    labels: { alertname: ruleName, severity }, value, contact_point_id: 'browser', contact_point_name: 'Browser',
    starts_at: at, ends_at: status === 'resolved' ? at : null, link: null,
  };
}

const alerting = {
  rules: [
    seedRule('aletheia-reconstruct-mismatch', {
      name: 'Reconstruction mismatch', datasource: 'prometheus', severity: 'critical',
      query: 'sum(increase(aletheia_reconstruct_mismatch_total[5m]))', condition: { op: 'gt', threshold: 0 },
      summary: 'Reconstruction mismatch detected, must always be zero',
      description: 'Non-negotiable invariant: a reconstructed line differs from its raw bytes.',
    }),
    seedRule('aletheia-format-drift', {
      name: 'Format drift', datasource: 'prometheus', severity: 'warning', for: '2m',
      query: 'max(aletheia:quarantine_rate5m - (aletheia:quarantine_rate_baseline * 3 + 0.01))',
      condition: { op: 'gt', threshold: 0 }, state: 'pending', last_value: 0.04,
      summary: 'Quarantine rate above baseline, likely a firmware or config change',
    }),
    seedRule('aletheia-consumer-lag', {
      name: 'Consumer lag growing', datasource: 'prometheus', severity: 'warning', for: '5m',
      query: 'sum(aletheia_consumer_lag)', condition: { op: 'gt', threshold: 100000 }, last_value: 1240,
      summary: 'Consumer lag growing: add workers or partitions',
    }),
    seedRule('aletheia-raw-only-spike', {
      name: 'Raw-only lines spike', datasource: 'loki', severity: 'critical', reducer: 'last', for: '5m',
      query: 'sum(count_over_time({parse_status="raw_only"}[5m]))', condition: { op: 'gt', threshold: 100 },
      state: 'firing', last_value: 184, labels: { team: 'secops' },
      summary: '{{ $values }} lines in 5m matched no template',
      description: 'Stored verbatim, nothing lost, but a source may have changed format.',
    }),
    seedRule('secops-auth-failures', {
      name: 'Auth failure burst', group: 'security', datasource: 'loki', severity: 'warning', for: '1m', interval: '30s',
      query: 'sum by (source) (count_over_time({class_uid="3002", status="failure"}[5m]))',
      condition: { op: 'gt', threshold: 50 }, last_value: 12, labels: { team: 'secops' },
      summary: '{{ $labels.source }} saw {{ $values.B }} failed logins in 5m',
      description: 'Possible password spraying. Check the source IPs on the Events page.',
    }),
    seedRule('secops-denied-egress', {
      name: 'Denied egress to rare ports', group: 'security', datasource: 'clickhouse', severity: 'info', interval: '5m',
      query: "SELECT count() FROM aletheia.events\nWHERE disposition = 'Blocked' AND dst_port NOT IN (80, 443, 53)\n  AND event_time > now() - INTERVAL 5 MINUTE",
      condition: { op: 'gt', threshold: 25 }, state: 'error', last_value: null,
      last_error: 'code: 47, Unknown expression identifier `disposition` in scope SELECT count() FROM aletheia.events',
      summary: '{{ $values.A }} blocked connections to uncommon ports',
    }),
    seedRule('pipeline-ingest-stalled', {
      name: 'Ingest stalled', group: 'pipeline', datasource: 'prometheus', severity: 'critical', for: '3m',
      query: 'sum(rate(aletheia_lines_ingested_total[2m]))', condition: { op: 'lt', threshold: 1 },
      enabled: false, state: 'paused', last_value: null, last_eval: null, sync: { state: 'pending' },
      summary: 'No lines ingested for 3 minutes',
    }),
    seedRule('pipeline-dlq-growth', {
      name: 'Dead-letter queue growing', group: 'pipeline', datasource: 'prometheus', severity: 'warning', for: '10m',
      query: 'sum(delta(aletheia_dlq_messages[10m]))', condition: { op: 'gt', threshold: 0 },
      state: 'nodata', last_value: null, no_data_state: 'NoData',
      summary: 'Dead-letter queue grew by {{ $values.B }} in 10m',
    }),
  ] as AlertRule[],
  points: [{
    id: 'browser', name: 'Browser', type: 'browser', settings: {}, secure_fields: [],
    disable_resolve_message: false, builtin: true, created_at: isoAgo(86_400_000), updated_at: isoAgo(86_400_000), sync: SYNCED(),
  }, {
    id: 'secops-slack', name: 'SecOps Slack', type: 'slack', settings: { recipient: '#secops-alerts' }, secure_fields: ['url'],
    disable_resolve_message: false, builtin: false, created_at: isoAgo(43_200_000), updated_at: isoAgo(7_200_000), sync: SYNCED(),
  }, {
    id: 'oncall-email', name: 'On-call email', type: 'email', settings: { addresses: 'soc@example.com;oncall@example.com;lead@example.com', single_email: true },
    secure_fields: [], disable_resolve_message: true, builtin: false, created_at: isoAgo(43_200_000), updated_at: isoAgo(43_200_000), sync: SYNCED(),
  }, {
    id: 'ticket-webhook', name: 'Ticketing webhook', type: 'webhook', settings: { url: 'https://tickets.example.com/hooks/aletheia', http_method: 'POST' },
    secure_fields: [], disable_resolve_message: false, builtin: false, created_at: isoAgo(21_600_000), updated_at: isoAgo(21_600_000),
    sync: { state: 'error', error: 'Grafana rejected the receiver: connection refused', at: isoAgo(600_000) },
  }] as ContactPoint[],
  policy: {
    receiver: 'browser', group_by: ['alertname'], group_wait: '30s', group_interval: '5m', repeat_interval: '4h',
    // Two levels deep, with continue and an inheriting receiver, so the tree and routing preview have something to show.
    routes: [
      { id: 'route-critical', receiver: 'browser', matchers: [{ label: 'severity', op: '=', value: 'critical' }], continue: true, routes: [
        { id: 'route-critical-secops', receiver: 'secops-slack', matchers: [{ label: 'team', op: '=', value: 'secops' }], continue: false, group_wait: '10s', routes: [
          { id: 'route-raw-only', receiver: '', matchers: [{ label: 'alertname', op: '=~', value: 'Raw.*' }], continue: false, repeat_interval: '1h', routes: [] },
        ] },
      ] },
      { id: 'route-secops', receiver: 'oncall-email', matchers: [{ label: 'team', op: '=', value: 'secops' }], continue: false, group_by: ['alertname', 'team'], routes: [] },
      { id: 'route-warning', receiver: '', matchers: [{ label: 'severity', op: '=~', value: 'warning|info' }], continue: false, repeat_interval: '12h', routes: [] },
    ],
  } as NotificationPolicy,
  policySync: SYNCED(),
  notes: [
    seedNote(1, 95, 'firing', 'local', 'aletheia-format-drift', 'Format drift', 'warning', 'Quarantine rate above baseline, likely a firmware or config change', 0.07),
    seedNote(2, 52, 'resolved', 'local', 'aletheia-format-drift', 'Format drift', 'warning', 'Quarantine rate back to baseline', 0),
    seedNote(3, 40, 'firing', 'test', null, 'TestAlert', 'info', 'Test notification from Studio', null),
    seedNote(4, 6, 'firing', 'grafana', 'aletheia-raw-only-spike', 'Raw-only lines spike', 'critical', '184 lines in 5m matched no template', 184),
  ] as AlertNotification[],
  nextNote: 5,
  lastSync: isoAgo(40_000),
};

const MOCK_OPS: Record<AlertOp, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b, ne: (a, b) => a !== b,
};

/** Deterministic pseudo-value for a query, so previews are stable while typing. */
function mockValue(query: string): number {
  let h = 0;
  for (let i = 0; i < query.length; i++) h = (h * 31 + query.charCodeAt(i)) >>> 0;
  return h % 250;
}

function mockNotify(n: Omit<AlertNotification, 'id' | 'received_at'>): void {
  alerting.notes.push({ ...n, id: alerting.nextNote++, received_at: new Date().toISOString() });
  if (alerting.notes.length > 500) alerting.notes.splice(0, alerting.notes.length - 500);
}

function checkRule(b: AlertRuleInput, selfId?: string): string | null {
  if (!b.name?.trim()) return 'name is required';
  if (alerting.rules.some((r) => r.name === b.name.trim() && r.id !== selfId)) return `a rule named "${b.name}" already exists`;
  if (!b.query?.trim()) return 'query is required';
  if (!Number.isFinite(b.condition?.threshold)) return 'threshold must be a number';
  return null;
}

function checkPoint(b: ContactPointInput, selfId?: string): string | null {
  if (!b.name?.trim()) return 'name is required';
  if (alerting.points.some((p) => p.name === b.name.trim() && p.id !== selfId)) return `a contact point named "${b.name}" already exists`;
  const s = b.settings ?? {};
  if (b.type === 'webhook' && !String(s.url ?? '').trim()) return 'webhook url is required';
  if (b.type === 'email' && !String(s.addresses ?? '').trim()) return 'at least one address is required';
  return null;
}

const SECRET_KEYS = ['url', 'token'];

/** Applies the secret rules: omitted keeps, "" clears, a value sets. Secrets are never returned. */
function mergePoint(prev: ContactPoint | null, b: ContactPointInput): Pick<ContactPoint, 'settings' | 'secure_fields'> {
  const settings = { ...b.settings };
  if (b.type !== 'slack') return { settings, secure_fields: [] };
  const secure = new Set(prev?.type === 'slack' ? prev.secure_fields : []);
  for (const k of SECRET_KEYS) {
    if (!(k in settings)) continue;
    if (settings[k] === '') secure.delete(k); else secure.add(k);
    delete settings[k];
  }
  return { settings, secure_fields: [...secure] };
}

function routeReceivers(routes: PolicyRoute[], out: Set<string>): Set<string> {
  for (const r of routes) { if (r.receiver) out.add(r.receiver); routeReceivers(r.routes, out); }  // "" inherits
  return out;
}

function mockStatus(): AlertingStatus {
  const live = alerting.rules.filter((r) => r.enabled);
  return {
    mode: 'grafana',
    grafana: { url: 'http://grafana:3000', public_url: '/grafana', reachable: true, version: '11.2.0' },
    loki: { url: 'http://loki:3100', reachable: true },
    prometheus: { url: 'http://prometheus:9090', reachable: true },
    receiver_url: 'http://host.docker.internal:8081',
    last_sync_at: alerting.lastSync, last_sync_error: null,
    counts: {
      rules: alerting.rules.length,
      firing: live.filter((r) => r.state === 'firing').length,
      pending: live.filter((r) => r.state === 'pending').length,
      contact_points: alerting.points.length,
    },
  };
}

const alertingMocks = {
  async alertingStatus(): Promise<AlertingStatus> { return delay(mockStatus(), 120); },
  async alertingSync(): Promise<AlertingStatus> {
    alerting.lastSync = new Date().toISOString();
    for (const r of alerting.rules) r.sync = { state: 'synced', at: alerting.lastSync };
    for (const p of alerting.points) p.sync = { state: 'synced', at: alerting.lastSync };
    alerting.policySync = { state: 'synced', at: alerting.lastSync };
    return delay(mockStatus(), 600);
  },

  async listAlertRules(): Promise<{ rules: AlertRule[] }> {
    for (const r of alerting.rules) if (r.enabled && r.state !== 'error') r.last_eval = isoAgo(Math.floor(Math.random() * 50_000));
    return delay({ rules: clone(alerting.rules) });
  },
  async getAlertRule(id: string): Promise<AlertRule> {
    const r = alerting.rules.find((x) => x.id === id);
    return r ? delay(clone(r)) : fail(404, `rule ${id} not found`);
  },
  async createAlertRule(b: AlertRuleInput): Promise<AlertRule> {
    const bad = checkRule(b);
    if (bad) return fail(422, bad);
    const now = new Date().toISOString();
    const v = mockValue(b.query);
    const r: AlertRule = {
      ...clone(b), name: b.name.trim(), id: mockUid(), created_at: now, updated_at: now, sync: { state: 'synced', at: now },
      state: !b.enabled ? 'paused' : MOCK_OPS[b.condition.op](v, b.condition.threshold) ? 'pending' : 'normal',
      last_value: b.enabled ? v : null, last_eval: b.enabled ? now : null,
    };
    alerting.rules.push(r);
    return delay(clone(r), 300);
  },
  async updateAlertRule(id: string, b: AlertRuleInput): Promise<AlertRule> {
    const i = alerting.rules.findIndex((x) => x.id === id);
    if (i < 0) return fail(404, `rule ${id} not found`);
    const bad = checkRule(b, id);
    if (bad) return fail(422, bad);
    const prev = alerting.rules[i];
    const now = new Date().toISOString();
    const v = prev.last_value ?? mockValue(b.query);
    const next: AlertRule = {
      ...prev, ...clone(b), name: b.name.trim(), updated_at: now, sync: { state: 'synced', at: now },
      state: !b.enabled ? 'paused' : prev.state === 'paused' ? (MOCK_OPS[b.condition.op](v, b.condition.threshold) ? 'pending' : 'normal') : prev.state,
    };
    // Resuming or pausing a firing rule resolves it, and the browser point hears about it.
    if (prev.state === 'firing' && next.state === 'paused') {
      mockNotify({
        status: 'resolved', source: 'local', rule_id: id, rule_name: next.name, severity: next.severity, summary: next.summary,
        description: 'Rule paused.', labels: { ...next.labels, severity: next.severity }, value: prev.last_value,
        contact_point_id: 'browser', contact_point_name: 'Browser', starts_at: prev.last_eval, ends_at: now, link: null,
      });
    }
    alerting.rules[i] = next;
    return delay(clone(next), 250);
  },
  async deleteAlertRule(id: string): Promise<null> {
    if (!alerting.rules.some((r) => r.id === id)) return fail(404, `rule ${id} not found`);
    alerting.rules = alerting.rules.filter((r) => r.id !== id);
    return delay(null);
  },
  async previewAlertRule(b: AlertPreviewRequest): Promise<AlertPreview> {
    const q = b.query.trim();
    if (!q) return delay({ value: null, firing: false, error: 'query is empty', series: 0 }, 300);
    if (b.datasource === 'clickhouse' && !/^\s*(select|with)\b/i.test(q)) {
      return delay({ value: null, firing: false, error: 'ClickHouse query must be a SELECT returning one number', series: 0 }, 300);
    }
    if (b.datasource === 'loki' && !q.includes('{')) {
      return delay({ value: null, firing: false, error: 'parse error: a LogQL metric query needs a {stream selector}', series: 0 }, 300);
    }
    const value = mockValue(q);
    return delay({ value, firing: MOCK_OPS[b.condition.op](value, b.condition.threshold), series: 1 }, 450);
  },

  async listContactPoints(): Promise<{ contact_points: ContactPoint[] }> {
    return delay({ contact_points: clone(alerting.points) });
  },
  async createContactPoint(b: ContactPointInput): Promise<ContactPoint> {
    const bad = checkPoint(b);
    if (bad) return fail(422, bad);
    const now = new Date().toISOString();
    const p: ContactPoint = {
      id: mockUid(), name: b.name.trim(), type: b.type, disable_resolve_message: b.disable_resolve_message,
      builtin: false, created_at: now, updated_at: now, sync: { state: 'synced', at: now }, ...mergePoint(null, b),
    };
    alerting.points.push(p);
    return delay(clone(p), 250);
  },
  async updateContactPoint(id: string, b: ContactPointInput): Promise<ContactPoint> {
    const i = alerting.points.findIndex((x) => x.id === id);
    if (i < 0) return fail(404, `contact point ${id} not found`);
    const prev = alerting.points[i];
    if (prev.builtin && b.type !== prev.type) return fail(400, 'the builtin Browser contact point cannot change type');
    const bad = checkPoint(b, id);
    if (bad) return fail(422, bad);
    const now = new Date().toISOString();
    const next: ContactPoint = {
      ...prev, name: b.name.trim(), type: b.type, disable_resolve_message: b.disable_resolve_message,
      updated_at: now, sync: { state: 'synced', at: now }, ...mergePoint(prev, b),
    };
    alerting.points[i] = next;
    return delay(clone(next), 250);
  },
  async deleteContactPoint(id: string): Promise<null> {
    const p = alerting.points.find((x) => x.id === id);
    if (!p) return fail(404, `contact point ${id} not found`);
    if (p.builtin) return fail(409, 'the builtin Browser contact point cannot be deleted');
    const used = routeReceivers(alerting.policy.routes, new Set([alerting.policy.receiver]));
    if (used.has(id)) return fail(409, `contact point "${p.name}" is used by the notification policy tree; re-route it first`);
    alerting.points = alerting.points.filter((x) => x.id !== id);
    return delay(null);
  },
  async testContactPoint(id: string): Promise<{ ok: boolean; detail: string }> {
    const p = alerting.points.find((x) => x.id === id);
    if (!p) return fail(404, `contact point ${id} not found`);
    if (p.type === 'browser') {
      mockNotify({
        status: 'firing', source: 'test', rule_id: null, rule_name: 'Test notification', severity: 'info',
        summary: `Test delivery to ${p.name}`, description: 'If you can read this, browser notifications work.',
        labels: { alertname: 'TestAlert' }, value: null, contact_point_id: p.id, contact_point_name: p.name,
        starts_at: new Date().toISOString(), ends_at: null, link: null,
      });
      return delay({ ok: true, detail: 'Test notification queued; it appears within a few seconds.' }, 400);
    }
    if (p.type === 'slack' && !p.secure_fields.length) return delay({ ok: false, detail: 'slack: no webhook url or token configured' }, 500);
    return delay({ ok: true, detail: `Test sent to ${p.name} (${p.type}); fixture mode, nothing left the browser.` }, 600);
  },

  async getPolicies(): Promise<{ policy: NotificationPolicy; sync: Sync }> {
    return delay({ policy: clone(alerting.policy), sync: { ...alerting.policySync } });
  },
  async putPolicies(p: NotificationPolicy): Promise<{ policy: NotificationPolicy; sync: Sync }> {
    const known = new Set(alerting.points.map((x) => x.id));
    const unknown = [...routeReceivers(p.routes, new Set([p.receiver]))].find((r) => !known.has(r));
    if (unknown !== undefined) return fail(400, `unknown receiver id "${unknown}"`);
    alerting.policy = clone(p);
    alerting.policySync = { state: 'synced', at: new Date().toISOString() };
    return delay({ policy: clone(alerting.policy), sync: { ...alerting.policySync } }, 300);
  },

  async alertNotifications(after?: number, limit = 50): Promise<{ items: AlertNotification[]; last_id: number }> {
    const n = Math.min(200, Math.max(1, limit));
    const items = after === undefined ? alerting.notes.slice(-n) : alerting.notes.filter((x) => x.id > after).slice(0, n);
    // Cursor = last id returned; with nothing new, the newest id (as the Studio feed does).
    return delay({ items: clone(items), last_id: items.length ? items[items.length - 1].id : alerting.nextNote - 1 }, 80);
  },
};

/* ---------------- handlers ---------------- */

export const mockApi = {
  ...alertingMocks,

  async listEvents(q: EventQuery): Promise<EventPage> {
    let rows = BUILT.map((b) => b.event);
    if (!state.driftTriggered) rows = rows.filter((e) => e.aletheia.parse_status !== 'raw_only');
    if (q.source_id) rows = rows.filter((e) => e.aletheia.source_id === q.source_id);
    if (q.class_uid) rows = rows.filter((e) => e.class_uid === q.class_uid);
    if (q.parse_status) rows = rows.filter((e) => e.aletheia.parse_status === q.parse_status);
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
    }
    rows = [...rows].sort((a, b) => a.time - b.time);
    const classes = [...new Set(BUILT.map((b) => b.event.class_uid))]
      .map((class_uid) => ({ class_uid, name: CLASS_NAMES[class_uid] ?? String(class_uid) }));
    return delay({
      events: rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200)),
      total: rows.length,
      sources: [...new Set(BUILT.map((b) => b.event.aletheia.source_id))],
      classes,
    });
  },

  async getLineage(eventUid: string): Promise<LineageResponse> {
    const built = BUILT.find((b) => b.event.aletheia.event_uid === eventUid);
    if (!built) throw new Error(`event ${eventUid} not found`);
    const a = built.event.aletheia;
    return delay({
      event_uid: eventUid,
      raw: built.raw,
      raw_sha256: a.raw_sha256,
      verified: a.verified,
      storage_mode: a.storage_mode,
      parse_status: a.parse_status,
      template_id: a.template_id,
      pack: a.pack,
      pack_version: a.pack_version,
      merkle_batch: a.merkle_batch,
      tokens: built.tokens,
      vars: built.vars,
      spans: computeSpans(built.tokens, built.vars),
      field_map: built.field_map,
      event: built.event,
    });
  },

  async listClusters(): Promise<QuarantineCluster[]> {
    return delay(state.driftTriggered ? CLUSTERS : []);
  },

  async getProposal(clusterId: string): Promise<PackProposal> {
    if (clusterId !== 'cl_asa_302013_v2') throw new Error(`no proposal for ${clusterId} yet`);
    return delay(proposal('heuristic'));
  },

  async askAi(clusterId: string): Promise<AskAiResult> {
    const s = state.settings;
    if (s.provider === 'none') {
      return delay({
        ok: false,
        reason: 'no_provider' as const,
        error: 'No LLM provider is configured. The image ships without a key by design.',
      });
    }
    if (s.airgap && isCloudProvider(s.provider)) {
      return delay({
        ok: false,
        reason: 'airgap_blocked' as const,
        error: `Air-gap mode is on, so the cloud provider ${s.provider} is refused. Use provider 'local' pointed at a private address.`,
      });
    }
    if (isCloudProvider(s.provider) && !s.api_key_set) {
      return delay({
        ok: false,
        reason: 'no_provider' as const,
        error: `Provider ${s.provider} is selected but no API key is stored.`,
      });
    }
    state.settings = { ...s, usage: { ...s.usage, requests: s.usage.requests + 1, tokens: (s.usage.tokens ?? 0) + 2317 } };
    return delay(
      { ok: true, proposal: { ...proposal('ai:gemini/gemini-3.5-flash-lite'), cluster_id: clusterId }, provider: s.provider, model: s.model },
      900,
    );
  },

  async runGate(proposalId: string, faulty = false): Promise<GateResult> {
    return delay(gateResult(proposalId, faulty), 600);
  },

  async runReplay(proposalId: string): Promise<ReplayDiff> {
    return delay(replayDiff(proposalId), 800);
  },

  async getApproval(proposalId: string): Promise<ApprovalState> {
    return delay(approvalOf(proposalId));
  },

  async approve(proposalId: string, approver: string, reportSha: string): Promise<ApprovalState> {
    const cur = approvalOf(proposalId);
    if (cur.approvals.some((a) => a.approver === approver)) {
      throw new Error('Two-person approval: the second approval must come from a different operator.');
    }
    const approvals = [...cur.approvals, { approver, at: new Date().toISOString(), report_sha256: reportSha }];
    const next: ApprovalState = {
      ...cur,
      approvals,
      state: approvals.length >= cur.required_approvals ? 'approved' : 'awaiting_second_approval',
    };
    state.approvals[proposalId] = next;
    return delay(next);
  },

  async reject(proposalId: string, approver: string, reason: string): Promise<ApprovalState> {
    const next: ApprovalState = {
      ...approvalOf(proposalId),
      state: 'rejected',
      rejection: { approver, at: new Date().toISOString(), reason },
    };
    state.approvals[proposalId] = next;
    return delay(next);
  },

  async getSettings(): Promise<LlmSettings> {
    return delay(state.settings);
  },

  async putSettings(update: LlmSettingsUpdate): Promise<LlmSettings> {
    const prev = state.settings;
    if (prev.airgap && isCloudProvider(update.provider)) {
      throw new Error(`Air-gap mode refuses cloud provider ${update.provider}.`);
    }
    if (update.send_samples === 'raw' && isCloudProvider(update.provider)) {
      throw new Error('send_samples=raw is rejected for cloud providers (spec 8.12.5).');
    }
    const keyGiven = update.api_key !== undefined && update.api_key !== '';
    const keyCleared = update.api_key === '';
    state.settings = {
      ...prev,
      provider: update.provider,
      model: update.model,
      base_url: update.base_url,
      send_samples: update.send_samples,
      api_key_last4: keyGiven ? update.api_key!.slice(-4) : keyCleared ? null : prev.api_key_last4,
      api_key_set: keyGiven ? true : keyCleared ? false : prev.api_key_set,
      sources: {
        provider: 'db', model: 'db', base_url: 'db', send_samples: 'db',
        api_key: keyGiven ? 'db' : prev.sources.api_key,
      },
      updated_at: new Date().toISOString(),
    };
    return delay(state.settings, 250);
  },

  /** Demo-only toggle so the air-gap refusal is visible without restarting a container. */
  async setAirgap(on: boolean): Promise<LlmSettings> {
    state.settings = { ...state.settings, airgap: on };
    return delay(state.settings, 100);
  },

  async resetSettings(): Promise<LlmSettings> {
    state.settings = { ...state.settings, airgap: false };
    return delay(state.settings, 100);
  },

  async testConnection(): Promise<ConnTest> {
    const s = state.settings;
    const base = { provider: s.provider, model: s.model };
    if (s.provider === 'none') {
      return delay({ ...base, ok: false, latency_ms: 0, json_mode: null, models: [], error: 'Provider is none: nothing to test.' });
    }
    if (s.airgap && isCloudProvider(s.provider)) {
      return delay({ ...base, ok: false, latency_ms: 0, json_mode: null, models: [], error: `Air-gap mode refuses cloud provider ${s.provider}.` });
    }
    if (isCloudProvider(s.provider) && !s.api_key_set) {
      return delay({ ...base, ok: false, latency_ms: 0, json_mode: null, models: [], error: 'No API key stored for this provider.' }, 300);
    }
    if (s.provider === 'gemini') {
      return delay({
        ...base, ok: true, latency_ms: 812, json_mode: 'schema' as const,
        models: ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'], error: null,
      }, 900);
    }
    if (s.provider === 'local') {
      return delay({
        ...base, ok: true, latency_ms: 143, json_mode: 'json_object' as const,
        models: ['qwen2.5-coder:7b', 'llama3.1:8b'], error: null,
      }, 600);
    }
    return delay({ ...base, ok: true, latency_ms: 410, json_mode: 'schema' as const, models: [s.model], error: null }, 700);
  },

  async listScenarios(): Promise<DemoScenario[]> {
    return delay(SCENARIOS);
  },

  async runScenario(id: string): Promise<DemoRunResult> {
    const started = Date.now();
    const { ok, output } = demoOutput(id);
    const scenario = SCENARIOS.find((s) => s.id === id);
    return delay({
      scenario_id: id,
      ok,
      started_at: new Date(started).toISOString(),
      duration_ms: 420,
      output,
      link: scenario?.link ?? null,
    }, 500);
  },

  async resetDemo(): Promise<{ ok: boolean; output: string }> {
    const airgap = state.settings.airgap;
    state = freshState();
    state.settings.airgap = airgap;
    return delay({ ok: true, output: 'demo state restored: tampered byte reverted, approvals cleared, generators reseeded (seed 26156).' }, 600);
  },

  mockSupplyState: {
    active: true,
    enabled: true,
    mode: 'listen',
    target: '',
    host: '127.0.0.1',
    port: 9099,
    log_type: 'raw',
    source_id: '',
    allow: [],
    clients_count: 2,
    clients: [
      { addr: '127.0.0.1:52144', connected_at: Date.now() / 1000 - 1800, lines: 9120, bytes: 1120400, dropped: 0, queued: 0 },
      { addr: '127.0.0.1:52210', connected_at: Date.now() / 1000 - 600, lines: 5700, bytes: 724620, dropped: 0, queued: 0 },
    ],
    lines_sent: 14820,
    bytes_sent: 1845020,
    dropped_lines: 0,
    refused: 0,
    started_at: Date.now() / 1000 - 3600,
    last_error: '',
    bus: true,
  } as SupplyStatus,

  async getSupplyStatus() {
    return delay(this.mockSupplyState, 200);
  },

  async configureSupply(b: SupplyConfigUpdate) {
    const { enabled, ...rest } = b;
    Object.assign(this.mockSupplyState, rest);
    if (enabled !== undefined) {
      this.mockSupplyState.enabled = enabled;
      this.mockSupplyState.active = enabled;
    }
    return delay({ ...this.mockSupplyState }, 300);
  },
};

