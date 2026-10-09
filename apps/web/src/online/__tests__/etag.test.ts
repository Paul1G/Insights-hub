import { describe, expect, it } from "vitest";
import { UpstreamError } from "@/api/client";
import type { AmAssetTypeResource } from "@/api/amTypes";
import { assetTypeEditSession } from "../assetTypes";
import { etagOf, executePlan, parseEtag, updateWithEtag, type EditSession } from "../etag";
import { draftFromVariable } from "../variables";
import { assetType, FakeTransport, variable } from "./fakes";

interface Doc {
  id: string;
  title: string;
  etag: number;
}

function docSession(t: FakeTransport, server: { doc: Doc }, title: string): EditSession<Doc> {
  return {
    fetch: async () => {
      const res = await t.am<Doc>("c1", { method: "GET", path: `/docs/${server.doc.id}` });
      return { resource: res.body, etag: res.body.etag };
    },
    plan: (current) =>
      current.title === title
        ? []
        : [{ label: "Rename", build: (etag) => ({ method: "PATCH", path: `/docs/${current.id}`, ifMatch: etag, body: { title } }) }],
    mine: { title },
    project: (d) => ({ title: d.title }),
  };
}

/** A tiny server with optimistic locking. */
function docServer(initial: Doc) {
  const server = { doc: { ...initial } };
  const t = new FakeTransport((req) => {
    if (req.method === "GET") return { status: 200, body: { ...server.doc }, etag: String(server.doc.etag) };
    if (String(req.ifMatch) !== String(server.doc.etag)) return { status: 412, body: { errors: [{ message: "etag mismatch" }] } };
    const body = req.body as { title: string };
    server.doc = { ...server.doc, title: body.title, etag: server.doc.etag + 1 };
    return { status: 200, body: { ...server.doc }, etag: String(server.doc.etag) };
  });
  return { server, t };
}

describe("parseEtag / etagOf", () => {
  it("normalises quoted and weak etags", () => {
    expect(parseEtag("3")).toBe("3");
    expect(parseEtag('"4"')).toBe("4");
    expect(parseEtag('W/"5"')).toBe("5");
    expect(parseEtag("")).toBeUndefined();
    expect(parseEtag(undefined)).toBeUndefined();
  });

  it("prefers the header and falls back to the resource etag", () => {
    expect(etagOf({ status: 200, etag: "7", body: { etag: 6 }, attempts: 1, durationMs: 1 })).toBe("7");
    expect(etagOf({ status: 200, body: { etag: 6 }, attempts: 1, durationMs: 1 })).toBe(6);
    expect(etagOf({ status: 204, body: null, attempts: 1, durationMs: 1 })).toBeUndefined();
  });
});

