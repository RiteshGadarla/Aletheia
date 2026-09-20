// LLM settings (spec 8.12.8). One dropdown picks the assistant; each choice asks for the single
// thing it actually needs. Model names and base URLs come from defaults, never from the user.
import { useEffect, useState } from 'react';
import {
  Badge, Callout, Cli, ErrorState, PageHead, Panel, Spinner,
} from '../components/Bits';
import { IconShield, IconShieldAlert } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { useSettings } from '../lib/settings';
import { isCloudProvider, PROVIDER_DEFAULTS, PROVIDERS } from '../lib/types';
import type { ConnTest, LlmSettings, LlmSettingsUpdate, Provider } from '../lib/types';

const PROVIDER_LABEL: Record<Provider, string> = {
  none: 'None — heuristics only',
  gemini: 'Gemini',
  local: 'Local model',
};

const LOCAL_URL = PROVIDER_DEFAULTS.local.base_url;

export function SettingsPage() {
  const { settings, error: loadError, refresh, apply } = useSettings();
  const [form, setForm] = useState<LlmSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<ConnTest | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (settings && !form) setForm(settings); }, [settings, form]);

  if (!form) {
    // Without this the page spins forever whenever the Studio API is down.
    return loadError
      ? (
        <div className="stack">
          <PageHead title="Settings" />
          <ErrorState
            error={loadError}
            what="settings"
            fix={<button type="button" onClick={() => void refresh()}>Retry</button>}
          />
        </div>
      )
      : <Spinner label="Loading settings" />;
  }

  const provider = form.provider;
  const cloud = isCloudProvider(provider);
  const blockedByAirgap = form.airgap && cloud;

  const dirty = () => { setSaved(false); setTest(null); };

  const pickProvider = (p: Provider) => {
    // Everything but the one visible field is a default, so switching never strands stale values.
    setForm({ ...form, provider: p, model: PROVIDER_DEFAULTS[p].model, base_url: PROVIDER_DEFAULTS[p].base_url });
    dirty();
  };

  const setLocalUrl = (url: string) => { setForm({ ...form, base_url: url }); dirty(); };

  const save = async () => {
    setBusy('save'); setError(null);
    const update: LlmSettingsUpdate = {
      provider,
      model: PROVIDER_DEFAULTS[provider].model,
      base_url: provider === 'local'
        ? (form.base_url.trim() || LOCAL_URL)
        : PROVIDER_DEFAULTS[provider].base_url,
      // Raw samples are refused for cloud, so never let a stored value block the save.
      send_samples: cloud && form.send_samples === 'raw' ? 'masked' : form.send_samples,
      ...(apiKey !== '' ? { api_key: apiKey } : {}),
    };
    try {
      const next = await api.putSettings(update);
      apply(next); setForm(next); setApiKey(''); setSaved(true);
      await refresh();
    } catch (e) { setError(errMessage(e)); } finally { setBusy(null); }
  };

  // A real generateContent call against Gemma takes 8-34s, and a disabled button for that
  // long reads as a hang. Count the seconds up so the wait is visibly progress, not a freeze.
  const runTest = async () => {
    setBusy('test'); setError(null); setTest(null); setElapsed(0);
    const started = Date.now();
    const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try { setTest(await api.testConnection()); }
    catch (e) { setError(errMessage(e)); }
    finally { window.clearInterval(tick); setBusy(null); }
  };

  const toggleAirgap = async () => {
    setError(null);
    try {
      const next = await api.setAirgap(!form.airgap);
      apply(next); setForm(next);
    } catch (e) { setError(errMessage(e)); }
  };

  const keyBadge = provider === 'gemini'
    ? (form.api_key_set
      ? <Badge kind="ok">key configured · …{form.api_key_last4}</Badge>
      : <Badge kind="warn">no key set</Badge>)
    : undefined;

  return (
    <div className="stack">
      <PageHead title="Settings">
        The AI assistant is optional. Onboarding heuristics always run first, and every suggestion
        still has to rebuild the original byte for byte before a human can approve it.
      </PageHead>

      {form.airgap && (
        <Callout kind="info" icon={<IconShield size={15} />}>
          <strong>Air-gap mode is on.</strong> Gemini is refused. Use <em>None</em> or a local model.
        </Callout>
      )}
      {cloud && !form.airgap && (
        <Callout kind="warn" icon={<IconShieldAlert size={15} />}>
          <strong>Cloud AI enabled.</strong> Masked samples go to Gemini — one request per cluster
          during onboarding, never per event.
        </Callout>
      )}

      {error && <ErrorState error={error} what="settings" />}

      <Panel title="AI assistant" right={keyBadge}>
        <div className="form-narrow">
          <label className="field">
            <span className="lbl">Assistant</span>
            <select
              value={provider}
              onChange={(e) => pickProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p} disabled={form.airgap && isCloudProvider(p)}>
                  {PROVIDER_LABEL[p]}{form.airgap && isCloudProvider(p) ? ' — blocked in air-gap mode' : ''}
                </option>
              ))}
            </select>
          </label>

          {provider === 'gemini' && (
            <label className="field code">
              <span className="lbl">API key</span>
              <input
                type="password"
                value={apiKey}
                placeholder={form.api_key_set ? `stored — ends …${form.api_key_last4}` : 'paste your Gemini API key'}
                onChange={(e) => { setApiKey(e.target.value); dirty(); }}
                autoComplete="off"
              />
              <span className="help">Write-only. Leave blank to keep the stored key.</span>
            </label>
          )}

          {provider === 'local' && (
            <label className="field code">
              <span className="lbl">Server URL</span>
              <input
                value={form.base_url}
                placeholder={LOCAL_URL}
                onChange={(e) => setLocalUrl(e.target.value)}
                autoComplete="off"
              />
              <span className="help">
                Any OpenAI-compatible server you run — Ollama, vLLM, llama.cpp, LM Studio.
              </span>
            </label>
          )}

          {provider === 'none' && (
            <p className="hint">
              No provider is configured. Onboarding heuristics run on their own, and nothing leaves
              this machine.
            </p>
          )}

          {blockedByAirgap && (
            <ErrorState error="Air-gap mode refuses cloud providers." what="" fix="Choose None or a local model." />
          )}

          <div className="btn-row">
            <button className="primary" onClick={save} disabled={busy !== null || blockedByAirgap}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button onClick={runTest} disabled={busy !== null || provider === 'none'}>
              {busy === 'test' ? `Testing… ${elapsed}s` : 'Test connection'}
            </button>
            {busy === 'test' && (
              <span className="hint">
                The model is asked one real question, so this can take up to a minute.
              </span>
            )}
            {saved && <Badge kind="ok">saved · no restart needed</Badge>}
          </div>

          {test && (
            <Callout kind={test.ok ? 'ok' : 'bad'}>
              {test.ok
                ? <><strong>Reachable.</strong> {test.provider}/{test.model} answered in {test.latency_ms} ms.</>
                : <><strong>Could not reach {test.provider}.</strong> {test.error ?? 'No response.'}</>}
            </Callout>
          )}
        </div>
      </Panel>

      <Panel
        title="Air-gap mode"
        right={<Badge kind={form.airgap ? 'ok' : 'plain'}>{form.airgap ? 'on' : 'off'}</Badge>}
      >
        <div className="row between">
          <p className="hint grow">
            Refuses every cloud provider, so the assistant is either off or a model inside your own
            network. The real air-gap is the network; this is the safety net.
          </p>
          <button onClick={toggleAirgap}>{form.airgap ? 'Disable' : 'Enable'}</button>
        </div>
      </Panel>

      <details className="panel-details">
        <summary>Usage and environment variables</summary>
        <div className="details-body">
          <dl className="kv">
            <dt>Requests ({form.usage.window})</dt>
            <dd>{form.usage.requests} of {form.usage.cap_per_hour}</dd>
            <dt>Tokens</dt>
            <dd>{form.usage.tokens ?? '—'}</dd>
            <dt>Provenance</dt>
            <dd className="mono">{provider === 'none' ? 'heuristic' : `ai:${provider}/${form.model}`}</dd>
          </dl>
          <p className="hint">
            One request per cluster during onboarding, plus at most one retry. No model call ever
            touches a live event.
          </p>
          <Cli
            cmd={`ALETHEIA_LLM_PROVIDER=${provider}
ALETHEIA_LLM_BASE_URL=${form.base_url}
ALETHEIA_LLM_API_KEY_FILE=/run/secrets/llm_key`}
          />
        </div>
      </details>
    </div>
  );
}
