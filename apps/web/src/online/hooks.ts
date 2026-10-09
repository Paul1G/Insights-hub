// React hooks for loading tenant data through the proxy.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConnectionSummary, type ListRequest, type ListResult } from "@/api/client";
import { isAbortError } from "./errors";
import { defaultTransport, type AmTransport } from "./transport";

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Re-run the loader (keeps the previous data visible while loading). */
  reload: () => void;
  /** Replace the data locally (optimistic update after a successful write). */
  setData: (update: T | null | ((prev: T | null) => T | null)) => void;
}

/** Run `load` when `key` changes (and on reload); aborts superseded runs. */
export function useLoader<T>(load: (signal: AbortSignal) => Promise<T>, key: string, enabled = true): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    loadRef
      .current(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted && !isAbortError(e)) setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [key, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

export function useConnections(): Loaded<ConnectionSummary[]> {
  return useLoader(() => api.connections.list(), "connections");
}

/** All pages of a list endpoint for a connection (re-runs when the request changes). */
export function useTenantList<T>(
  connectionId: string,
  req: ListRequest,
  enabled = true,
  t: AmTransport = defaultTransport,
): Loaded<ListResult<T>> {
  const key = `${connectionId}:${JSON.stringify(req)}`;
  return useLoader((signal) => t.listAll<T>(connectionId, req, signal), key, enabled && !!connectionId);
}