describe("executePlan", () => {
  it("sends the current etag and succeeds", async () => {
    const { server, t } = docServer({ id: "d", title: "A", etag: 3 });
    const session = docSession(t, server, "B");
    const res = await executePlan(t, "c1", session, { resource: server.doc, etag: 3 });
    expect(res.kind).toBe("done");
    expect(t.calls[0]).toMatchObject({ method: "PATCH", ifMatch: 3 });
    expect(server.doc).toMatchObject({ title: "B", etag: 4 });
  });

  it("reports a conflict with the fresh server state and a diff on 412", async () => {
    const { server, t } = docServer({ id: "d", title: "A", etag: 3 });
    const stale = { ...server.doc };
    server.doc = { ...server.doc, title: "Changed elsewhere", etag: 4 };
    const session = docSession(t, server, "Mine");
    const res = await executePlan(t, "c1", session, { resource: stale, etag: 3 });
    expect(res.kind).toBe("conflict");
    if (res.kind !== "conflict") return;
    expect(res.conflict.serverEtag).toBe(4);
    expect(res.conflict.server.title).toBe("Changed elsewhere");
    expect(res.conflict.changes).toEqual([{ path: "title", kind: "changed", before: "Changed elsewhere", after: "Mine" }]);
  });

  it("throws UpstreamError for other failures", async () => {
    const t = new FakeTransport(() => ({ status: 400, body: { errors: [{ message: "bad name" }] } }));
    const session: EditSession<Doc> = {
      fetch: async () => ({ resource: { id: "d", title: "A", etag: 1 }, etag: 1 }),
      plan: () => [{ label: "x", build: (etag) => ({ method: "PATCH", path: "/d", ifMatch: etag }) }],
      mine: {},
      project: () => ({}),
    };
    await expect(executePlan(t, "c1", session, { resource: { id: "d", title: "A", etag: 1 }, etag: 1 })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("chains etags across steps (header of the previous response)", async () => {
    let etag = 5;
    const t = new FakeTransport((req) => {
      if (String(req.ifMatch) !== String(etag)) return { status: 412, body: {} };
      etag += 1;
      return { status: 204, body: null, etag: String(etag) };
    });
    const session: EditSession<Doc> = {
      fetch: async () => ({ resource: { id: "d", title: "A", etag }, etag }),
      plan: () => [
        { label: "one", build: (e) => ({ method: "PATCH", path: "/a", ifMatch: e }) },
        { label: "two", build: (e) => ({ method: "PATCH", path: "/b", ifMatch: e }) },
      ],
      mine: {},
      project: () => ({}),
    };
    const res = await executePlan(t, "c1", session, { resource: { id: "d", title: "A", etag: 5 }, etag: 5 });
    expect(res.kind).toBe("done");
    expect(t.calls.map((c) => String(c.ifMatch))).toEqual(["5", "6"]);
  });
});

describe("updateWithEtag", () => {
  it("overwrite re-applies the edit on the fresh etag", async () => {
    const { server, t } = docServer({ id: "d", title: "A", etag: 1 });
    const stale = { ...server.doc };
    server.doc = { ...server.doc, title: "Other", etag: 2 };
    const decisions: string[] = [];
    const res = await updateWithEtag(t, "c1", docSession(t, server, "Mine"), { resource: stale, etag: 1 }, async (c) => {
      decisions.push(String(c.serverEtag));
      return "overwrite";
    });
    expect(res.kind).toBe("done");
    expect(decisions).toEqual(["2"]);
    expect(server.doc).toMatchObject({ title: "Mine", etag: 3 });
    if (res.kind === "done") expect(res.overwrites).toBe(1);
  });

  it("discard leaves the server untouched", async () => {
    const { server, t } = docServer({ id: "d", title: "A", etag: 1 });
    const stale = { ...server.doc };
    server.doc = { ...server.doc, title: "Other", etag: 2 };
    const res = await updateWithEtag(t, "c1", docSession(t, server, "Mine"), { resource: stale, etag: 1 }, async () => "discard");
    expect(res.kind).toBe("discarded");
    expect(server.doc).toMatchObject({ title: "Other", etag: 2 });
  });

  it("re-plans an asset type edit against the fresh server version", async () => {
    let server: AmAssetTypeResource = assetType("acme.Pump", { variables: [variable("rpm", { unit: "1/min" })], etag: 1 });
    const original = server;
    // someone else changed the description meanwhile
    server = { ...server, description: "theirs", etag: 2 };
    const t = new FakeTransport((req) => {
      if (req.method === "GET") return { status: 200, body: server, etag: String(server.etag) };
      if (String(req.ifMatch) !== String(server.etag)) return { status: 412, body: {} };
      server = { ...server, etag: server.etag + 1 };
      return { status: req.path.endsWith("/variables") ? 204 : 200, body: req.path.endsWith("/variables") ? null : server, etag: String(server.etag) };
    });
    const drafts = original.variables.map(draftFromVariable);
    drafts[0]!.unit = "rpm";
    const session = assetTypeEditSession(t, "c1", original, {
      name: original.name,
      description: "",
      instantiable: true,
      variables: drafts,
      aspects: [],
    });
    const res = await updateWithEtag(t, "c1", session, { resource: original, etag: 1 }, async () => "overwrite");
    expect(res.kind).toBe("done");
    const writes = t.calls.filter((c) => c.method !== "GET");
    // stale attempt fails with 412; the re-plan only re-applies the user's change
    // (the unit) on the fresh etag and keeps the concurrent description change
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ path: "/assettypes/acme.Pump/variables", ifMatch: 1 });
    expect(writes[1]).toMatchObject({ method: "PATCH", path: "/assettypes/acme.Pump/variables", ifMatch: "2", body: { rpm: { unit: "rpm" } } });
    expect(server.description).toBe("theirs");
  });
});
