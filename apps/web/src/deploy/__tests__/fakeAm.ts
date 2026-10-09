// In-memory Asset Management v3 fake implementing the Transport interface for
// tests. It follows the documented semantics the engine relies on: integer
// ETags with If-Match (412 on mismatch) and If-None-Match: * (412 when the
// type exists), case-insensitive uniqueness, immutable dataType / searchable,
// string length only grows, no variable-name interchange per request, merge
// patch replacing arrays, delete guards (children, instances, usages,
// assignments) and a root asset that cannot be deleted.

import type { AmRequest, AmResponse, FileContent, FileUploadInput, ListRequest, ListResult } from "@/api/client";
import type {
  AmAspectTypeResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmFileMetadata,
  AmVariableDefinition,
} from "@/api/amTypes";
import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import type { Transport } from "../transport";

const lc = (s: string) => s.toLowerCase();
const clone = <T,>(v: T): T => structuredClone(v);

type Body = Record<string, unknown>;

export interface FakeOptions {
  tenant?: string;
  /** Intercept a request before it is handled (failure injection). */
  intercept?: (req: AmRequest) => AmResponse | undefined;
}

export class FakeAm implements Transport {
  readonly tenant: string;
  readonly root: AmAssetResource;
  readonly aspectTypes = new Map<string, AmAspectTypeResource>();
  readonly assetTypes = new Map<string, AmAssetTypeResource>();
  readonly assets = new Map<string, AmAssetResource>();
  readonly files = new Map<string, { meta: AmFileMetadata; content: FileContent }>();
  /** Every request (incl. GET) in arrival order. */
  readonly log: AmRequest[] = [];
  /** Concurrency observed for mutating requests. */
  maxInFlight = 0;
  private inFlight = 0;
  private seq = 0;
  intercept?: (req: AmRequest) => AmResponse | undefined;
  /** Artificial latency per request (ms) to exercise concurrency. */
  latencyMs = 0;
  /** Render effective asset values (type defaults included), like the backend simulator. */
  showDefaults = false;

  constructor(opts: FakeOptions = {}) {
    this.tenant = opts.tenant ?? "acme";
    this.intercept = opts.intercept;
    this.root = {
      assetId: "root0000",
      tenantId: this.tenant,
      name: this.tenant,
      typeId: "core.basicenterprise",
      timezone: "Europe/Berlin",
      twinType: "performance",
      variables: [],
      aspects: [],
      fileAssignments: [],
      etag: 0,
    };
    for (const t of BUILTIN_CORE_LIBRARY.aspectTypes) {
      this.aspectTypes.set(lc(t.id), {
        id: t.id,
        tenantId: "core",
        name: t.name,
        category: t.category,
        scope: "public",
        description: t.description,
        variables: t.variables.map((v) => ({ ...v })),
        etag: 0,
      });
    }
    for (const t of BUILTIN_CORE_LIBRARY.assetTypes) {
      this.assetTypes.set(lc(t.id), {
        id: t.id,
        tenantId: "core",
        name: t.name,
        description: t.description,
        parentTypeId: t.parentTypeId ?? "",
        instantiable: t.instantiable,
        scope: "public",
        etag: 0,
        aspects: t.aspects.map((a) => ({ name: a.name, aspectId: `core-${a.name}`, aspectType: this.aspectTypes.get(lc(a.aspectTypeId))! })),
        variables: t.variables.map((v) => ({ ...v })),
        fileAssignments: [],
      });
    }
  }

  private nextId(prefix: string): string {
    this.seq++;
    return `${prefix}${String(this.seq).padStart(6, "0")}`;
  }

  private res<T>(status: number, body: T, etag?: number): AmResponse<T> {
    return { status, body: clone(body), ...(etag !== undefined ? { etag: String(etag) } : {}), attempts: 1, durationMs: 0 };
  }

  private err(status: number, message: string): AmResponse {
    return this.res(status, { errors: [{ message, code: `fake.${status}` }] });
  }

  private etagMismatch(req: AmRequest, etag: number): boolean {
    return req.ifMatch === undefined || String(req.ifMatch) !== String(etag);
  }

