// Single typed entry point for every backend call. Shapes follow docs/CONTRACTS.md
// sections 5, 8 and 9. With VITE_USE_MOCKS=1 the fixture implementation is used instead,
// so every page renders and demos standalone while the backend is still being built.

import { mockApi } from './mocks';
import type {
  ApprovalState, AskAiResult, ConnTest, DemoRunResult, DemoScenario, EventPage, EventQuery,
  GateResult, LineageResponse, LlmSettings, LlmSettingsUpdate, PackProposal, QuarantineCluster,
  ReplayDiff,
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
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : res.statusText;
    throw new ApiError(detail, res.status, body);
  }
  return body as T;
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

  /* settings, CONTRACTS section 9 and spec 8.12.8 */
  getSettings: (): Promise<LlmSettings> => (USE_MOCKS ? mockApi.getSettings() : http('/settings/llm')),

  putSettings: (update: LlmSettingsUpdate): Promise<LlmSettings> =>
    USE_MOCKS ? mockApi.putSettings(update) : http('/settings/llm', { method: 'PUT', body: JSON.stringify(update) }),

  testConnection: (): Promise<ConnTest> =>
    USE_MOCKS ? mockApi.testConnection() : http('/settings/llm/test', { method: 'POST' }),

  setAirgap: (on: boolean): Promise<LlmSettings> =>
    USE_MOCKS ? mockApi.setAirgap(on) : http('/settings/airgap', { method: 'POST', body: JSON.stringify({ airgap: on }) }),

  /* demo console, spec 21 */
  listScenarios: (): Promise<DemoScenario[]> => (USE_MOCKS ? mockApi.listScenarios() : http('/demo/scenarios')),

  runScenario: (id: string): Promise<DemoRunResult> =>
    USE_MOCKS ? mockApi.runScenario(id) : http(`/demo/scenarios/${encodeURIComponent(id)}/run`, { method: 'POST' }),

  resetDemo: (): Promise<{ ok: boolean; output: string }> =>
    USE_MOCKS ? mockApi.resetDemo() : http('/demo/reset', { method: 'POST' }),
};

export const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unexpected error';
