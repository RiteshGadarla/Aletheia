import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'aletheia.theme';

/** localStorage throws in private mode and with site data blocked, so every access is guarded. */
function readStored(): Theme | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(t: Theme): void {
  try {
    window.localStorage.setItem(KEY, t);
  } catch {
    /* ignore: the theme still applies for this session */
  }
}

interface Ctx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeCtx = createContext<Ctx>({ theme: 'dark', setTheme: () => {}, toggle: () => {} });

/** Dark is the product default; a stored choice wins over it. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStored() ?? 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writeStored(t);
  }, []);

  const toggle = useCallback(() => setThemeState((prev) => {
    const next: Theme = prev === 'dark' ? 'light' : 'dark';
    writeStored(next);
    return next;
  }), []);

  const value = useMemo<Ctx>(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export const useTheme = (): Ctx => useContext(ThemeCtx);
