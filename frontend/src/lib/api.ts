// Single typed entry point for every backend call. Shapes follow docs/CONTRACTS.md
// sections 5, 8 and 9. With VITE_USE_MOCKS=1 the fixture implementation is used instead,
// so every page renders and demos standalone while the backend is still being built.

import { mockApi } from './mocks';
import type {
  ApprovalState, AskAiResult, ConnTest, DemoRunResult, DemoScenario, EventPage, EventQuery,
  GateResult, LineageResponse, LlmSettings, LlmSettingsUpdate, PackProposal, PackVerify,
  Overview, QuarantineCluster, RawLine, SampleList, SampleServer, ReplayDiff, SourceInfo, SourceList, SourceProposal,
  ExportReportParams, ExportLogsParams, SupplyStatus, SupplyConfigUpdate, DownloadResult, ChatMessage, ChatReply,
  ChatSessionSummary, ChatSession, ChatExportFormat,
  AlertingStatus, AlertRule, AlertRuleInput, AlertPreview, AlertPreviewRequest, ContactPoint, ContactPointInput,
  NotificationPolicy, Sync, AlertNotification,
} from './types';

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === '1';
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Almost always the dev proxy missing, so the HTML shell came back instead of JSON.
      throw new ApiError(
        `${path} returned ${res.status} ${res.headers.get('content-type') ?? 'unknown type'}, not JSON. `
        + 'Is the Studio API running on :8081? Try `make studio`.',
        res.status,
        text.slice(0, 200),
      );
    }
  }
  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : res.statusText;
    throw new ApiError(detail, res.status, body);
  }
  return body as T;
}

/** Masking and mapping can come back in a blink on small samples, too fast to read. */
const MASK_MIN_MS = 2000;

/** Resolves with the call's result, never before `ms` has passed. Failures surface at once. */
async function atLeast<T>(ms: number, work: Promise<T>): Promise<T> {
  const [out] = await Promise.all([work, new Promise((r) => setTimeout(r, ms))]);
  return out;
}

