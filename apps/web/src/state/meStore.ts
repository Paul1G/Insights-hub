// The signed-in user (from the backend's /api/me, which reads the trusted
// X-Forwarded-* headers set by the platform's OAuth proxy) and backend reachability.

import { create } from "zustand";
import { api, type Me } from "@/api/client";

interface MeState {
  me: Me | null;
  /** False when /api is not reachable (offline / no backend): tenant features are disabled. */
  backendOnline: boolean | null;
  load(): Promise<void>;
}

export const useMeStore = create<MeState>((set) => ({
  me: null,
  backendOnline: null,
  async load() {
    try {
      const me = await api.me();
      set({ me, backendOnline: true });
    } catch {
      set({ me: null, backendOnline: false });
    }
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void useMeStore.getState().load());
  window.addEventListener("offline", () => useMeStore.setState({ backendOnline: false }));
}