  // -------------------------------------------------------------------------

  async request<T = unknown>(req: AmRequest): Promise<AmResponse<T>> {
    this.log.push(clone(req));
    const mutating = req.method !== "GET";
    if (mutating) {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    }
    try {
      if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
      const intercepted = this.intercept?.(req);
      if (intercepted) return intercepted as AmResponse<T>;
      return this.handle(req) as AmResponse<T>;
    } finally {
      if (mutating) this.inFlight--;
    }
  }

  private handle(req: AmRequest): AmResponse {
    const p = req.path.split("/").filter(Boolean).map(decodeURIComponent);
    const body = (req.body ?? {}) as Body;
    const [col, id, sub, key] = p;
    if (col === "assets" && id === "root" && req.method === "GET") return this.res(200, this.root, this.root.etag);
    if (col === "aspecttypes" && id) return this.aspectType(req, id, sub, body);
    if (col === "assettypes" && id) return this.assetType(req, id, sub, key, body);
    if (col === "assets" && !id && req.method === "POST") return this.createAsset(body);
    if (col === "assets" && id) return this.asset(req, id, sub, key, body);
    if (col === "files" && id) return this.file(req, id);
    return this.err(400, `Operation ${req.method} ${req.path} is not supported by the fake.`);
  }

  // Aspect types ------------------------------------------------------------

  private aspectType(req: AmRequest, id: string, sub: string | undefined, body: Body): AmResponse {
    const cur = this.aspectTypes.get(lc(id));
    if (req.method === "GET" && !sub) return cur ? this.res(200, cur, cur.etag) : this.err(404, "Aspect type not found");
    if (req.method === "PUT" && !sub) {
      if (cur) {
        if (req.ifNoneMatch === "*") return this.err(412, "Aspect type already exists");
        return this.err(400, "PUT updates are not used by the engine");
      }
      if (!lc(id).startsWith(`${lc(this.tenant)}.`)) return this.err(400, "Type id must start with the tenant name");
      const name = String(body.name);
      for (const t of this.aspectTypes.values()) if (lc(t.name) === lc(name) && !lc(t.id).startsWith("core.")) return this.err(400, "Aspect type name already used");
      const res: AmAspectTypeResource = {
        id,
        tenantId: this.tenant,
        name,
        category: body.category as "static" | "dynamic",
        scope: "private",
        ...(body.description ? { description: String(body.description) } : {}),
        variables: clone(body.variables as AmVariableDefinition[]),
        etag: 0,
      };
      this.aspectTypes.set(lc(id), res);
      return this.res(201, res, 0);
    }
    if (!cur) return this.err(404, "Aspect type not found");
    if (req.method === "DELETE") {
      if (this.etagMismatch(req, cur.etag)) return this.err(412, "Changed in the background");
      for (const t of this.assetTypes.values()) if (t.aspects.some((a) => lc(a.aspectType.id) === lc(id))) return this.err(400, "Aspect type is in use");
      this.aspectTypes.delete(lc(id));
      return this.res(204, null);
    }
    if (req.method === "PATCH" && !sub) {
      if (this.etagMismatch(req, cur.etag)) return this.err(412, "Changed in the background");
      if (body.description === null) delete cur.description;
      else if (typeof body.description === "string") cur.description = body.description;
      cur.etag++;
      return this.res(200, cur, cur.etag);
    }
    if (req.method === "PATCH" && sub === "variables") {
      if (this.etagMismatch(req, cur.etag)) return this.err(412, "Changed in the background");
      const vars = clone(cur.variables);
      const err = applyVariableMap(vars, body as Record<string, Body | null>, { allowAdd: true, allowDelete: true, category: cur.category });
      if (err) return this.err(400, err);
      cur.variables = vars;
      cur.etag++;
      this.renameAspectVariableValues(id, renamesOf(body as Record<string, Body | null>));
      this.prune();
      return this.res(204, null, cur.etag);
    }
    return this.err(400, "Unsupported aspect type operation");
  }

  // Asset types -------------------------------------------------------------

