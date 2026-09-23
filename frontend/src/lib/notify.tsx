// In-app notifications: toasts, plus a watcher that announces sources that are ready to approve.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { SourceInfo } from './types';

export interface ToastIn {
  kind?: 'ok' | 'info' | 'bad'; title: string; body?: string;
  action?: { label: string; to: string }; sticky?: boolean;
  /** Source ids this toast is about; it closes once none of them is still in review. */
  review?: string[];
}
interface Toast extends ToastIn { id: number }
interface Ctx { toast: (t: ToastIn) => void; pending: SourceInfo[] }

const NotifyCtx = createContext<Ctx>({ toast: () => {}, pending: [] });
export const useNotify = () => useContext(NotifyCtx);

const SEEN_KEY = 'aletheia.review.notified';
const loadSeen = (): Set<string> => {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
};
const saveSeen = (s: Set<string>) => { try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch { /* private mode */ } };

let nextId = 0;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<SourceInfo[]>([]);
  const seen = useRef<Set<string>>(loadSeen());

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: ToastIn) => {
    const id = ++nextId;
    setToasts((x) => [...x, { ...t, id }].slice(-3));
    if (!t.sticky) setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);

  useEffect(() => {
    let alive = true;
    let t: number | undefined;
    const tick = async () => {
      if (document.hidden) { t = window.setTimeout(() => void tick(), 4000); return; }
      try {
        const d = await api.listSources();
        if (!alive) return;
        const ready = d.sources.filter((s) => s.state === 'review');
        setPending(ready);
        const readyIds = new Set(ready.map((s) => s.id));
        setToasts((x) => x.filter((m) => !m.review || m.review.some((id) => readyIds.has(id))));
        const fresh = ready.filter((s) => {
          const key = `${s.id}@${s.attempts}`;
          if (seen.current.has(key)) return false;
          seen.current.add(key);
          return true;
        });
        if (fresh.length) {
          saveSeen(seen.current);
          const one = fresh.length === 1 ? fresh[0] : null;
          toast({
            kind: 'info', sticky: true, review: fresh.map((s) => s.id),
            title: one ? `${one.id} is ready for approval` : `${fresh.length} sources are ready for approval`,
            body: one ? 'A mapping proposal is waiting for your decision.' : fresh.map((s) => s.id).join(', '),
            action: { label: one ? 'Review' : 'Open Sources', to: one ? `/dashboard/sources?review=${encodeURIComponent(one.id)}` : '/dashboard/sources' },
          });
        }
      } catch { /* API down: the pages show their own errors */ }
      if (alive) t = window.setTimeout(() => void tick(), 4000);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(t); };
  }, [toast]);

  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) Aletheia` : 'Aletheia';
  }, [pending.length]);

  const value = useMemo(() => ({ toast, pending }), [toast, pending]);
  return (
    <NotifyCtx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? 'info'}`} role="status">
            <div className="grow">
              <div className="t-title">{t.title}</div>
              {t.body && <div className="t-body">{t.body}</div>}
              {t.action && (
                <button type="button" className="primary" onClick={() => { nav(t.action!.to); dismiss(t.id); }}>{t.action.label}</button>
              )}
            </div>
            <button type="button" className="ghost icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </NotifyCtx.Provider>
  );
}
