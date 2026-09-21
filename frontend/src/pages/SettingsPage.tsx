import { useEffect, useState } from 'react';
import {
  Badge, Callout, ErrorState, PageHead, Panel, Spinner,
} from '../components/Bits';
import {
  IconAlert, IconCheck, IconChevronLeft, IconChevronRight, IconClose, IconCpu,
  IconExternal, IconInfo, IconKey, IconLock, IconOff, IconServer, IconSettings,
  IconShield, IconShieldAlert, IconSparkles,
} from '../components/Icons';
import { Modal } from '../components/Modal';
import { api, errMessage } from '../lib/api';
import { useNotify } from '../lib/notify';
import { useSettings } from '../lib/settings';
import { isCloudProvider, PROVIDER_DEFAULTS, PROVIDERS } from '../lib/types';
import type { ConnTest, LlmSettings, LlmSettingsUpdate, Provider } from '../lib/types';

const PROVIDER_META: Record<Provider, {
  name: string;
  tag: string;
  desc: string;
  iconClass: string;
  Icon: React.ComponentType<{ size?: number }>;
}> = {
  none: {
    name: 'None',
    tag: 'Heuristics only',
    desc: 'No AI model connected. Local onboarding heuristics run independently. Nothing leaves your machine.',
    iconClass: 'none-icon',
    Icon: IconOff,
  },
  gemini: {
    name: 'Gemini',
    tag: 'Cloud AI',
    desc: 'Google Gemini cloud model. Log sample data is masked before sending to protect privacy.',
    iconClass: 'gemini-icon',
    Icon: IconSparkles,
  },
  local: {
    name: 'Local model',
    tag: 'Self-hosted',
    desc: 'Connect to Ollama, llama.cpp, vLLM, or LM Studio via local OpenAI-compatible API.',
    iconClass: 'local-icon',
    Icon: IconCpu,
  },
};

const LOCAL_URL_DEFAULT = PROVIDER_DEFAULTS.local.base_url;

const LOCAL_PRESETS = [
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434',
    model: 'smollm:135m',
    desc: 'Ollama local server',
    Icon: IconServer,
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    baseUrl: 'http://localhost:8080',
    model: 'smollm-135m',
    desc: 'llama.cpp server',
    Icon: IconCpu,
  },
] as const;

type ActiveModal = 'none_warning' | 'gemini_privacy' | 'gemini_config' | 'local_config' | 'reset_confirm' | null;