  private resolveAspects(list: { name: string; aspectId?: string; aspectTypeId: string }[], current: AmAssetTypeResource["aspects"]): AmAssetTypeResource["aspects"] | string {
    const out: AmAssetTypeResource["aspects"] = [];
    const names = new Set<string>();
    for (const a of list) {
      const at = this.aspectTypes.get(lc(a.aspectTypeId));
      if (!at) return `Aspect type ${a.aspectTypeId} does not exist`;
      if (names.has(lc(a.name))) return `Duplicate aspect name ${a.name}`;
      names.add(lc(a.name));
      if (a.aspectId) {
        const existing = current.find((x) => x.aspectId === a.aspectId);
        if (!existing) return `Unknown aspectId ${a.aspectId}`;
        out.push({ name: a.name, aspectId: a.aspectId, aspectType: at });
      } else {
        out.push({ name: a.name, aspectId: this.nextId("asp"), aspectType: at });
      }
    }
    return out;
  }

  private assetType(req: AmRequest, id: string, sub: string | undefined, key: string | undefined, body: Body): AmResponse {
    const cur = this.assetTypes.get(lc(id));
    if (req.method === "GET" && !sub) return cur ? this.res(200, cur, cur.etag) : this.err(404, "Asset type not found");
    if (req.method === "PUT" && !sub) {
      if (cur) return req.ifNoneMatch === "*" ? this.err(412, "Asset type already exists") : this.err(400, "PUT updates are not used by the engine");
      if (!lc(id).startsWith(`${lc(this.tenant)}.`)) return this.err(400, "Type id must start with the tenant name");
      const parent = this.assetTypes.get(lc(String(body.parentTypeId)));
      if (!parent) return this.err(400, `Parent type ${String(body.parentTypeId)} does not exist`);
      const aspects = this.resolveAspects((body.aspects as never[]) ?? [], []);
      if (typeof aspects === "string") return this.err(400, aspects);
      const res: AmAssetTypeResource = {
        id,
        tenantId: this.tenant,
        name: String(body.name),
        ...(body.description ? { description: String(body.description) } : {}),
        parentTypeId: parent.id,
        instantiable: body.instantiable !== false,
        scope: "private",
        etag: 0,
        aspects,
        variables: clone((body.variables as AmVariableDefinition[]) ?? []),
        fileAssignments: [],
      };
      this.assetTypes.set(lc(id), res);
      return this.res(201, res, 0);
    }
    if (!cur) return this.err(404, "Asset type not found");
    if (this.etagMismatch(req, cur.etag)) return this.err(412, "Changed in the background");
    if (req.method === "DELETE" && !sub) {
      for (const t of this.assetTypes.values()) if (lc(t.parentTypeId) === lc(id)) return this.err(400, "Asset type has child types");
      for (const a of this.assets.values()) if (lc(a.typeId) === lc(id)) return this.err(400, "Asset type has instances");
      this.assetTypes.delete(lc(id));
      return this.res(204, null);
    }
    if (req.method === "PATCH" && !sub) {
      if (body.parentTypeId !== undefined && lc(String(body.parentTypeId)) !== lc(cur.parentTypeId)) return this.err(400, "parentTypeId cannot be changed");
      if (body.instantiable === false && cur.instantiable) return this.err(400, "An instantiable type cannot become non-instantiable");
      const next = clone(cur);
      if (typeof body.name === "string") next.name = body.name;
      if (body.description === null) delete next.description;
      else if (typeof body.description === "string") next.description = body.description;
      if (body.instantiable === true) next.instantiable = true;
      if (Array.isArray(body.variables)) {
        const incoming = body.variables as AmVariableDefinition[];
        for (const v of incoming) {
          const old = cur.variables.find((x) => lc(x.name) === lc(v.name));
          if (old && (old.dataType !== v.dataType || !!old.searchable !== !!v.searchable)) return this.err(400, `dataType/searchable of ${v.name} cannot be changed`);
          if (old && old.dataType === "STRING" && (v.length ?? 255) < (old.length ?? 255)) return this.err(400, `length of ${v.name} cannot decrease`);
        }
        const names = new Set<string>();
        for (const v of incoming) {
          if (names.has(lc(v.name))) return this.err(400, `Duplicate variable ${v.name}`);
          names.add(lc(v.name));
        }
        next.variables = clone(incoming);
      }
      const aspectRenames = new Map<string, string>();
      if (Array.isArray(body.aspects)) {
        const aspects = this.resolveAspects(body.aspects as never[], cur.aspects);
        if (typeof aspects === "string") return this.err(400, aspects);
        for (const a of aspects) {
          const old = cur.aspects.find((x) => x.aspectId === a.aspectId);
          if (old && old.name !== a.name) aspectRenames.set(lc(old.name), a.name);
        }
        next.aspects = aspects;
      }
      next.etag = cur.etag + 1;
      this.assetTypes.set(lc(id), next);
      this.renameAssetValues(id, aspectRenames, "aspects");
      this.prune();
      return this.res(200, next, next.etag);
    }
    if (req.method === "PATCH" && sub === "variables") {
      const vars = clone(cur.variables);
      const err = applyVariableMap(vars, body as Record<string, Body | null>, { allowAdd: false, allowDelete: false });
      if (err) return this.err(err.startsWith("Unknown") ? 404 : 400, err);
      cur.variables = vars;
      cur.etag++;
      this.renameAssetValues(id, renamesOf(body as Record<string, Body | null>), "variables");
      return this.res(204, null, cur.etag);
    }
    if (sub === "fileAssignments" && key) {
      return this.assignment(req, cur, key, body);
    }
    return this.err(400, "Unsupported asset type operation");
  }

