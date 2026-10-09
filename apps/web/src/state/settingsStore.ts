// App-wide settings: guardrail profile/thresholds and the active core library.

import { create } from "zustand";
import {
  BUILTIN_CORE_LIBRARY,
  indexCoreLibrary,
  type CoreLibrary,
  type CoreLibraryIndex,
} from "@/domain/coreLibrary";
import { DEFAULT_GUARDRAILS, type GuardrailSettings } from "@/domain/rules";
import {
  getSetting,
  loadCoreLibrary,
  resetCoreLibrary,
  saveCoreLibrary,
  setSetting,
} from "@/storage/repository";

const GUARDRAILS_KEY = "guardrails";

interface SettingsState {
  ready: boolean;
  guardrails: GuardrailSettings;
  coreLibrary: CoreLibrary;
  coreIndex: CoreLibraryIndex;
  init(): Promise<void>;
  setGuardrails(next: GuardrailSettings): Promise<void>;
  setCoreLibrary(next: CoreLibrary): Promise<void>;
  resetCoreLibrary(): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ready: false,
  guardrails: DEFAULT_GUARDRAILS,
  coreLibrary: BUILTIN_CORE_LIBRARY,
  coreIndex: indexCoreLibrary(BUILTIN_CORE_LIBRARY),

  async init() {
    const [stored, library] = await Promise.all([
      getSetting<GuardrailSettings>(GUARDRAILS_KEY, DEFAULT_GUARDRAILS),
      loadCoreLibrary(),
    ]);
    const guardrails: GuardrailSettings = {
      profile: stored.profile === "recommended" ? "recommended" : "technical",
      recommended: { ...DEFAULT_GUARDRAILS.recommended, ...stored.recommended },
    };
    set({ ready: true, guardrails, coreLibrary: library, coreIndex: indexCoreLibrary(library) });
  },

  async setGuardrails(next) {
    await setSetting(GUARDRAILS_KEY, next);
    set({ guardrails: next });
  },

  async setCoreLibrary(next) {
    await saveCoreLibrary(next);
    set({ coreLibrary: next, coreIndex: indexCoreLibrary(next) });
  },

  async resetCoreLibrary() {
    await resetCoreLibrary();
    set({ coreLibrary: BUILTIN_CORE_LIBRARY, coreIndex: indexCoreLibrary(BUILTIN_CORE_LIBRARY) });
  },
}));