export function SettingsPage() {
  const { settings, error: loadError, refresh, apply } = useSettings();
  const { toast } = useNotify();
  const [form, setForm] = useState<LlmSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [localUrl, setLocalUrl] = useState(LOCAL_URL_DEFAULT);
  const [localModel, setLocalModel] = useState('smollm:135m');
  const [selectedPreset, setSelectedPreset] = useState<'ollama' | 'llamacpp' | 'custom' | null>('ollama');
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<ConnTest | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings && !form) {
      setForm(settings);
      setLocalUrl(settings.base_url || LOCAL_URL_DEFAULT);
      setLocalModel(settings.model || 'smollm:135m');
      if (settings.base_url.includes('8080')) {
        setSelectedPreset('llamacpp');
      } else {
        setSelectedPreset('ollama');
      }
    }
  }, [settings, form]);

  if (!form) {
    return loadError ? (
      <div className="stack">
        <PageHead title="Setting" />
        <ErrorState
          error={loadError}
          what="settings"
          fix={<button type="button" onClick={() => void refresh()}><IconSettings size={14} /> Retry</button>}
        />
      </div>
    ) : (
      <Spinner label="Loading settings" />
    );
  }

  const currentProvider = form.provider;
  const isAirgap = form.airgap;

  const handleCardClick = (p: Provider) => {
    if (isAirgap && isCloudProvider(p)) return;
    setTest(null);
    setError(null);

    if (p === 'none') {
      setActiveModal('none_warning');
    } else if (p === 'gemini') {
      setActiveModal('gemini_privacy');
    } else if (p === 'local') {
      const url = form.base_url || LOCAL_URL_DEFAULT;
      setLocalUrl(url);
      setLocalModel(form.model || 'smollm:135m');
      if (url.includes('8080')) {
        setSelectedPreset('llamacpp');
      } else if (url.includes('11434')) {
        setSelectedPreset('ollama');
      } else {
        setSelectedPreset('custom');
      }
      setActiveModal('local_config');
    }
  };

  const selectPreset = (preset: typeof LOCAL_PRESETS[number]) => {
    setTest(null);
    setSelectedPreset(preset.id);
    setLocalUrl(preset.baseUrl);
    if (!localModel || localModel === 'smollm:135m' || localModel === 'smollm-135m') {
      setLocalModel(preset.model);
    }
  };

  const confirmSelectNone = async () => {
    setBusy('save');
    setError(null);
    const update: LlmSettingsUpdate = {
      provider: 'none',
      model: PROVIDER_DEFAULTS.none.model,
      base_url: PROVIDER_DEFAULTS.none.base_url,
      send_samples: 'none',
    };
    try {
      const next = await api.putSettings(update);
      apply(next);
      setForm(next);
      setActiveModal(null);
      toast({ kind: 'ok', title: 'Provider set to None' });
      await refresh();
    } catch (e) {
      const msg = errMessage(e);
      setError(msg);
      toast({ kind: 'bad', title: 'Error', body: msg });
    } finally {
      setBusy(null);
    }
  };

  const saveAndTestGemini = async () => {
    setBusy('save');
    setError(null);
    setTest(null);
    const update: LlmSettingsUpdate = {
      provider: 'gemini',
      model: PROVIDER_DEFAULTS.gemini.model,
      base_url: PROVIDER_DEFAULTS.gemini.base_url,
      send_samples: 'masked',
      ...(apiKey.trim() !== '' ? { api_key: apiKey.trim() } : {}),
    };
    try {
      const next = await api.putSettings(update);
      apply(next);
      setForm(next);
      setApiKey('');
      toast({ kind: 'ok', title: 'Gemini settings saved' });
      await refresh();

      setBusy('test');
      setElapsed(0);
      const started = Date.now();
      const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
      try {
        const testRes = await api.testConnection();
        setTest(testRes);
        if (testRes.ok) {
          toast({ kind: 'ok', title: 'Connection successful & tested!' });
        } else {
          toast({ kind: 'bad', title: 'Connection Failed', body: testRes.error ?? 'Unable to reach provider.' });
        }
      } catch (testErr) {
        const msg = errMessage(testErr);
        setError(msg);
        toast({ kind: 'bad', title: 'Connection Test Error', body: msg });
      } finally {
        window.clearInterval(tick);
      }
    } catch (e) {
      const msg = errMessage(e);
      setError(msg);
      toast({ kind: 'bad', title: 'Error saving settings', body: msg });
    } finally {
      setBusy(null);
    }
  };

  const saveAndTestLocal = async () => {
    setBusy('save');
    setError(null);
    setTest(null);
    const targetUrl = localUrl.trim() || LOCAL_URL_DEFAULT;
    const targetModel = localModel.trim() || 'smollm:135m';
    const update: LlmSettingsUpdate = {
      provider: 'local',
      model: targetModel,
      base_url: targetUrl,
      send_samples: form.send_samples === 'raw' ? 'masked' : form.send_samples,
    };
    try {
      const next = await api.putSettings(update);
      apply(next);
      setForm(next);
      toast({ kind: 'ok', title: 'Local model settings saved' });
      await refresh();

      setBusy('test');
      setElapsed(0);
      const started = Date.now();
      const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
      try {
        const testRes = await api.testConnection();
        setTest(testRes);
        if (testRes.ok) {
          toast({ kind: 'ok', title: 'Connection successful & tested!' });
        } else {
          toast({ kind: 'bad', title: 'Connection Failed', body: testRes.error ?? 'Unable to reach local server.' });
        }
      } catch (testErr) {
        const msg = errMessage(testErr);
        setError(msg);
        toast({ kind: 'bad', title: 'Connection Test Error', body: msg });
      } finally {
        window.clearInterval(tick);
      }
    } catch (e) {
      const msg = errMessage(e);
      setError(msg);
      toast({ kind: 'bad', title: 'Error saving settings', body: msg });
    } finally {
      setBusy(null);
    }
  };

  const toggleAirgap = async () => {
    setError(null);
    try {
      const next = await api.setAirgap(!form.airgap);
      apply(next);
      setForm(next);
      toast({ kind: 'ok', title: `Strict Offline Mode ${!form.airgap ? 'enabled' : 'disabled'}` });
    } catch (e) {
      const msg = errMessage(e);
      setError(msg);
      toast({ kind: 'bad', title: 'Error', body: msg });
    }
  };

  const handleResetSettings = async () => {
    setBusy('save');
    setError(null);
    try {
      const next = await api.resetSettings();
      apply(next);
      setForm(next);
      setActiveModal(null);
      toast({ kind: 'ok', title: 'System data reset', body: 'All logs and event data cleared. LLM provider and Strict Offline mode saved.' });
      await refresh();
    } catch (e) {
      const msg = errMessage(e);
      setError(msg);
      toast({ kind: 'bad', title: 'Reset Error', body: msg });
    } finally {
      setBusy(null);
    }
  };

  const keyBadge = currentProvider === 'gemini' ? (
    form.api_key_set ? (
      <Badge kind="ok"><IconKey size={12} /> Key Configured</Badge>
    ) : (
      <Badge kind="warn"><IconAlert size={12} /> No Key Set</Badge>
    )
  ) : undefined;

  return (
    <div className="stack">
      <PageHead title="Setting">
        Configure AI assistant provider for log schema mapping and pack generation. Onboarding
        heuristics always run first to ensure zero data loss.
      </PageHead>

      {isAirgap && (
        <Callout kind="info" icon={<IconLock size={16} />}>
          <strong>Strict Offline Mode (Zero Cloud Data Egress) is enabled.</strong> External cloud APIs like Gemini are completely blocked. Select <em>None</em> or a <em>Local model</em>.
        </Callout>
      )}

      {error && <ErrorState error={error} what="settings" />}

      <Panel title={<><IconSparkles size={18} /> LLM Provider</>} right={keyBadge}>
        <p className="hint">Select an AI provider option below to configure assistant capabilities:</p>
        <div className="provider-grid">
          {PROVIDERS.map((p) => {
            const isSelected = currentProvider === p;
            const isBlocked = isAirgap && isCloudProvider(p);
            const meta = PROVIDER_META[p];
            const CardIcon = meta.Icon;

            return (
              <button
                type="button"
                key={p}
                className={`provider-card${isSelected ? ' selected' : ''}`}
                onClick={() => handleCardClick(p)}
                disabled={isBlocked}
              >
                <div className="provider-card-header">
                  <div className="provider-card-icon-title">
                    <div className={`provider-icon-wrapper ${meta.iconClass}`}>
                      <CardIcon size={20} />
                    </div>
                    <span className="provider-card-title-text">{meta.name}</span>
                  </div>
                  <Badge kind={isSelected ? 'ok' : isBlocked ? 'bad' : 'plain'}>
                    {isBlocked ? 'blocked' : meta.tag}
                  </Badge>
                </div>

                <div className="provider-card-desc">{meta.desc}</div>

                <div className="provider-card-footer">
                  {isSelected ? (
                    <Badge kind="ok">
                      <IconCheck size={12} /> Active Provider{p === 'local' && form.model ? ` (${form.model})` : ''}
                    </Badge>
                  ) : isBlocked ? (
                    <Badge kind="bad"><IconLock size={12} /> Blocked by Strict Offline</Badge>
                  ) : (
                    <span className="hint" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      Click to configure <IconChevronRight size={12} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Current Active Configuration Quick Action */}
        <div className="btn-row" style={{ marginTop: 'var(--s3)' }}>
          <button
            type="button"
            className="secondary"
            onClick={() => handleCardClick(currentProvider)}
            disabled={isAirgap && isCloudProvider(currentProvider)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <IconSettings size={15} />
            {currentProvider === 'none' ? 'Review None Option' : `Configure & Test ${PROVIDER_META[currentProvider].name}`}
          </button>
        </div>
      </Panel>

      {/* Strict Offline Mode Panel */}
      <Panel
        title={<><IconShield size={18} /> Strict Offline & Data Privacy Guard</>}
        right={<Badge kind={form.airgap ? 'ok' : 'plain'}>{form.airgap ? 'Strict Offline Active' : 'Standard Mode'}</Badge>}
      >
        <div className="stack" style={{ gap: 'var(--s3)' }}>
          <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--s3)' }}>
            <p className="hint grow" style={{ margin: 0, maxWidth: '640px', fontSize: '13.5px', color: 'var(--text)' }}>
              Strict Offline Mode prohibits any outbound network calls to external cloud AI services (e.g. Google Gemini), guaranteeing that log sample data, tokens, and schemas never leave your local infrastructure.
            </p>
            <button
              type="button"
              className={form.airgap ? 'secondary' : 'primary'}
              onClick={toggleAirgap}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
            >
              {form.airgap ? <IconLock size={15} /> : <IconShield size={15} />}
              {form.airgap ? 'Disable Strict Offline' : 'Enable Strict Offline'}
            </button>
          </div>

          <div className="privacy-feature-grid">
            <div className="privacy-feature-card">
              <div className="pfc-icon"><IconLock size={16} /></div>
              <div>
                <strong>Zero Outbound Egress</strong>
                <p className="hint" style={{ margin: 0 }}>Blocks cloud model APIs</p>
              </div>
            </div>
            <div className="privacy-feature-card">
              <div className="pfc-icon"><IconCpu size={16} /></div>
              <div>
                <strong>Self-Hosted AI Ready</strong>
                <p className="hint" style={{ margin: 0 }}>Ollama, llama.cpp, vLLM, LM Studio</p>
              </div>
            </div>
            <div className="privacy-feature-card">
              <div className="pfc-icon"><IconShield size={16} /></div>
              <div>
                <strong>Local Heuristics Only</strong>
                <p className="hint" style={{ margin: 0 }}>Zero-loss offline schema onboarding</p>
              </div>
            </div>
          </div>
        </div>
      </Panel>

      {/* System Data Reset Panel */}
      <Panel
        title={<><IconShieldAlert size={18} color="var(--bad)" /> Reset System Data</>}
      >
        <div className="row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 'var(--s3)' }}>
          <div className="grow" style={{ maxWidth: '640px' }}>
            <p className="hint" style={{ margin: 0, fontSize: '13.5px', color: 'var(--text)' }}>
              Clear all stored raw logs, connected sources, proposals, human approvals, ClickHouse events, and lineage tracking.
            </p>
            <span className="hint" style={{ fontSize: '12px', color: 'var(--accent)', fontWeight: 500, display: 'inline-block', marginTop: '4px' }}>
              LLM provider and Strict Offline mode saved.
            </span>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => setActiveModal('reset_confirm')}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              background: 'var(--bad)', borderColor: 'var(--bad-border)', color: '#ffffff',
              whiteSpace: 'nowrap',
            }}
          >
            <IconShieldAlert size={15} /> Clear All Log Data & Reset State
          </button>
        </div>
      </Panel>

      {/* --- MODAL 1: NONE WARNING POPUP --- */}
      {activeModal === 'none_warning' && (
        <Modal
          title={<><IconShieldAlert size={20} color="var(--warn)" /> Warning: Disabling AI Provider</>}
          onClose={() => setActiveModal(null)}
          footer={
            <>
              <button type="button" onClick={() => setActiveModal(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconClose size={14} /> Cancel
              </button>
              <button type="button" className="primary" onClick={confirmSelectNone} disabled={busy !== null} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconCheck size={14} /> {busy === 'save' ? 'Saving…' : 'Confirm None'}
              </button>
            </>
          }
        >
          <Callout kind="warn" icon={<IconShieldAlert size={20} />}>
            <div>
              <strong>This affects onboarding performance.</strong>
              <p style={{ marginTop: 'var(--s2)', marginBottom: 0 }}>
                Disabling the LLM provider turns off AI-assisted schema mapping and pack proposals. Onboarding will rely solely on baseline heuristics.
              </p>
              <p style={{ marginTop: 'var(--s2)', marginBottom: 0 }}>
                We recommend choosing <strong>Gemini</strong> (cloud with data masking) or a <strong>Local model</strong> to optimize onboarding performance.
              </p>
            </div>
          </Callout>
        </Modal>
      )}

      {/* --- MODAL 2 STEP 1: GEMINI DATA PRIVACY NOTICE --- */}
      {activeModal === 'gemini_privacy' && (
        <Modal
          title={<><IconShield size={20} color="var(--accent)" /> Data Privacy & Cloud Security</>}
          subtitle="Google Gemini Assistant Notice"
          onClose={() => setActiveModal(null)}
          footer={
            <>
              <button type="button" onClick={() => setActiveModal(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconClose size={14} /> Cancel
              </button>
              <button type="button" className="primary" onClick={() => setActiveModal('gemini_config')} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                OK / Proceed <IconChevronRight size={14} />
              </button>
            </>
          }
        >
          <Callout kind="info" icon={<IconShield size={20} />}>
            <div>
              <strong>Data is masked before cloud transmission.</strong>
              <p style={{ marginTop: 'var(--s2)', marginBottom: 0 }}>
                To protect your sensitive information and data privacy, sample log values (IP addresses, usernames, tokens) are automatically masked before being sent to Gemini cloud models.
              </p>
            </div>
          </Callout>
          <p className="hint" style={{ marginTop: 'var(--s4)' }}>
            Click OK to proceed to API key configuration.
          </p>
        </Modal>
      )}

      {/* --- MODAL 2 STEP 2: GEMINI API KEY & TEST CONNECTION --- */}
      {activeModal === 'gemini_config' && (
        <Modal
          title={<><IconSparkles size={20} color="#9b59b6" /> Configure Gemini API Key</>}
          subtitle="Google AI Studio Integration"
          onClose={() => setActiveModal(null)}
          footer={
            <>
              <button type="button" onClick={() => setActiveModal('gemini_privacy')} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconChevronLeft size={14} /> Back
              </button>
              <button
                type="button"
                className="primary"
                onClick={test?.ok ? () => setActiveModal(null) : saveAndTestGemini}
                disabled={busy !== null}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <IconCheck size={14} />
                {busy === 'save'
                  ? 'Saving…'
                  : busy === 'test'
                    ? `Testing… (${elapsed}s)`
                    : test?.ok
                      ? 'Save & Close'
                      : 'Save & Test Connection'}
              </button>
            </>
          }
        >
          <div className="stack">
            <Callout kind="info" icon={<IconInfo size={18} />}>
              <div>
                <strong>Works in Free Tier!</strong>
                <p style={{ marginTop: 'var(--s1)', marginBottom: 0 }}>
                  You can get a free API key directly from Google AI Studio:
                </p>
                <a
                  href="https://aistudio.google.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: 'var(--s1)' }}
                >
                  https://aistudio.google.com/api-keys <IconExternal size={13} />
                </a>
              </div>
            </Callout>

            <label className="field code" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s1)' }}>
              <span className="lbl" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <IconKey size={14} /> Gemini API Key
              </span>
              <input
                type="password"
                value={apiKey}
                placeholder={form.api_key_set ? 'API Key Configured (leave blank to keep)' : 'Paste your Gemini API key'}
                onChange={(e) => { setTest(null); setApiKey(e.target.value); }}
                autoComplete="off"
              />
              <span className="help">Write-only. Leave blank to keep existing key.</span>
            </label>

            {busy === 'test' && (
              <div className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
                <Spinner label="Testing connection to Gemini..." />
              </div>
            )}

            {test && !test.ok && (
              <Callout kind="bad" icon={<IconAlert size={18} />}>
                <div>
                  <strong>Connection Failed</strong>
                  <p style={{ margin: 'var(--s1) 0 0 0' }}>{test.error ?? 'Unable to reach provider.'}</p>
                </div>
              </Callout>
            )}
          </div>
        </Modal>
      )}

      {/* --- MODAL 3: LOCAL MODEL CONFIG & TEST CONNECTION --- */}
      {activeModal === 'local_config' && (
        <Modal
          title={<><IconCpu size={20} color="var(--accent)" /> Configure Local Model Server</>}
          subtitle="OpenAI-Compatible Local Endpoint"
          onClose={() => setActiveModal(null)}
          footer={
            <>
              <button type="button" onClick={() => setActiveModal(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconClose size={14} /> Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={test?.ok ? () => setActiveModal(null) : saveAndTestLocal}
                disabled={busy !== null || !selectedPreset}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <IconCheck size={14} />
                {busy === 'save'
                  ? 'Saving…'
                  : busy === 'test'
                    ? `Testing… (${elapsed}s)`
                    : test?.ok
                      ? 'Save & Close'
                      : 'Save & Test Connection'}
              </button>
            </>
          }
        >
          <div className="stack">
            <p className="hint">
              Select an engine supporter below to load and enable configuration fields:
            </p>

            {/* Supporter Presets */}
            <div style={{ display: 'flex', gap: 'var(--s3)', marginBottom: 'var(--s2)' }}>
              {LOCAL_PRESETS.map((p) => {
                const PresetIcon = p.Icon;
                const active = selectedPreset === p.id;
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={`button ${active ? 'primary' : 'secondary'}`}
                    onClick={() => selectPreset(p)}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: 'var(--s3)', height: 'auto', gap: '4px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                      <PresetIcon size={16} /> {p.name}
                    </div>
                    <div style={{ fontSize: '11px', opacity: 0.8 }}>Base URL: {p.baseUrl}</div>
                    <div style={{ fontSize: '11px', opacity: 0.8 }}>Default Model: {p.model}</div>
                  </button>
                );
              })}
              <button
                type="button"
                className={`button ${selectedPreset === 'custom' ? 'primary' : 'secondary'}`}
                onClick={() => { setTest(null); setSelectedPreset('custom'); }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: 'var(--s3)', height: 'auto', gap: '4px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                  <IconSettings size={16} /> Custom
                </div>
                <div style={{ fontSize: '11px', opacity: 0.8 }}>Enter Custom URL & Model</div>
              </button>
            </div>

            <label className="field code" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s1)' }}>
              <span className="lbl" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <IconServer size={14} /> Server Base URL
              </span>
              <input
                type="text"
                value={localUrl}
                disabled={!selectedPreset}
                placeholder={
                  !selectedPreset
                    ? "Select an engine above to enable editing"
                    : selectedPreset === 'ollama'
                      ? "http://localhost:11434"
                      : selectedPreset === 'llamacpp'
                        ? "http://localhost:8080"
                        : "http://localhost:11434"
                }
                onChange={(e) => {
                  setTest(null);
                  const val = e.target.value;
                  setLocalUrl(val);
                  if (val.includes('11434')) {
                    setSelectedPreset('ollama');
                  } else if (val.includes('8080')) {
                    setSelectedPreset('llamacpp');
                  } else {
                    setSelectedPreset('custom');
                  }
                }}
                autoComplete="off"
              />
              <span className="help">
                {selectedPreset === 'ollama'
                  ? 'Base URL of your local server for Ollama (e.g., http://localhost:11434)'
                  : selectedPreset === 'llamacpp'
                    ? 'Base URL of your local server for llama.cpp (e.g., http://localhost:8080)'
                    : 'Base URL of your local server (e.g., http://localhost:11434 or http://localhost:8080)'}
              </span>
            </label>

            <label className="field code" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s1)' }}>
              <span className="lbl" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <IconCpu size={14} /> Model Name <span style={{ color: 'var(--warn)', fontSize: '12px' }}>*required</span>
              </span>
              <input
                type="text"
                value={localModel}
                disabled={!selectedPreset}
                placeholder={
                  !selectedPreset
                    ? "Select an engine above to enable editing"
                    : selectedPreset === 'ollama'
                      ? "e.g. llama3.2, mistral, deepseek-r1:7b, smollm:135m"
                      : selectedPreset === 'llamacpp'
                        ? "e.g. smollm-135m"
                        : "e.g. smollm:135m"
                }
                onChange={(e) => {
                  setTest(null);
                  setLocalModel(e.target.value);
                }}
                list="ollama-model-suggestions"
                autoComplete="off"
              />
              <datalist id="ollama-model-suggestions">
                <option value="llama3.2" />
                <option value="llama3" />
                <option value="deepseek-r1:7b" />
                <option value="mistral" />
                <option value="qwen2.5" />
                <option value="smollm:135m" />
                <option value="phi3" />
                <option value="codellama" />
              </datalist>

              {selectedPreset === 'ollama' && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--muted)', alignSelf: 'center', marginRight: '4px' }}>Popular Ollama models:</span>
                  {['llama3.2', 'llama3', 'deepseek-r1:7b', 'mistral', 'qwen2.5', 'smollm:135m'].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setTest(null); setLocalModel(m); }}
                      style={{
                        fontSize: '11px',
                        padding: '3px 9px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        background: localModel === m ? 'var(--accent-subtle)' : 'var(--bg-subtle, rgba(255,255,255,0.05))',
                        color: localModel === m ? 'var(--accent)' : 'inherit',
                        border: localModel === m ? '1px solid var(--accent)' : '1px solid var(--border)'
                      }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}

              <span className="help">
                {selectedPreset === 'ollama'
                  ? 'Exact model identifier installed in Ollama (e.g., llama3.2, mistral, deepseek-r1:7b, smollm:135m)'
                  : selectedPreset === 'llamacpp'
                    ? 'Exact model identifier for llama.cpp (e.g., smollm-135m)'
                    : 'Exact model identifier (e.g., smollm:135m for Ollama, smollm-135m for llama.cpp)'}
              </span>
            </label>

            {busy === 'test' && (
              <div className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
                <Spinner label="Connecting to local server & running test..." />
              </div>
            )}

            {test && !test.ok && (
              <Callout kind="bad" icon={<IconAlert size={18} />}>
                <div>
                  <strong>Connection Failed</strong>
                  <p style={{ margin: 'var(--s1) 0 0 0' }}>{test.error ?? 'Unable to reach local server.'}</p>
                </div>
              </Callout>
            )}
          </div>
        </Modal>
      )}

      {/* --- MODAL 4: FULL SYSTEM DATA RESET CONFIRMATION --- */}
      {activeModal === 'reset_confirm' && (
        <Modal
          title={<><IconShieldAlert size={20} color="var(--bad)" /> Clear All System Data & Reset State</>}
          subtitle="System Reset Confirmation"
          onClose={() => setActiveModal(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <IconClose size={14} /> Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleResetSettings}
                disabled={busy !== null}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'var(--bad)', borderColor: 'var(--bad-border)' }}
              >
                <IconShieldAlert size={14} /> {busy === 'save' ? 'Clearing Data…' : 'Clear All Data & Reset'}
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 'var(--s3)' }}>
            <Callout kind="bad" icon={<IconShieldAlert size={20} />}>
              <div>
                <strong>Permanently Delete All System Data</strong>
                <p style={{ marginTop: 'var(--s2)', marginBottom: 0 }}>
                  This will delete all raw logs, connected sources, proposals, approvals, ClickHouse events, and lineage records.
                </p>
              </div>
            </Callout>

            <div style={{ padding: 'var(--s3) var(--s4)', borderRadius: 'var(--r-md)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text)' }}>
              <IconCheck size={16} color="var(--accent)" />
              <span><strong>Preserved:</strong> LLM provider and Strict Offline mode saved.</span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
