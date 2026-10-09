// Test doubles for the online helpers: a scripted AmTransport and resource builders.

import type { AmRequest, AmResponse, ListRequest, ListResult } from "@/api/client";
import type {
  AmAspectTypeResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmVariableDefinition,
} from "@/api/amTypes";
import type { AmTransport } from "../transport";

export type AmHandler = (req: AmRequest) => Partial<AmResponse> & { status: number };
export type ListHandler = (req: ListRequest) => Partial<ListResult<unknown>> & { items: unknown[] };

export class FakeTransport implements AmTransport {
  readonly calls: AmRequest[] = [];
  readonly listCalls: ListRequest[] = [];
  constructor(
    private amHandler: AmHandler = () => ({ status: 200, body: {} }),
    private listHandler: ListHandler = () => ({ items: [] }),
  ) {}

  async am<T = unknown>(_connectionId: string, req: AmRequest): Promise<AmResponse<T>> {
    this.calls.push(req);
    const r = this.amHandler(req);
    return { attempts: 1, durationMs: 1, body: undefined as T, ...r } as AmResponse<T>;
  }

  async listAll<T = unknown>(_connectionId: string, req: ListRequest): Promise<ListResult<T>> {
    this.listCalls.push(req);
    const r = this.listHandler(req);
    return {
      totalElements: r.items.length,
      totalPages: 1,
      partialFailures: [],
      durationMs: 1,
      ...r,
    } as ListResult<T>;
  }
}

export function variable(name: string, over: Partial<AmVariableDefinition> = {}): AmVariableDefinition {
  return { name, dataType: "STRING", unit: null, searchable: false, length: null, defaultValue: null, ...over };
}

export function aspectType(id: string, over: Partial<AmAspectTypeResource> = {}): AmAspectTypeResource {
  return {
    id,
    tenantId: "acme",
    name: id.split(".")[1] ?? id,
    category: "static",
    scope: "private",
    variables: [variable("v1")],
    etag: 1,
    ...over,
  };
}

export function assetType(id: string, over: Partial<AmAssetTypeResource> = {}): AmAssetTypeResource {
  return {
    id,
    tenantId: "acme",
    name: id.split(".")[1] ?? id,
    parentTypeId: "core.basicasset",
    instantiable: true,
    scope: "private",
    etag: 1,
    aspects: [],
    variables: [],
    fileAssignments: [],
    ...over,
  };
}

export function asset(id: string, over: Partial<AmAssetResource> = {}): AmAssetResource {
  return {
    assetId: id,
    tenantId: "acme",
    name: `Asset ${id}`,
    typeId: "acme.Pump",
    parentId: "root",
    etag: 0,
    variables: [],
    aspects: [],
    fileAssignments: [],
    ...over,
  };
}