  private assignment(req: AmRequest, holder: { fileAssignments: { key: string; fileId: string }[]; etag: number }, key: string, body: Body): AmResponse {
    if (req.method === "PUT") {
      const fileId = String(body.fileId);
      if (!this.files.has(fileId)) return this.err(400, `File ${fileId} does not exist`);
      holder.fileAssignments = holder.fileAssignments.filter((f) => lc(f.key) !== lc(key));
      holder.fileAssignments.push({ key, fileId });
      this.files.get(fileId)!.meta.isAssigned = true;
    } else if (req.method === "DELETE") {
      if (!holder.fileAssignments.some((f) => lc(f.key) === lc(key))) return this.err(404, "Key not found");
      holder.fileAssignments = holder.fileAssignments.filter((f) => lc(f.key) !== lc(key));
    } else return this.err(400, "Unsupported assignment operation");
    holder.etag++;
    return this.res(200, holder, holder.etag);
  }

  // Assets ------------------------------------------------------------------

  private createAsset(body: Body): AmResponse {
    const parentId = String(body.parentId);
    const parent = parentId === this.root.assetId ? this.root : this.assets.get(parentId);
    if (!parent) return this.err(400, "Parent asset does not exist");
    const type = this.assetTypes.get(lc(String(body.typeId)));
    if (!type) return this.err(400, `Type ${String(body.typeId)} does not exist`);
    if (!type.instantiable) return this.err(400, "Type is not instantiable");
    const name = String(body.name);
    for (const a of this.assets.values()) if (a.parentId === parentId && lc(a.name) === lc(name)) return this.err(400, "Sibling with the same name exists");
    const res: AmAssetResource = {
      assetId: this.nextId("asset"),
      tenantId: this.tenant,
      name,
      ...(body.externalId ? { externalId: String(body.externalId) } : {}),
      ...(body.description ? { description: String(body.description) } : {}),
      ...(body.location ? { location: clone(body.location as Body) } : {}),
      variables: clone((body.variables as never[]) ?? []),
      aspects: clone((body.aspects as never[]) ?? []),
      fileAssignments: [],
      typeId: type.id,
      parentId,
      timezone: (body.timezone as string | undefined) ?? this.root.timezone,
      twinType: (body.twinType as "performance" | "simulation" | undefined) ?? "performance",
      etag: 0,
    };
    if (!res.location && parent.location) res.location = clone(parent.location);
    this.assets.set(res.assetId, res);
    return this.res(201, res, 0);
  }

