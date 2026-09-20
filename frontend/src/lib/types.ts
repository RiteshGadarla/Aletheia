// Types mirror docs/CONTRACTS.md. Section references below point at that file.

/* ---------- CONTRACTS section 1: template token model ---------- */

export const SLOT_TYPES = [
  'int', 'port', 'ipv4', 'ipv6', 'ip', 'mac', 'hostname',
  'syslog3164_ts', 'iso8601_ts', 'epoch_ts', 'enum', 'word',
  'quoted', 'ws', 'text', 'custom',
] as const;

export type SlotType = (typeof SLOT_TYPES)[number];

export interface Token {
  lit?: string;
  slot?: string;
  type?: SlotType;
  values?: string[];
  pattern?: string;
}

export const isLit = (t: Token): boolean => !t.slot;

/** Byte span, [start, end). CONTRACTS section 1 / spec 8.4. */
export type Span = [number, number];

/* ---------- CONTRACTS section 5: normalized event ---------- */

export type ParseStatus = 'full' | 'partial' | 'raw_only';
export type StorageMode = 'template' | 'verbatim';

export interface AletheiaBlock {
  event_uid: string;
  source_id: string;
  parse_status: ParseStatus;
  storage_mode: StorageMode;
  template_id: string;
  pack: string;
  pack_version: number;
  raw_sha256: string;
  verified: boolean;
  merkle_batch: string;
}

export interface OcsfMetadata {
  version: string;
  uid: string;
  original_time: string;
  product: { vendor_name: string; name: string };
  log_name: string;
}

export interface Endpoint {
  ip?: string;
  port?: number;
  interface_name?: string;
  hostname?: string;
}

/** OCSF 1.x object plus the aletheia provenance block. */
export interface NormalizedEvent {
  class_uid: number;
  category_uid: number;
  activity_id: number;
  type_uid: number;
  time: number; // epoch milliseconds
  severity_id: number;
  action_id?: number;
  status_id?: number;
  message?: string;
  src_endpoint?: Endpoint;
  dst_endpoint?: Endpoint;
  connection_info?: { uid?: string; protocol_name?: string; direction_id?: number };
  traffic?: { bytes_in?: number; bytes_out?: number };
  http_request?: { url?: { text?: string }; http_method?: string };
  actor?: { user?: { name?: string } };
  user?: { name?: string };
  metadata: OcsfMetadata;
  unmapped: Record<string, string>;
  aletheia: AletheiaBlock;
  [k: string]: unknown;
}

/* ---------- Lineage (spec 6.14 / 8.4) ---------- */

export interface LineageResponse {
  event_uid: string;
  /** Reconstructed raw line, byte-identical to what arrived. */
  raw: string;
  raw_sha256: string;
  verified: boolean;
  storage_mode: StorageMode;
  parse_status: ParseStatus;
  template_id: string;
  pack: string;
  pack_version: number;
  merkle_batch: string;
  tokens: Token[];
  vars: string[];
  /** slot name -> byte span in raw. Recomputed on demand, never stored. */
  spans: Record<string, Span>;
  /** OCSF dotted path -> slot name. */
  field_map: Record<string, string>;
  event: NormalizedEvent;
}

/* ---------- Events explorer ---------- */

