import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errMessage } from './api';
import type { LlmSettings } from './types';

interface Ctx {
  settings: LlmSettings | null;
  error: string | null;
  refresh: () => Promise<void>;
  apply: (s: LlmSettings) => void;
}

const SettingsCtx = createContext<Ctx>({
  settings: null, error: null, refresh: async () => {}, apply: () => {},
});

/** LLM settings are app-wide: the cloud and air-gap banners depend on them. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<Ctx>(() => ({ settings, error, refresh, apply: setSettings }), [settings, error, refresh]);
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}

export const useSettings = (): Ctx => useContext(SettingsCtx);
