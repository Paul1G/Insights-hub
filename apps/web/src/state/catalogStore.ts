// Tenant catalogs in memory + which connection a project is linked to.
//
// A project linked to a connection resolves `external` type references with
// that tenant's existing definitions (see domain/external.ts) and offers the
// existing types in the editors' pickers. The link is a local UI preference
// (a connection id is not a secret) stored in localStorage per project.

import { create } from "zustand";
import type { ConnectionSummary } from "@/api/client";
import { deleteCatalog, externalTypesFromSnapshot, loadCatalog, readCatalog, saveCatalog } from "@/catalog/catalog";
import type { ExternalTypes } from "@/domain/external";
import type { TenantCatalogRecord } from "@/storage/db";
import type { ReadProgress } from "@/tenant/read";

const LINK_KEY = "ams.project.tenant";

export interface LoadedCatalog {
  record: TenantCatalogRecord;
  external: ExternalTypes;
}

interface CatalogState {
  links: Record<string, string>;
  catalogs: Record<string, LoadedCatalog>;
  reading: Record<string, ReadProgress | undefined>;
  errors: Record<string, string | undefined>;
  /** Load a stored catalog into memory (no network). */
  ensure(connectionId: string): Promise<LoadedCatalog | undefined>;
  /** Read the tenant again and replace the stored catalog. */
  refresh(connection: Pick<ConnectionSummary, "id" | "name" | "tenant">): Promise<LoadedCatalog>;
  remove(connectionId: string): Promise<void>;
  link(projectId: string, connectionId: string | null): void;
}

function readLinks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function loaded(record: TenantCatalogRecord): LoadedCatalog {
  return { record, external: externalTypesFromSnapshot(record.snapshot, record.connectionName) };
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  links: typeof localStorage === "undefined" ? {} : readLinks(),
  catalogs: {},
  reading: {},
  errors: {},

  async ensure(connectionId) {
    const cached = get().catalogs[connectionId];
    if (cached) return cached;
    const record = await loadCatalog(connectionId);
    if (!record) return undefined;
    const value = loaded(record);
    set((s) => ({ catalogs: { ...s.catalogs, [connectionId]: value } }));
    return value;
  },

  async refresh(connection) {
    set((s) => ({ reading: { ...s.reading, [connection.id]: { phase: "root", message: "Starting…", counts: { aspectTypes: 0, assetTypes: 0, assets: 0, files: 0 } } }, errors: { ...s.errors, [connection.id]: undefined } }));
    try {
      const record = await readCatalog(connection, {
        onProgress: (p) => set((s) => ({ reading: { ...s.reading, [connection.id]: p } })),
      });
      await saveCatalog(record);
      const value = loaded(record);
      set((s) => ({ catalogs: { ...s.catalogs, [connection.id]: value }, reading: { ...s.reading, [connection.id]: undefined } }));
      return value;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({ reading: { ...s.reading, [connection.id]: undefined }, errors: { ...s.errors, [connection.id]: message } }));
      throw e;
    }
  },

  async remove(connectionId) {
    await deleteCatalog(connectionId);
    set((s) => {
      const catalogs = { ...s.catalogs };
      delete catalogs[connectionId];
      return { catalogs };
    });
  },

  link(projectId, connectionId) {
    const links = { ...get().links };
    if (connectionId) links[projectId] = connectionId;
    else delete links[projectId];
    localStorage.setItem(LINK_KEY, JSON.stringify(links));
    set({ links });
    if (connectionId) void get().ensure(connectionId);
  },
}));

/** The catalog linked to a project (undefined when not linked or not read yet). */
export function useLinkedCatalog(projectId: string | undefined): { connectionId?: string; catalog?: LoadedCatalog } {
  const connectionId = useCatalogStore((s) => (projectId ? s.links[projectId] : undefined));
  const catalog = useCatalogStore((s) => (connectionId ? s.catalogs[connectionId] : undefined));
  return { connectionId, catalog };
}
