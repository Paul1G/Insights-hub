// Loads the signed-in user's tenant connections and detects an unreachable backend.

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type ConnectionSummary } from "@/api/client";
import { useMeStore } from "@/state/meStore";

export interface ConnectionsState {
  connections: ConnectionSummary[];
  loading: boolean;
  error?: string;
  /** The backend is not reachable (offline / not running). */
  offline: boolean;
  reload(): Promise<void>;
}

export function useConnections(): ConnectionsState {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [offline, setOffline] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const list = await api.connections.list();
      setConnections(list);
      setOffline(false);
      useMeStore.setState({ backendOnline: true });
    } catch (e) {
      const unreachable = e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
      setOffline(unreachable);
      setError(e instanceof Error ? e.message : String(e));
      if (unreachable) useMeStore.setState({ backendOnline: false });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { connections, loading, error, offline, reload };
}