  private asset(req: AmRequest, id: string, sub: string | undefined, key: string | undefined, body: Body): AmResponse {
    const cur = id === this.root.assetId ? this.root : this.assets.get(id);
    if (!cur) return this.err(404, "Asset not found");
    if (req.method === "GET" && !sub) return this.res(200, this.render(cur), cur.etag);
    if (this.etagMismatch(req, cur.etag)) return this.err(412, "Changed in the background");
    if (req.method === "DELETE" && !sub) {
      if (cur === this.root) return this.err(400, "The root asset cannot be deleted");
      for (const a of this.assets.values()) if (a.parentId === id) return this.err(400, "Asset has children");
      this.assets.delete(id);
      return this.res(204, null);
    }
    if (req.method === "PATCH" && !sub) {
      for (const k of ["name", "externalId", "description"] as const) {
        if (body[k] === null) delete (cur as unknown as Body)[k];
        else if (typeof body[k] === "string") (cur as unknown as Body)[k] = body[k];
      }
      if (Array.isArray(body.variables)) cur.variables = clone(body.variables as never[]);
      if (Array.isArray(body.aspects)) cur.aspects = clone(body.aspects as never[]);
      cur.etag++;
      return this.res(200, cur, cur.etag);
    }
    if (req.method === "POST" && sub === "move") {
      const newParentId = String(body.newParentId);
      const parent = newParentId === this.root.assetId ? this.root : this.assets.get(newParentId);
      if (!parent) return this.err(400, "New parent does not exist");
      let p: AmAssetResource | undefined = parent;
      while (p) {
        if (p.assetId === id) return this.err(400, "Cannot move into the own subtree");
        p = p.parentId ? (p.parentId === this.root.assetId ? this.root : this.assets.get(p.parentId)) : undefined;
      }
      for (const a of this.assets.values()) if (a.parentId === newParentId && lc(a.name) === lc(cur.name)) return this.err(400, "Sibling with the same name exists");
      cur.parentId = newParentId;
      cur.etag++;
      return this.res(200, cur, cur.etag);
    }
    if (sub === "location") {
      if (req.method === "PUT") cur.location = clone(body);
      else if (req.method === "DELETE") delete cur.location;
      cur.etag++;
      return this.res(200, cur, cur.etag);
    }
    if (sub === "fileAssignments" && key) return this.assignment(req, cur, key, body);
    return this.err(400, "Unsupported asset operation");
  }

  // Files -------------------------------------------------------------------

  private file(req: AmRequest, id: string): AmResponse {
    const f = this.files.get(id);
    if (!f) return this.err(404, "File not found");
    if (req.method === "GET") return this.res(200, f.meta, f.meta.etag);
    if (req.method === "DELETE") {
      if (this.etagMismatch(req, f.meta.etag)) return this.err(412, "Changed in the background");
      const assigned = [...this.assets.values(), ...this.assetTypes.values()].some((h) => h.fileAssignments.some((x) => x.fileId === id));
      if (assigned) return this.err(400, "File is assigned");
      this.files.delete(id);
      return this.res(204, null);
    }
    return this.err(400, "Unsupported file operation");
  }

  async uploadFile(input: FileUploadInput): Promise<AmResponse<AmFileMetadata>> {
    this.log.push({ method: "POST", path: "/files", body: { name: input.name } });
    const meta: AmFileMetadata = {
      id: this.nextId("file"),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      scope: input.scope ?? "private",
      etag: 0,
      lastModified: `2026-01-01T00:00:${String(this.seq % 60).padStart(2, "0")}Z`,
    };
    this.files.set(meta.id, { meta, content: { mimeType: input.mimeType, contentBase64: input.contentBase64 } });
    return this.res(201, meta, 0);
  }

  async replaceFile(fileId: string, ifMatch: string | number, input: FileUploadInput): Promise<AmResponse<AmFileMetadata>> {
    this.log.push({ method: "PUT", path: `/files/${fileId}`, ifMatch, body: { name: input.name } });
    const f = this.files.get(fileId);
    if (!f) return this.err(404, "File not found") as AmResponse<AmFileMetadata>;
    if (String(ifMatch) !== String(f.meta.etag)) return this.err(412, "Changed in the background") as AmResponse<AmFileMetadata>;
    f.meta.name = input.name;
    f.meta.description = input.description;
    f.meta.scope = input.scope ?? "private";
    f.meta.etag++;
    f.meta.lastModified = `2026-01-02T00:00:${String(f.meta.etag).padStart(2, "0")}Z`;
    f.content = { mimeType: input.mimeType, contentBase64: input.contentBase64 };
    return this.res(200, f.meta, f.meta.etag);
  }

