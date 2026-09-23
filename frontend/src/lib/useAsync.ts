import { useCallback, useEffect, useRef, useState } from 'react';
import { errMessage } from './api';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (v: T | null) => void;
}

/** Run an async loader on mount and whenever deps change; ignores stale results. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    loader().then(
      (v) => { if (seq.current === mine) { setData(v); setLoading(false); } },
      (e) => { if (seq.current === mine) { setError(errMessage(e)); setLoading(false); } },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: useCallback(() => setNonce((n) => n + 1), []), setData };
}

/**
 * Poll `loader` every `ms`, counted from when the previous call settles, so calls never overlap
 * or pile up behind a slow server. Keeps the last good data, pauses while the tab is hidden.
 */
export function usePoll<T>(loader: () => Promise<T>, ms: number, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let busy = false;
    let again = false;
    let timer: number | undefined;

    const schedule = () => {
      timer = window.setTimeout(() => (document.hidden ? schedule() : void run()), ms);
    };
    const run = async () => {
      window.clearTimeout(timer);
      if (busy) { again = true; return; }
      busy = true;
      let giveUp: number | undefined;
      try {
        // A hung request must not stall the loop; its late result is simply dropped.
        const v = await Promise.race([
          loader(),
          new Promise<never>((_, rej) => { giveUp = window.setTimeout(() => rej(new Error('The server is taking too long to answer.')), Math.max(15000, ms * 4)); }),
        ]);
        if (alive) { setData(v); setError(null); }
      } catch (e) {
        if (alive) setError(errMessage(e));
      } finally {
        window.clearTimeout(giveUp);
        busy = false;
        if (alive) {
          setLoading(false);
          if (again) { again = false; void run(); } else schedule();
        }
      }
    };
    const onVisible = () => { if (!document.hidden) void run(); };

    kick.current = () => void run();
    setLoading(true);
    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms]);

  return { data, loading, error, reload: useCallback(() => kick.current(), []), setData };
}
