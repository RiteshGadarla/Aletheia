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
  model: 'gemma-4-31b-it',
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
    ? { ...m, ocsf_path: 'user.name', confidence: 0.84, origin: 'ai:gemini/gemma-4-31b-it' as const, evidence: 'Literal "user " immediately precedes the slot; values look like account names (r.menon, a.iyer, svc_backup).' }
    : { ...m, origin: 'ai:gemini/gemma-4-31b-it' as const },
).concat([
  { slot: 'duration', ocsf_path: 'connection_info.uid', confidence: 0.41, origin: 'ai:gemini/gemma-4-31b-it', evidence: 'Low confidence: h:mm:ss shape; the model suggested reusing the connection id field, which the reviewer should reject.' },
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

function proposal(origin: 'heuristic' | 'ai:gemini/gemma-4-31b-it'): PackProposal {
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
      return { ok: true, output: 'CONTAINER  STATUS\naletheia   Up 4 minutes (healthy)\nUI http://localhost:8080   Grafana http://localhost:3000' };
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
      return { ok: true, output: 'send any line to port 5514. Known formats normalize at once; unknown ones appear as a new quarantine cluster in the Studio.' };
    default:
      return { ok: false, output: `unknown scenario ${id}` };
  }
}

/* ---------------- handlers ---------------- */

export const mockApi = {
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
      { ok: true, proposal: { ...proposal('ai:gemini/gemma-4-31b-it'), cluster_id: clusterId }, provider: s.provider, model: s.model },
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
        models: ['gemma-4-31b-it', 'gemini-2.5-flash', 'gemini-2.5-pro'], error: null,
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
};
