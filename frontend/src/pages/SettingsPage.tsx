// LLM provider settings (spec 8.12.8). The deployment ships with a working default, so nothing
// here needs typing; anything set here overrides the environment and takes effect immediately.
import { useEffect, useState } from 'react';
import { Badge, Cli, ErrorBox, Loading, Panel } from '../components/Bits';
import { api, errMessage } from '../lib/api';
import { useSettings } from '../lib/settings';
import { CLOUD_PROVIDERS, isCloudProvider } from '../lib/types';
import type { ConnTest, LlmSettings, LlmSettingsUpdate, Provider, SendSamples } from '../lib/types';

const PROVIDERS: Provider[] = [
  'none', 'gemini', 'openai', 'groq', 'anthropic', 'ollama', 'openai_compatible',
];

const SEND_SAMPLES: SendSamples[] = ['masked', 'none', 'raw'];

// Shown as the placeholder so an operator can see what a sane value looks like per provider.
const MODEL_HINT: Partial<Record<Provider, string>> = {
  gemini: 'gemma-4-31b-it',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-4-5',
  ollama: 'qwen2.5-coder:7b',
};

const SOURCE_LABEL: Record<string, string> = {
  ui: 'set here', env: 'from environment', default: 'built-in default',
};

export function SettingsPage() {
  const { settings, refresh, apply } = useSettings();
  const [form, setForm] = useState<LlmSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<ConnTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (settings && !form) setForm(settings); }, [settings, form]);

  if (!form) return <Loading what="settings" />;

  const cloud = isCloudProvider(form.provider);
  const blockedByAirgap = form.airgap && cloud;
  const rawBlocked = cloud && form.send_samples === 'raw';

  const set = <K extends keyof LlmSettings>(k: K, v: LlmSettings[K]) => {
    setForm({ ...form, [k]: v });
    setSaved(false);
    setTest(null);
  };

  const save = async () => {
    setBusy('save'); setError(null);
    const update: LlmSettingsUpdate = {
      provider: form.provider,
      model: form.model,
      base_url: form.base_url,
      send_samples: form.send_samples,
      ...(apiKey !== '' ? { api_key: apiKey } : {}),
    };
    try {
      const next = await api.putSettings(update);
      apply(next); setForm(next); setApiKey(''); setSaved(true);
      await refresh();
    } catch (e) { setError(errMessage(e)); } finally { setBusy(null); }
  };

  const runTest = async () => {
    setBusy('test'); setError(null); setTest(null);
    try { setTest(await api.testConnection()); }
    catch (e) { setError(errMessage(e)); } finally { setBusy(null); }
  };

  return (
    <div className="stack">
      <div>
        <h1>Settings</h1>
        <p className="muted">
          The LLM assistant is optional. Aletheia&apos;s onboarding heuristics always run first and
          work with no provider configured — AI is only ever a second opinion, and every suggestion
          still has to pass the reconstruction gate and human approval.
        </p>
      </div>

      {form.airgap && (
        <div className="banner banner-info">
          <strong>Air-gap mode is on.</strong> Cloud providers are refused. Use <code>none</code> or
          a self-hosted endpoint on a private address.
        </div>
      )}

      {cloud && !form.airgap && (
        <div className="banner banner-warn">
          <strong>Cloud AI enabled:</strong> masked samples are sent to {form.provider}.
          One request per cluster during onboarding — never per event.
        </div>
      )}

      {error && <ErrorBox error={error} />}

      <Panel
        title="Provider"
        right={form.api_key_set
          ? <Badge kind="ok">key configured …{form.api_key_last4}</Badge>
          : <Badge kind="warn">no key</Badge>}
      >
        <div className="form-grid">
          <label>
            <span>Provider</span>
            <select
              value={form.provider}
              onChange={(e) => set('provider', e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p} disabled={form.airgap && CLOUD_PROVIDERS.includes(p)}>
                  {p}{form.airgap && CLOUD_PROVIDERS.includes(p) ? ' — blocked in air-gap' : ''}
                </option>
              ))}
            </select>
            <em className="muted">{SOURCE_LABEL[form.sources.provider ?? 'default']}</em>
          </label>

          <label>
            <span>Model</span>
            <input
              value={form.model}
              placeholder={MODEL_HINT[form.provider] ?? 'model name'}
              onChange={(e) => set('model', e.target.value)}
            />
            <em className="muted">{SOURCE_LABEL[form.sources.model ?? 'default']}</em>
          </label>

          <label>
            <span>Base URL</span>
            <input
              value={form.base_url}
              placeholder="provider default"
              onChange={(e) => set('base_url', e.target.value)}
            />
            <em className="muted">required for openai_compatible</em>
          </label>

          <label>
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              placeholder={form.api_key_set ? `stored — ends …${form.api_key_last4}` : 'not set'}
              onChange={(e) => { setApiKey(e.target.value); setSaved(false); }}
              autoComplete="off"
            />
            <em className="muted">
              write-only; leave blank to keep the stored key. The API never returns it.
            </em>
          </label>

          <label>
            <span>Sample data sent</span>
            <select
              value={form.send_samples}
              onChange={(e) => set('send_samples', e.target.value as SendSamples)}
            >
              {SEND_SAMPLES.map((s) => (
                <option key={s} value={s} disabled={cloud && s === 'raw'}>
                  {s}{cloud && s === 'raw' ? ' — refused for cloud providers' : ''}
                </option>
              ))}
            </select>
            <em className="muted">
              masked keeps the shape (an IPv4 stays an IPv4) while replacing the values
            </em>
          </label>
        </div>

        {rawBlocked && (
          <ErrorBox error="raw samples are refused for cloud providers — choose masked or none" />
        )}
        {blockedByAirgap && (
          <ErrorBox error="air-gap mode refuses cloud providers — choose none or a self-hosted endpoint" />
        )}

        <div className="row gap">
          <button onClick={save} disabled={busy !== null || rawBlocked || blockedByAirgap}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button onClick={runTest} disabled={busy !== null || form.provider === 'none'}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {saved && <Badge kind="ok">saved — effective immediately, no restart</Badge>}
        </div>
      </Panel>

      {test && (
        <Panel title="Connection test">
          <div className="row gap">
            <Badge kind={test.ok ? 'ok' : 'bad'}>{test.ok ? 'reachable' : 'failed'}</Badge>
            <Badge kind="plain">{test.latency_ms} ms</Badge>
            {test.json_mode && <Badge kind="info">json mode: {test.json_mode}</Badge>}
            <Badge kind="plain">{test.provider}/{test.model}</Badge>
          </div>
          {test.error && <ErrorBox error={test.error} />}
          {test.models.length > 0 && (
            <>
              <h4>Models available at this endpoint</h4>
              <div className="chips">
                {test.models.slice(0, 40).map((m) => (
                  <button
                    key={m}
                    className={`chip${m === form.model ? ' chip-on' : ''}`}
                    onClick={() => set('model', m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </>
          )}
        </Panel>
      )}

      <Panel title="Usage">
        <div className="row gap">
          <Badge kind="plain">{form.usage.requests} requests ({form.usage.window})</Badge>
          {form.usage.tokens !== null && <Badge kind="plain">{form.usage.tokens} tokens</Badge>}
          <Badge kind="plain">cap {form.usage.cap_per_hour}/hour</Badge>
        </div>
        <p className="muted">
          One request per cluster during onboarding, plus at most one retry. No LLM call ever
          touches a live event.
        </p>
      </Panel>

      <Panel title="Equivalent configuration without the UI">
        <Cli cmd={`ALETHEIA_LLM_PROVIDER=${form.provider}
ALETHEIA_LLM_MODEL=${form.model}
ALETHEIA_LLM_SEND_SAMPLES=${form.send_samples}
ALETHEIA_LLM_API_KEY_FILE=/run/secrets/llm_key`} />
        <p className="muted">
          Values set here are stored encrypted and take precedence over these environment defaults.
        </p>
      </Panel>
    </div>
  );
}
