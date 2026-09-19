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