export interface EventQuery {
  source_id?: string;
  class_uid?: number;
  parse_status?: ParseStatus;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface EventPage {
  events: NormalizedEvent[];
  total: number;
  sources: string[];
  classes: { class_uid: number; name: string }[];
}

/* ---------- Studio (spec 8.6 - 8.11) ---------- */

export interface QuarantineCluster {
  cluster_id: string;
  source_id: string;
  sample_count: number;
  first_seen: string; // RFC3339
  last_seen: string;
  drain_template: string;
  samples: string[];
  proposal_id?: string;
}

export type ProposalOrigin = 'heuristic' | `ai:${string}`;

export interface SlotSample {
  slot: string;
  type: SlotType;
  examples: string[];
}

export interface MappingProposal {
  slot: string;
  ocsf_path: string;
  confidence: number; // 0..1
  evidence: string;
  origin: ProposalOrigin;
  enum_map?: Record<string, number>;
  transform?: 'to_int' | 'to_ip' | 'lowercase' | 'ts_parse';
}

export interface PackProposal {
  proposal_id: string;
  cluster_id: string;
  source_id: string;
  pack: string;
  template_id: string;
  pack_version: number;
  origin: ProposalOrigin;
  tokens: Token[];
  slots: SlotSample[];
  class_uid: number;
  activity_id: number;
  mappings: MappingProposal[];
  unmapped_keep: string[];
  created_at: string;
}

/** CONTRACTS section 8: `aletheia test-pack --json` output, surfaced verbatim. */
export interface GateFailure {
  sample: string;
  reason: string;
  offset: number;
}

export interface GateResult {
  ok: boolean;
  samples: number;
  reconstructed: number;
  failures: GateFailure[];
  /** Additional gate checks, spec 8.9 items 2-5. */
  type_validation_ok: boolean;
  golden_tests_ok: boolean;
  no_adjacent_slots_ok: boolean;
  coverage: number; // 0..1 of this source's quarantined lines now matched
  ran_at: string;
  cli: string;
}

export interface FieldDiff {
  path: string;
  changed: number;
  before_example: string | null;
  after_example: string | null;
}

export interface ReplayDiff {
  proposal_id: string;
  source_id: string;
  events_examined: number;
  from_version: number;
  to_version: number;
  newly_matched: number; // raw_only -> full/partial
  template_changed: number;
  fields: FieldDiff[];
  /** full -> partial/raw_only. Blocking (spec 8.10). */
  regressions: { event_uid: string; from: ParseStatus; to: ParseStatus; raw: string }[];
  report_sha256: string;
  cli: string;
}

export interface ApprovalState {
  proposal_id: string;
  state: 'pending' | 'awaiting_second_approval' | 'approved' | 'rejected';
  approvals: { approver: string; at: string; report_sha256: string }[];
  required_approvals: number;
  rejection?: { approver: string; at: string; reason: string };
}

export interface AskAiResult {
  ok: boolean;
  proposal?: PackProposal;
  /** Populated when no provider is configured or the call failed. */
  error?: string;
  reason?: 'no_provider' | 'airgap_blocked' | 'invalid_output' | 'transport';
  provider?: string;
  model?: string;
}

/* ---------- Settings (CONTRACTS section 9 / spec 8.12.8) ---------- */

/** Exactly three, matching backend studio.core.settings.PROVIDERS.
 *  `local` covers Ollama, vLLM, llama.cpp and LM Studio: same OpenAI-compatible API,
 *  distinguished by base URL, not by provider name. */
export const PROVIDERS = ['none', 'gemini', 'local'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type SendSamples = 'masked' | 'none' | 'raw';

/** Which layer supplied a value: PostgreSQL settings > env > default. */
export type SettingSource = 'db' | 'env' | 'default';

export interface LlmSettings {
  provider: Provider;
  model: string;
  base_url: string;
  send_samples: SendSamples;
  /** Last four characters of the stored key. The API never returns the key. */
  api_key_last4: string | null;
  api_key_set: boolean;
  airgap: boolean;
  sources: Partial<Record<'provider' | 'model' | 'base_url' | 'send_samples' | 'api_key', SettingSource>>;
  usage: { requests: number; tokens: number | null; window: string; cap_per_hour: number };
  updated_at: string | null;
}

export interface LlmSettingsUpdate {
  provider: Provider;
  model: string;
  base_url: string;
  send_samples: SendSamples;
  /** Write-only. Omit to keep the stored key, empty string to clear it. */
  api_key?: string;
}

/** Provider.test_connection() result, CONTRACTS section 9. */
export interface ConnTest {
  ok: boolean;
  latency_ms: number;
  json_mode: 'schema' | 'json_object' | 'prompt' | null;
  models: string[];
  error: string | null;
  provider: Provider;
  model: string;
}

/** Gemini is the only provider that leaves the machine. */
export const CLOUD_PROVIDERS: Provider[] = ['gemini'];
export const isCloudProvider = (p: Provider): boolean => CLOUD_PROVIDERS.includes(p);

export const PROVIDER_DEFAULTS: Record<Provider, { model: string; base_url: string }> = {
  none: { model: '', base_url: '' },
  gemini: { model: 'gemma-4-31b-it', base_url: 'https://generativelanguage.googleapis.com/v1beta' },
  local: { model: '', base_url: 'http://localhost:11434/v1' },
};

/* ---------- Pack verification (GET /packs/verify) ---------- */

export interface PackVerify {
  ok: boolean;
  samples: number;
  reconstructed: number;
  normalized: number;
  failures: number;
}

/* ---------- Demo console (spec 21) ---------- */

export interface DemoScenario {
  id: string;
  number: number;
  title: string;
  action_label: string;
  /** What this scenario proves. */
  proves: string;
  expected: string;
  /** In-app route or external URL where the result is visible. */
  link: { label: string; href: string; external?: boolean } | null;
  /** The equivalent CLI command, shown in the open (spec 21.1). */
  cli: string;
  requirements: string[];
  /** false for scenarios the evaluator performs outside the UI (0, 9, 10). */
  runnable: boolean;
}

export interface DemoRunResult {
  scenario_id: string;
  ok: boolean;
  started_at: string;
  duration_ms: number;
  output: string;
  link?: { label: string; href: string; external?: boolean } | null;
}

/* ---- sources: connect, collect raw, approve mappings ---- */
export type SourceState = 'collecting' | 'review' | 'approved' | 'rejected';

export interface SourceInfo {
  id: string; name: string; type: string; config: Record<string, unknown>; enabled: boolean;
  state: SourceState; attempts: number; status: string; error: string; lines: number; bytes: number;
  errors: number; eps: number; last_seen: number | null; by_severity: Record<string, number>;
  has_proposal: boolean; ready_for_review: boolean;
  history: { at: number; action: string; actor: string; reason?: string; feedback?: string }[];
}

export interface SourceList { store: string; bus: boolean; types: string[]; sources: SourceInfo[] }

export interface MappingRow {
  slot: string; type: string; sample: string; path: string | null; confidence: number;
  transform: string | null; evidence: string[];
}

export interface SourceCluster {
  cluster_id: string; size: number; share: number; samples: string[]; format: string; warnings: string[];
  mapping: { class_uid: number; class_name: string; activity_id: number; confidence: number; origin: string; rows: MappingRow[] };
  gate: { ok: boolean; reconstructed?: number; samples?: number; error?: string } | null;
}

export interface SourceProposal {
  source_id: string; attempt: number; sim_th: number; class_hint: number | null; feedback: string;
  lines_examined: number; covered: number; clusters: SourceCluster[];
}

export interface RawLine { ts_ns: number; line: string; severity: string }