const qs = (q: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  /* events explorer */
  listEvents: (q: EventQuery = {}): Promise<EventPage> =>
    USE_MOCKS ? mockApi.listEvents(q) : http(`/events${qs({ ...q })}`),

  /* lineage viewer, spec 6.14 and 8.4 */
  getLineage: (eventUid: string): Promise<LineageResponse> =>
    USE_MOCKS ? mockApi.getLineage(eventUid) : http(`/events/${encodeURIComponent(eventUid)}/lineage`),

  /* onboarding studio, spec 8.6 to 8.11 */
  listClusters: (): Promise<QuarantineCluster[]> =>
    USE_MOCKS ? mockApi.listClusters() : http('/studio/clusters'),

  getProposal: (clusterId: string): Promise<PackProposal> =>
    USE_MOCKS ? mockApi.getProposal(clusterId) : http(`/studio/clusters/${encodeURIComponent(clusterId)}/proposal`),

  askAi: (clusterId: string): Promise<AskAiResult> =>
    USE_MOCKS
      ? mockApi.askAi(clusterId)
      : http(`/studio/clusters/${encodeURIComponent(clusterId)}/ask-ai`, { method: 'POST' }),

  runGate: (proposalId: string, faulty = false): Promise<GateResult> =>
    USE_MOCKS
      ? mockApi.runGate(proposalId, faulty)
      : http(`/studio/proposals/${encodeURIComponent(proposalId)}/gate`, {
        method: 'POST',
        body: JSON.stringify({ faulty }),
      }),

  runReplay: (proposalId: string): Promise<ReplayDiff> =>
    USE_MOCKS
      ? mockApi.runReplay(proposalId)
      : http(`/studio/proposals/${encodeURIComponent(proposalId)}/replay`, { method: 'POST' }),

  getApproval: (proposalId: string): Promise<ApprovalState> =>
    USE_MOCKS ? mockApi.getApproval(proposalId) : http(`/studio/proposals/${encodeURIComponent(proposalId)}/approval`),

  approve: (proposalId: string, approver: string, reportSha256: string): Promise<ApprovalState> =>
    USE_MOCKS
      ? mockApi.approve(proposalId, approver, reportSha256)
      : http(`/studio/proposals/${encodeURIComponent(proposalId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approver, report_sha256: reportSha256 }),
      }),

  reject: (proposalId: string, approver: string, reason: string): Promise<ApprovalState> =>
    USE_MOCKS
      ? mockApi.reject(proposalId, approver, reason)
      : http(`/studio/proposals/${encodeURIComponent(proposalId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ approver, reason }),
      }),

  /* dashboard stats */
  overview: (): Promise<Overview> => http('/stats/overview'),

  /* demo sample servers */
  listSamples: (): Promise<SampleList> => http('/demo/samples'),
  startSample: (id: string): Promise<SampleServer> => http(`/demo/samples/${id}/start`, { method: 'POST' }),
  sampleLogs: (id: string, after = -1): Promise<{ items: { cursor: number; ts: number; severity: string; line: string }[]; next: number }> =>
    http(`/demo/samples/${id}/logs?after=${after}`),
  stopSample: (id: string): Promise<SampleServer> => http(`/demo/samples/${id}/stop`, { method: 'POST' }),
  controlSample: (id: string, b: { rate?: number; risk?: number; clear_risk?: boolean; paused?: boolean; drift?: boolean }): Promise<SampleServer> =>
    http(`/demo/samples/${id}/control`, { method: 'POST', body: JSON.stringify(b) }),

  /* sources */
  listSources: (): Promise<SourceList> => http('/sources'),
  createSource: (b: { id: string; type: string; config: Record<string, unknown> }): Promise<SourceInfo> =>
    http('/sources', { method: 'POST', body: JSON.stringify(b) }),
  patchSource: (id: string, b: { enabled?: boolean }): Promise<SourceInfo> =>
    http(`/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteSource: (id: string): Promise<unknown> => http(`/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sourceRaw: (id: string, q = '', severity = ''): Promise<{ lines: RawLine[] }> =>
    http(`/sources/${encodeURIComponent(id)}/raw${qs({ limit: 50, q, severity })}`),
  sourceReview: (id: string): Promise<{ source: SourceInfo; proposal: SourceProposal | null }> =>
    http(`/sources/${encodeURIComponent(id)}/review`),
  sourcePropose: (id: string): Promise<SourceProposal> =>
    atLeast(MASK_MIN_MS, http(`/sources/${encodeURIComponent(id)}/propose`, { method: 'POST', body: '{}' })),
  sourceDecide: (id: string, b: { action: 'approve' | 'reject' | 'retry'; approver: string; reason?: string; feedback?: string; class_hint?: number }): Promise<{ source: SourceInfo; proposal?: SourceProposal; backfilled?: number; packs?: string[]; bus?: boolean }> =>
    http(`/sources/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(b) }),

  /* settings, CONTRACTS section 9 and spec 8.12.8 */
  getSettings: (): Promise<LlmSettings> => (USE_MOCKS ? mockApi.getSettings() : http('/settings/llm')),

  putSettings: (update: LlmSettingsUpdate): Promise<LlmSettings> =>
    USE_MOCKS ? mockApi.putSettings(update) : http('/settings/llm', { method: 'PUT', body: JSON.stringify(update) }),

  testConnection: (): Promise<ConnTest> =>
    USE_MOCKS ? mockApi.testConnection() : http('/settings/llm/test', { method: 'POST' }),

  setAirgap: (on: boolean): Promise<LlmSettings> =>
    USE_MOCKS ? mockApi.setAirgap(on) : http('/settings/airgap', { method: 'POST', body: JSON.stringify({ airgap: on }) }),

  resetSettings: (): Promise<LlmSettings> =>
    USE_MOCKS ? mockApi.resetSettings() : http('/settings/reset', { method: 'POST' }),

  /* demo console, spec 21 */
  listScenarios: (): Promise<DemoScenario[]> => (USE_MOCKS ? mockApi.listScenarios() : http('/demo/scenarios')),

  runScenario: (id: string): Promise<DemoRunResult> =>
    USE_MOCKS ? mockApi.runScenario(id) : http(`/demo/scenarios/${encodeURIComponent(id)}/run`, { method: 'POST' }),

  resetDemo: (): Promise<{ ok: boolean; output: string }> =>
    USE_MOCKS ? mockApi.resetDemo() : http('/demo/reset', { method: 'POST' }),

  health: (): Promise<{ status: string }> =>
    USE_MOCKS ? Promise.resolve({ status: 'ready' }) : http('/health'),

  /* pack self-check, used by the sidebar health indicator */
  verifyPacks: (): Promise<PackVerify> =>
    USE_MOCKS
      ? Promise.resolve({ ok: true, samples: 30, reconstructed: 30, normalized: 30, failures: 0 })
      : http('/packs/verify'),

  /* export & log supply stream */
  exportReportUrl: (p: ExportReportParams = {}): string =>
    `${BASE}/export/report${qs({ format: p.format, source_id: p.source_id, window_s: p.window_s, categories: p.categories })}`,

  exportLogsUrl: (p: ExportLogsParams = {}): string =>
    `${BASE}/export/logs${qs({ log_type: p.log_type, format: p.format, source_id: p.source_id, severity: p.severity, q: p.q, limit: p.limit, since_s: p.since_s || undefined })}`,

  /** Fetch an export and save it; a failed export throws its reason instead of opening an error page. */
  download: async (url: string): Promise<DownloadResult> => {
    const res = await fetch(url);
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = String((await res.json()).detail ?? detail); } catch { /* not JSON */ }
      throw new ApiError(detail, res.status);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'aletheia-export';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    const count = res.headers.get('x-aletheia-record-count');
    return { filename, bytes: blob.size, count: count === null ? null : Number(count), sha256: res.headers.get('x-aletheia-sha256') };
  },

  getSupplyStatus: (): Promise<SupplyStatus> =>
    USE_MOCKS ? mockApi.getSupplyStatus() : http('/export/supply/status'),

  chat: (messages: ChatMessage[], sessionId?: string, title?: string): Promise<ChatReply> =>
    USE_MOCKS
      ? Promise.resolve({ available: false, answer: 'Lyra needs the live backend.', blocks: [] })
      : http('/chat', { method: 'POST', body: JSON.stringify({ messages, session_id: sessionId, title }) }),

  chatStream: async (
    messages: ChatMessage[],
    sessionId: string | undefined,
    onStep: (step: string) => void,
    onDone: (reply: ChatReply) => void,
    onError: (err: unknown) => void,
  ) => {
    if (USE_MOCKS) {
      onDone({ available: false, answer: 'Lyra needs the live backend.', blocks: [] });
      return;
    }
    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, session_id: sessionId }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Stream HTTP error ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed.startsWith('data: ')) {
            try {
              const evt = JSON.parse(trimmed.slice(6));
              if (evt.type === 'step' && evt.step) {
                onStep(evt.step);
              } else if (evt.type === 'done') {
                onDone(evt);
              }
            } catch {
              // silent ignore invalid chunk
            }
          }
        }
      }
    } catch (err) {
      try {
        const reply = await api.chat(messages, sessionId);
        onDone(reply);
      } catch (fallbackErr) {
        onError(fallbackErr);
      }
    }
  },

  listChatSessions: (): Promise<{ sessions: ChatSessionSummary[] }> =>
    USE_MOCKS ? Promise.resolve({ sessions: [] }) : http('/chat/sessions'),

  getChatSession: (sessionId: string): Promise<ChatSession> =>
    USE_MOCKS ? Promise.resolve({ id: sessionId, title: 'Mock Chat', created_at: '', updated_at: '', messages: [] }) : http(`/chat/sessions/${encodeURIComponent(sessionId)}`),

  deleteChatSession: (sessionId: string): Promise<{ ok: boolean }> =>
    USE_MOCKS ? Promise.resolve({ ok: true }) : http(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  clearChatSessions: (): Promise<{ ok: boolean }> =>
    USE_MOCKS ? Promise.resolve({ ok: true }) : http('/chat/sessions', { method: 'DELETE' }),

  exportChatUrl: (sessionId?: string, format: ChatExportFormat = 'pdf'): string =>
    `${BASE}/chat/export${qs({ session_id: sessionId, format })}`,

  configureSupply: (b: SupplyConfigUpdate): Promise<SupplyStatus> =>
    USE_MOCKS ? mockApi.configureSupply(b) : http('/export/supply/configure', { method: 'POST', body: JSON.stringify(b) }),

  /* alerting, CONTRACTS section 13 */
  alertingStatus: (): Promise<AlertingStatus> =>
    USE_MOCKS ? mockApi.alertingStatus() : http('/alerting/status'),
  alertingSync: (): Promise<AlertingStatus> =>
    USE_MOCKS ? mockApi.alertingSync() : http('/alerting/sync', { method: 'POST' }),

  listAlertRules: (): Promise<{ rules: AlertRule[] }> =>
    USE_MOCKS ? mockApi.listAlertRules() : http('/alerting/rules'),
  getAlertRule: (id: string): Promise<AlertRule> =>
    USE_MOCKS ? mockApi.getAlertRule(id) : http(`/alerting/rules/${encodeURIComponent(id)}`),
  createAlertRule: (b: AlertRuleInput): Promise<AlertRule> =>
    USE_MOCKS ? mockApi.createAlertRule(b) : http('/alerting/rules', { method: 'POST', body: JSON.stringify(b) }),
  updateAlertRule: (id: string, b: AlertRuleInput): Promise<AlertRule> =>
    USE_MOCKS ? mockApi.updateAlertRule(id, b) : http(`/alerting/rules/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteAlertRule: (id: string): Promise<unknown> =>
    USE_MOCKS ? mockApi.deleteAlertRule(id) : http(`/alerting/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewAlertRule: (b: AlertPreviewRequest): Promise<AlertPreview> =>
    USE_MOCKS ? mockApi.previewAlertRule(b) : http('/alerting/rules/preview', { method: 'POST', body: JSON.stringify(b) }),

  listContactPoints: (): Promise<{ contact_points: ContactPoint[] }> =>
    USE_MOCKS ? mockApi.listContactPoints() : http('/alerting/contact-points'),
  createContactPoint: (b: ContactPointInput): Promise<ContactPoint> =>
    USE_MOCKS ? mockApi.createContactPoint(b) : http('/alerting/contact-points', { method: 'POST', body: JSON.stringify(b) }),
  updateContactPoint: (id: string, b: ContactPointInput): Promise<ContactPoint> =>
    USE_MOCKS ? mockApi.updateContactPoint(id, b) : http(`/alerting/contact-points/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteContactPoint: (id: string): Promise<unknown> =>
    USE_MOCKS ? mockApi.deleteContactPoint(id) : http(`/alerting/contact-points/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testContactPoint: (id: string): Promise<{ ok: boolean; detail: string }> =>
    USE_MOCKS ? mockApi.testContactPoint(id) : http(`/alerting/contact-points/${encodeURIComponent(id)}/test`, { method: 'POST' }),

  getPolicies: (): Promise<{ policy: NotificationPolicy; sync: Sync }> =>
    USE_MOCKS ? mockApi.getPolicies() : http('/alerting/policies'),
  putPolicies: (p: NotificationPolicy): Promise<{ policy: NotificationPolicy; sync: Sync }> =>
    USE_MOCKS ? mockApi.putPolicies(p) : http('/alerting/policies', { method: 'PUT', body: JSON.stringify(p) }),

  /** Browser contact-point deliveries; `after` omitted returns the latest `limit`. */
  alertNotifications: (after?: number, limit?: number): Promise<{ items: AlertNotification[]; last_id: number }> =>
    USE_MOCKS ? mockApi.alertNotifications(after, limit) : http(`/alerting/notifications${qs({ after, limit })}`),
};

export const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unexpected error';