  async downloadFile(fileId: string): Promise<AmResponse<FileContent>> {
    const f = this.files.get(fileId);
    if (!f) return this.err(404, "File not found") as AmResponse<FileContent>;
    return this.res(200, f.content);
  }

  async listAll<T = unknown>(req: ListRequest): Promise<ListResult<T>> {
    let items: unknown[];
    switch (req.resource) {
      case "assets":
        items = [this.root, ...this.assets.values()].map((a) => this.render(a));
        break;
      case "assettypes":
        items = [...this.assetTypes.values()];
        break;
      case "aspecttypes":
        items = [...this.aspectTypes.values()];
        break;
      case "files":
        items = [...this.files.values()].map((f) => f.meta);
        break;
      default:
        items = [];
    }
    if (req.filter) {
      const filter = JSON.parse(req.filter) as Record<string, string>;
      items = items.filter((it) => Object.entries(filter).every(([k, v]) => (it as Body)[k] === v));
    }
    return { items: clone(items) as T[], totalElements: items.length, totalPages: 1, partialFailures: [], durationMs: 0 };
  }

  // Value propagation (renames propagate to instances, removed members lose their values)

  private chainOf(typeId: string): AmAssetTypeResource[] {
    const out: AmAssetTypeResource[] = [];
    const seen = new Set<string>();
    let cur = this.assetTypes.get(lc(typeId));
    while (cur && !seen.has(lc(cur.id))) {
      out.push(cur);
      seen.add(lc(cur.id));
      cur = cur.parentTypeId ? this.assetTypes.get(lc(cur.parentTypeId)) : undefined;
    }
    return out;
  }

  private instancesOf(typeId: string): AmAssetResource[] {
    return [...this.assets.values()].filter((a) => this.chainOf(a.typeId).some((t) => lc(t.id) === lc(typeId)));
  }

  private renameAssetValues(typeId: string, renames: Map<string, string>, what: "variables" | "aspects"): void {
    if (!renames.size) return;
    for (const a of this.instancesOf(typeId)) {
      const list = what === "variables" ? a.variables : a.aspects;
      for (const x of list) x.name = renames.get(lc(x.name)) ?? x.name;
    }
  }

  private renameAspectVariableValues(aspectTypeId: string, renames: Map<string, string>): void {
    if (!renames.size) return;
    for (const a of this.assets.values()) {
      const aspectNames = new Set(
        this.chainOf(a.typeId).flatMap((t) => t.aspects.filter((x) => lc(x.aspectType.id) === lc(aspectTypeId)).map((x) => lc(x.name))),
      );
      for (const av of a.aspects) {
        if (!aspectNames.has(lc(av.name))) continue;
        for (const x of av.variables) x.name = renames.get(lc(x.name)) ?? x.name;
      }
    }
  }

  /** Asset as returned by GET: explicit values, or effective values when showDefaults is on. */
  private render(a: AmAssetResource): AmAssetResource {
    if (!this.showDefaults) return a;
    const chain = this.chainOf(a.typeId);
    const explicit = new Map(a.variables.map((v) => [lc(v.name), v.value]));
    const variables = chain.flatMap((t) => t.variables).flatMap((v) => {
      const value = explicit.get(lc(v.name)) ?? v.defaultValue ?? undefined;
      return value === undefined || value === null ? [] : [{ name: v.name, value }];
    });
    const aspects = chain.flatMap((t) => t.aspects).flatMap((asp) => {
      const at = this.aspectTypes.get(lc(asp.aspectType.id));
      if (!at || at.category !== "static") return [];
      const own = new Map((a.aspects.find((x) => lc(x.name) === lc(asp.name))?.variables ?? []).map((v) => [lc(v.name), v.value]));
      const vars = at.variables.flatMap((v) => {
        const value = own.get(lc(v.name)) ?? v.defaultValue ?? undefined;
        return value === undefined || value === null ? [] : [{ name: v.name, value }];
      });
      return vars.length ? [{ name: asp.name, variables: vars }] : [];
    });
    return { ...a, variables, aspects };
  }

  private prune(): void {
    for (const a of this.assets.values()) {
      const chain = this.chainOf(a.typeId);
      const vars = new Set(chain.flatMap((t) => t.variables.map((x) => lc(x.name))));
      const aspects = new Map(chain.flatMap((t) => t.aspects.map((x) => [lc(x.name), this.aspectTypes.get(lc(x.aspectType.id))] as const)));
      a.variables = a.variables.filter((x) => vars.has(lc(x.name)));
      a.aspects = a.aspects
        .filter((x) => aspects.get(lc(x.name))?.category === "static")
        .map((x) => {
          const allowed = new Set(aspects.get(lc(x.name))!.variables.map((y) => lc(y.name)));
          return { name: x.name, variables: x.variables.filter((y) => allowed.has(lc(y.name))) };
        });
    }
  }

  // Test helpers --------------------------------------------------------------

  mutations(): AmRequest[] {
    return this.log.filter((r) => r.method !== "GET");
  }

  assetByName(name: string): AmAssetResource | undefined {
    return [...this.assets.values()].find((a) => a.name === name);
  }
}

function renamesOf(map: Record<string, Body | null>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(map)) {
    if (value && typeof value.name === "string" && value.name !== key) out.set(lc(key), value.name);
  }
  return out;
}

/** Apply a variable merge-patch map with the documented validations. */
function applyVariableMap(
  vars: AmVariableDefinition[],
  map: Record<string, Body | null>,
  opts: { allowAdd: boolean; allowDelete: boolean; category?: "static" | "dynamic" },
): string | undefined {
  const before = new Map(vars.map((v) => [lc(v.name), v]));
  const renamedTargets = new Set<string>();
  for (const [key, value] of Object.entries(map)) {
    const cur = before.get(lc(key));
    if (value === null) {
      if (!opts.allowDelete) return "Variables cannot be deleted with this operation";
      if (!cur) return `Unknown variable ${key}`;
      continue;
    }
    if (!cur) {
      if (!opts.allowAdd) return `Unknown variable ${key}`;
      if (!value.dataType) return `New variable ${key} needs a dataType`;
      continue;
    }
    if (value.name !== undefined && lc(String(value.name)) !== lc(cur.name)) {
      const target = lc(String(value.name));
      // Interchanging names (the new name is currently held by another variable) is rejected.
      if (before.has(target)) return `Variable names must not be interchanged in one request (${key} → ${String(value.name)})`;
      if (renamedTargets.has(target)) return `Two variables renamed to ${String(value.name)}`;
      renamedTargets.add(target);
    }
    if (value.dataType !== undefined && value.dataType !== cur.dataType) return `dataType of ${key} cannot be changed`;
    if (value.searchable !== undefined && !!value.searchable !== !!cur.searchable) return `searchable of ${key} cannot be changed`;
    if (typeof value.length === "number" && cur.length !== null && cur.length !== undefined) {
      if (value.length < cur.length) return `length of ${key} cannot decrease`;
      if (opts.category === "dynamic" && value.length !== cur.length) return `length of dynamic ${key} cannot change`;
    }
  }
  for (const [key, value] of Object.entries(map)) {
    const idx = vars.findIndex((v) => lc(v.name) === lc(key));
    if (value === null) {
      vars.splice(idx, 1);
      continue;
    }
    if (idx < 0) {
      vars.push({ name: String(value.name ?? key), ...(value as object) } as AmVariableDefinition);
      continue;
    }
    const v = vars[idx]!;
    for (const [k, val] of Object.entries(value)) {
      if (val === null) delete (v as unknown as Body)[k];
      else (v as unknown as Body)[k] = val;
    }
  }
  const names = new Set<string>();
  for (const v of vars) {
    if (names.has(lc(v.name))) return `Duplicate variable name ${v.name}`;
    names.add(lc(v.name));
  }
  return undefined;
}
