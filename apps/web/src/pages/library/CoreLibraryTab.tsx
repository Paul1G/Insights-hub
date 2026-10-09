// "Core library" tab: read-only browser of the core (OOTB) asset and aspect
// types, tenant sync with a preview diff, reset to the built-in snapshot and
// "Extend in project".

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxChip, IxInput, IxSelect, IxSelectItem, IxSpinner, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconCloudDownload, iconLock, iconReset } from "@siemens/ix-icons/icons";
import type { AmAspectTypeResource, AmAssetTypeResource } from "@/api/amTypes";
import { api, type ConnectionSummary } from "@/api/client";
import { confirmDialog } from "@/components/dialogs";
import { DiffView } from "@/components/DiffView";
import { notifyError, notifySuccess } from "@/components/notify";
import {
  BASIC_ASSET_TYPE_ID,
  type CoreAspectType,
  type CoreAssetType,
  type CoreLibrary,
  type CoreLibraryIndex,
} from "@/domain/coreLibrary";
import { nowIso } from "@/domain/model";
import { DomainError, newAssetType, touch } from "@/domain/ops";
import { PATTERNS } from "@/domain/rules";
import { coreLibraryFromTenant, diffCoreLibraries, type CoreLibraryDiff } from "@/features/library/coreSync";
import { formDialog } from "@/features/types/formDialog";
import { dialogStyles, masterDetailStyles as md } from "@/features/types/styles";
import { DetailHeader, DetailSection, MasterDetail, MasterItem, MasterList } from "@/features/types/MasterDetail";
import { isExtendableCoreType } from "@/features/types/parentOptions";
import { ReadonlyVariables } from "@/features/types/ReadonlyVariables";
import { filterTreeRows, flattenForest, textMatch } from "@/features/types/typeTree";
import { listProjects, loadProject, saveProject } from "@/storage/repository";
import { useMeStore } from "@/state/meStore";
import { useProjectStore } from "@/state/projectStore";
import { useSettingsStore } from "@/state/settingsStore";
import styles from "./Library.module.css";

type Selection = { kind: "asset" | "aspect"; id: string };

function sourceText(lib: CoreLibrary): string {
  if (lib.source === "builtin") return "Built-in snapshot transcribed from the Insights Hub documentation (Basic Asset Types).";
  const at = lib.syncedAt ? new Date(lib.syncedAt).toLocaleString() : "an unknown time";
  return `Synced from tenant connection “${lib.syncedFrom ?? "unknown"}” on ${at}.`;
}

function connectionLabel(c: ConnectionSummary): string {
  return `${c.name} — tenant ${c.tenant}${c.environment ? `, ${c.environment}` : ""}${c.authMode === "simulator" ? " (simulator, not a real tenant)" : ""}`;
}

function DiffPreview({ diff }: { diff: CoreLibraryDiff }) {
  const groups: { label: string; d: CoreLibraryDiff["assetTypes"] | CoreLibraryDiff["aspectTypes"] }[] = [
    { label: "Asset types", d: diff.assetTypes },
    { label: "Aspect types", d: diff.aspectTypes },
  ];
  return (
    <div className={dialogStyles.stack}>
      {groups.map(({ label, d }) => (
        <div key={label} className={dialogStyles.stack}>
          <h3 className={`typography-h6 ${dialogStyles.subheading}`}>
            {label}: {d.added.length} added · {d.changed.length} changed · {d.removed.length} removed · {d.unchanged} unchanged
          </h3>
          {d.added.length ? (
            <IxTypography format="body-sm" className={dialogStyles.text}>
              Added: {d.added.map((t) => t.id).join(", ")}
            </IxTypography>
          ) : null}
          {d.removed.length ? (
            <IxTypography format="body-sm" className={dialogStyles.text}>
              Removed: {d.removed.map((t) => t.id).join(", ")}
            </IxTypography>
          ) : null}
          {d.changed.slice(0, 15).map((c) => (
            <div key={c.after.id} className={dialogStyles.stack}>
              <IxTypography format="label">{c.after.id}</IxTypography>
              <DiffView changes={c.changes.slice(0, 20)} beforeLabel="Current" afterLabel="Tenant" />
            </div>
          ))}
          {d.changed.length > 15 ? (
            <IxTypography format="body-sm" textColor="soft">
              and {d.changed.length - 15} more changed types
            </IxTypography>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function suggestedName(core: CoreAssetType): string {
  const base = core.name.replace(/^Basic/, "") || core.name;
  return `My${base}`;
}

function assetTypeNameError(name: string): string | undefined {
  if (!name.trim()) return "Enter a name.";
  if (!PATTERNS.assetTypeName.test(name)) return "Use letters, digits, _, . and spaces only.";
  return undefined;
}

function AssetTypeDetail({
  type,
  core,
  onSelect,
  onExtend,
}: {
  type: CoreAssetType;
  core: CoreLibraryIndex;
  onSelect: (s: Selection) => void;
  onExtend: (t: CoreAssetType) => void;
}) {
  const chain = core.assetTypeChain(type.id);
  const extendable = isExtendableCoreType(core, type.id);
  const recommended = type.id.toLowerCase() === BASIC_ASSET_TYPE_ID;
  const inheritedVars = chain.slice(1).flatMap((t) => t.variables.map((v) => ({ ...v, origin: t.name })));
  const aspects = chain.flatMap((t) =>
    t.aspects.map((a) => ({ ...a, definedOn: t.name, inherited: t.id !== type.id, aspectType: core.aspectType(a.aspectTypeId) })),
  );
  const totalVariables =
    chain.reduce((n, t) => n + t.variables.length, 0) + aspects.reduce((n, a) => n + (a.aspectType?.variables.length ?? 0), 0);
  const subtypes = core.library.assetTypes.filter((t) => t.parentTypeId?.toLowerCase() === type.id.toLowerCase());

  return (
    <>
      <DetailHeader
        title={type.name}
        subtitle={`${type.id}${type.parentTypeId ? ` · extends ${type.parentTypeId}` : ""}`}
        badges={
          <>
            <IxChip variant="neutral" outline icon={iconLock} inactive>
              Core · read-only
            </IxChip>
            <IxChip variant={type.instantiable ? "success" : "neutral"} outline inactive>
              {type.instantiable ? "Instantiable" : "Abstract"}
            </IxChip>
            {type.deprecated ? (
              <IxChip variant="warning" outline inactive>
                Deprecated
              </IxChip>
            ) : null}
            {recommended ? (
              <IxChip variant="success" inactive>
                Recommended no-cost parent
              </IxChip>
            ) : null}
          </>
        }
        actions={
          <IxButton variant="primary" icon={iconAdd} disabled={!extendable} onClick={() => onExtend(type)}>
            Extend in project
          </IxButton>
        }
      />
      {type.description ? (
        <IxTypography format="body" className={md.text}>
          {type.description}
        </IxTypography>
      ) : null}

      <DetailSection title="Billing impact" readOnly>
        <ul className={styles.bullets}>
          <li>
            <IxTypography format="body-sm">
              Core types contribute 0 billable attributes: a project type that inherits from {type.name} inherits its{" "}
              {totalVariables} variable{totalVariables === 1 ? "" : "s"} (incl. aspects) without billing them — they still count
              towards the variable and aspect limits.
            </IxTypography>
          </li>
          <li>
            <IxTypography format="body-sm">
              {type.instantiable
                ? "Every asset created directly from this type counts 1 asset attribute."
                : "This type is abstract: assets cannot be created from it directly."}
            </IxTypography>
          </li>
          <li>
            <IxTypography format="body-sm">Variables of core aspect types are excluded from billing.</IxTypography>
          </li>
          {recommended ? (
            <li>
              <IxTypography format="body-sm">
                core.basicasset has no billable attribute and is the recommended parent to start purpose-specific types.
              </IxTypography>
            </li>
          ) : null}
          {!extendable ? (
            <li>
              <IxTypography format="body-sm">
                Root hierarchy types are reserved for tenant and subtenant roots and cannot be extended.
              </IxTypography>
            </li>
          ) : null}
        </ul>
      </DetailSection>

      <DetailSection title="Inheritance" readOnly>
        <ol className={styles.chain} aria-label="Inheritance chain">
          {[...chain].reverse().map((t, i, all) => (
            <li key={t.id} className={styles.chainItem}>
              {i === all.length - 1 ? (
                <IxTypography format="label" aria-current="true">
                  {t.name}
                </IxTypography>
              ) : (
                <IxButton variant="tertiary" onClick={() => onSelect({ kind: "asset", id: t.id })}>
                  {t.name}
                </IxButton>
              )}
              {i < all.length - 1 ? (
                <IxTypography format="body-sm" textColor="soft" aria-hidden="true">
                  ›
                </IxTypography>
              ) : null}
            </li>
          ))}
        </ol>
        {subtypes.length ? (
          <div className={md.inlineRow}>
            <IxTypography format="label-sm" textColor="soft">
              Core subtypes:
            </IxTypography>
            {subtypes.map((s) => (
              <IxButton key={s.id} variant="tertiary" onClick={() => onSelect({ kind: "asset", id: s.id })}>
                {s.name}
              </IxButton>
            ))}
          </div>
        ) : null}
      </DetailSection>

      <DetailSection title={`Variables (${type.variables.length})`} readOnly>
        <ReadonlyVariables caption={`Variables of ${type.name}`} variables={type.variables} empty="No own variables." />
      </DetailSection>

      {inheritedVars.length ? (
        <DetailSection title={`Inherited variables (${inheritedVars.length})`} readOnly>
          <ReadonlyVariables caption={`Inherited variables of ${type.name}`} variables={inheritedVars} showOrigin />
        </DetailSection>
      ) : null}

      <DetailSection title={`Aspects (${aspects.length})`} readOnly>
        {aspects.length ? (
          <div className={md.tableScroll}>
            <table className={md.table}>
              <caption className="visually-hidden">Aspects of {type.name}</caption>
              <thead>
                <tr>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Aspect</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Aspect type</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Category</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Variables</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Defined on</IxTypography></th>
                </tr>
              </thead>
              <tbody>
                {aspects.map((a) => (
                  <tr key={`${a.definedOn}:${a.name}`}>
                    <td><IxTypography format="code-sm">{a.name}</IxTypography></td>
                    <td>
                      {a.aspectType ? (
                        <IxButton variant="tertiary" onClick={() => onSelect({ kind: "aspect", id: a.aspectTypeId })}>
                          {a.aspectType.name}
                        </IxButton>
                      ) : (
                        <IxTypography format="body-sm" textColor="soft">{a.aspectTypeId} (not in library)</IxTypography>
                      )}
                    </td>
                    <td><IxTypography format="body-sm">{a.aspectType?.category ?? "—"}</IxTypography></td>
                    <td><IxTypography format="body-sm">{a.aspectType?.variables.length ?? "—"}</IxTypography></td>
                    <td>
                      <IxTypography format="body-sm" textColor="soft">{a.inherited ? `${a.definedOn} (inherited)` : "this type"}</IxTypography>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <IxTypography format="body-sm" textColor="soft">No aspects.</IxTypography>
        )}
      </DetailSection>
    </>
  );
}

function AspectTypeDetail({ type, core, onSelect }: { type: CoreAspectType; core: CoreLibraryIndex; onSelect: (s: Selection) => void }) {
  const usedBy = core.library.assetTypes.filter((t) => t.aspects.some((a) => a.aspectTypeId.toLowerCase() === type.id.toLowerCase()));
  return (
    <>
      <DetailHeader
        title={type.name}
        subtitle={`${type.id} · ${type.category} · ${type.variables.length} variable${type.variables.length === 1 ? "" : "s"}`}
        badges={
          <>
            <IxChip variant="neutral" outline icon={iconLock} inactive>
              Core · read-only
            </IxChip>
            <IxChip variant={type.category === "dynamic" ? "info" : "neutral"} outline inactive>
              {type.category === "dynamic" ? "Dynamic (time series)" : "Static"}
            </IxChip>
            <IxChip variant="success" outline inactive>
              Not billable
            </IxChip>
          </>
        }
      />
      {type.description ? (
        <IxTypography format="body" className={md.text}>
          {type.description}
        </IxTypography>
      ) : null}
      <DetailSection
        title={`Variables (${type.variables.length})`}
        description="Variables of core aspect types are defined for internal purposes and excluded from billing. Project asset types can add this aspect type as an aspect."
        readOnly
      >
        <ReadonlyVariables caption={`Variables of ${type.name}`} variables={type.variables} showQualityCode />
      </DetailSection>
      <DetailSection title={`Used by core asset types (${usedBy.length})`} readOnly>
        {usedBy.length ? (
          <div className={md.inlineRow}>
            {usedBy.map((t) => (
              <IxButton key={t.id} variant="tertiary" onClick={() => onSelect({ kind: "asset", id: t.id })}>
                {t.name}
              </IxButton>
            ))}
          </div>
        ) : (
          <IxTypography format="body-sm" textColor="soft">No core asset type uses it.</IxTypography>
        )}
      </DetailSection>
    </>
  );
}

export function CoreLibraryTab() {
  const navigate = useNavigate();
  const library = useSettingsStore((s) => s.coreLibrary);
  const core = useSettingsStore((s) => s.coreIndex);
  const setCoreLibrary = useSettingsStore((s) => s.setCoreLibrary);
  const resetCoreLibrary = useSettingsStore((s) => s.resetCoreLibrary);
  const backendOnline = useMeStore((s) => s.backendOnline);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "asset", id: BASIC_ASSET_TYPE_ID });
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      flattenForest(
        library.assetTypes,
        (t) => t.id.toLowerCase(),
        (t) => t.parentTypeId?.toLowerCase() ?? undefined,
        (a, b) => a.name.localeCompare(b.name),
      ),
    [library.assetTypes],
  );
  const assetMatch = (t: CoreAssetType) => textMatch(query, t.name, t.id, t.description);
  const visibleRows = query.trim() ? filterTreeRows(rows, assetMatch) : rows;
  const visibleAspects = [...library.aspectTypes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((t) => textMatch(query, t.name, t.id, t.description));
  const matchCount = (query.trim() ? visibleRows.filter((r) => assetMatch(r.item)).length : rows.length) + visibleAspects.length;

  const selectedAsset = selection.kind === "asset" ? core.assetType(selection.id) : undefined;
  const selectedAspect = selection.kind === "aspect" ? core.aspectType(selection.id) : undefined;

  async function sync() {
    if (backendOnline === false) {
      notifyError(new Error("The Asset Model Studio backend is not reachable — tenant sync needs a connection."));
      return;
    }
    let connections: ConnectionSummary[];
    try {
      connections = await api.connections.list();
    } catch (e) {
      notifyError(e, "Tenant connections unavailable");
      return;
    }
    if (connections.length === 0) {
      const go = await confirmDialog({
        title: "No tenant connection",
        message: "Add a tenant connection first; the core library is read from GET /assettypes and GET /aspecttypes of that tenant.",
        confirmLabel: "Manage tenants",
      });
      if (go) navigate("/tenants");
      return;
    }
    const choice = await formDialog({
      title: "Sync library from tenant",
      initial: { connectionId: connections[0]!.id },
      confirmLabel: "Read core types",
      size: "600",
      render: (v, patch) => (
        <>
          <IxTypography className={dialogStyles.text}>
            Reads all asset types and aspect types of the tenant (pages of 200) and keeps the core.* types. Nothing is written
            to the tenant. You review the differences before the library is replaced.
          </IxTypography>
          <IxSelect label="Tenant connection" value={v.connectionId} onValueChange={(e) => patch({ connectionId: String(e.detail) })}>
            {connections.map((c) => (
              <IxSelectItem key={c.id} value={c.id} label={connectionLabel(c)} />
            ))}
          </IxSelect>
        </>
      ),
    });
    if (!choice) return;
    const conn = connections.find((c) => c.id === choice.connectionId)!;
    setBusy(`Reading core types from ${conn.name}…`);
    let candidate: CoreLibrary;
    try {
      const [assetTypes, aspectTypes] = await Promise.all([
        api.listAll<AmAssetTypeResource>(conn.id, { resource: "assettypes" }),
        api.listAll<AmAspectTypeResource>(conn.id, { resource: "aspecttypes" }),
      ]);
      const failures = [...assetTypes.partialFailures, ...aspectTypes.partialFailures];
      if (failures.length) {
        throw new DomainError(
          `${failures.length} page(s) could not be read (${failures[0]!.status}: ${failures[0]!.message}). The library was not changed — an incomplete list would drop core types.`,
        );
      }
      candidate = coreLibraryFromTenant(assetTypes.items, aspectTypes.items, {
        syncedAt: nowIso(),
        syncedFrom: `${conn.name} (${conn.tenant})`,
      });
      if (candidate.assetTypes.length === 0) throw new DomainError("The tenant returned no core asset types; the library was not changed.");
    } catch (e) {
      setBusy(null);
      notifyError(e, "Sync failed");
      return;
    }
    setBusy(null);
    const diff = diffCoreLibraries(library, candidate);
    const ok = await confirmDialog({
      title: "Replace the core library?",
      message: diff.identical
        ? `The core types of ${conn.name} match the current library. Use them and record the tenant as the source?`
        : `Review the differences between the current library and ${conn.name}. Project types that use a removed core type are reported as missing parents by validation.`,
      details: <DiffPreview diff={diff} />,
      confirmLabel: "Use tenant library",
      size: "840",
    });
    if (!ok) return;
    try {
      await setCoreLibrary(candidate);
      notifySuccess(`Core library synced from ${conn.name}: ${candidate.assetTypes.length} asset types, ${candidate.aspectTypes.length} aspect types.`);
    } catch (e) {
      notifyError(e, "The library could not be saved");
    }
  }

  async function reset() {
    const ok = await confirmDialog({
      title: "Reset to the built-in library?",
      message: "The tenant snapshot is discarded and the core types transcribed from the documentation are used again.",
      confirmLabel: "Reset library",
      danger: true,
    });
    if (!ok) return;
    try {
      await resetCoreLibrary();
      notifySuccess("Core library reset to the built-in snapshot.");
    } catch (e) {
      notifyError(e);
    }
  }

  async function extend(type: CoreAssetType) {
    let projects;
    try {
      projects = await listProjects();
    } catch (e) {
      notifyError(e);
      return;
    }
    if (projects.length === 0) {
      const go = await confirmDialog({
        title: "No project yet",
        message: "Create a project first; the new asset type is added to a project.",
        confirmLabel: "Go to projects",
      });
      if (go) navigate("/");
      return;
    }
    const openId = useProjectStore.getState().project?.id;
    const result = await formDialog({
      title: `Extend ${type.name} in a project`,
      initial: { projectId: projects.some((p) => p.id === openId) ? openId! : projects[0]!.id, name: suggestedName(type) },
      confirmLabel: "Create asset type",
      size: "600",
      render: (v, patch) => {
        const error = v.name ? assetTypeNameError(v.name) : undefined;
        return (
          <>
            <IxSelect label="Project" value={v.projectId} onValueChange={(e) => patch({ projectId: String(e.detail) })}>
              {projects.map((p) => (
                <IxSelectItem key={p.id} value={p.id} label={p.id === openId ? `${p.name} (open)` : p.name} />
              ))}
            </IxSelect>
            <IxInput
              label="Name of the new asset type"
              value={v.name}
              required
              helperText={`Inherits from ${type.id}. A suffix is added when the name is already taken in the project.`}
              invalidText={error}
              className={error ? "ix-invalid" : undefined}
              onValueChange={(e) => patch({ name: e.detail })}
            />
          </>
        );
      },
      validate: (v) => assetTypeNameError(v.name),
    });
    if (!result) return;
    try {
      const parent = { kind: "core", id: type.id } as const;
      const store = useProjectStore.getState();
      let created: { uid: string; name: string };
      if (store.project?.id === result.projectId) {
        let t = { uid: "", name: "" };
        store.apply(`Extend core type ${type.id}`, (d) => {
          const at = newAssetType(d, result.name.trim(), parent);
          d.assetTypes.push(at);
          t = { uid: at.uid, name: at.name };
        });
        created = t;
      } else {
        const project = await loadProject(result.projectId);
        if (!project) throw new DomainError("Project not found.");
        const at = newAssetType(project, result.name.trim(), parent);
        project.assetTypes.push(at);
        touch(project, `Extend core type ${type.id}`);
        await saveProject(project);
        created = { uid: at.uid, name: at.name };
      }
      const projectName = projects.find((p) => p.id === result.projectId)?.name ?? "the project";
      const open = await confirmDialog({
        title: "Asset type created",
        message: `“${created.name}” inherits from ${type.name} in ${projectName}.`,
        confirmLabel: "Open asset type",
        cancelLabel: "Stay here",
      });
      if (open) navigate(`/p/${result.projectId}/asset-types/${created.uid}`);
    } catch (e) {
      notifyError(e, `Could not extend ${type.name}`);
    }
  }

  const master = (
    <MasterList
      title="Core types"
      searchLabel="Search core types"
      query={query}
      onQuery={setQuery}
      status={`${matchCount} of ${library.assetTypes.length + library.aspectTypes.length} shown`}
    >
      <li className={styles.groupLabel}>
        <h3 className={`typography-label-sm ${styles.groupHeading}`}>Asset types ({library.assetTypes.length})</h3>
      </li>
      {visibleRows.map((r) => {
        const t = r.item;
        return (
          <MasterItem
            key={t.id}
            level={r.level}
            muted={!!query.trim() && !assetMatch(t)}
            selected={selection.kind === "asset" && selection.id.toLowerCase() === t.id.toLowerCase()}
            onSelect={() => setSelection({ kind: "asset", id: t.id })}
            primary={t.name}
            secondary={`${t.id}${t.instantiable ? "" : " · abstract"}${t.deprecated ? " · deprecated" : ""}`}
          />
        );
      })}
      <li className={styles.groupLabel}>
        <h3 className={`typography-label-sm ${styles.groupHeading}`}>Aspect types ({library.aspectTypes.length})</h3>
      </li>
      {visibleAspects.map((t) => (
        <MasterItem
          key={t.id}
          selected={selection.kind === "aspect" && selection.id.toLowerCase() === t.id.toLowerCase()}
          onSelect={() => setSelection({ kind: "aspect", id: t.id })}
          primary={t.name}
          secondary={`${t.id} · ${t.category} · ${t.variables.length} var${t.variables.length === 1 ? "" : "s"}`}
        />
      ))}
    </MasterList>
  );

  const detail = selectedAsset ? (
    <AssetTypeDetail type={selectedAsset} core={core} onSelect={setSelection} onExtend={(t) => void extend(t)} />
  ) : selectedAspect ? (
    <AspectTypeDetail type={selectedAspect} core={core} onSelect={setSelection} />
  ) : (
    <IxTypography format="body" textColor="soft">
      The selected type is not part of the current library.
    </IxTypography>
  );

  return (
    <div className={styles.tab}>
      <div className={styles.sourceBar}>
        <div className={styles.sourceText}>
          <IxTypography format="label">{library.source === "builtin" ? "Source: documentation" : "Source: tenant"}</IxTypography>
          <IxTypography format="body-sm" textColor="soft" className={md.text}>
            {sourceText(library)} {library.assetTypes.length} asset types, {library.aspectTypes.length} aspect types.
          </IxTypography>
        </div>
        <div className={md.inlineRow}>
          {busy ? (
            <span className={md.inlineRow}>
              <IxSpinner size="small" />
              <IxTypography format="body-sm">{busy}</IxTypography>
            </span>
          ) : null}
          <IxButton variant="secondary" icon={iconCloudDownload} disabled={!!busy || backendOnline === false} onClick={() => void sync()}>
            Sync library from tenant
          </IxButton>
          {library.source === "tenant" ? (
            <IxButton variant="subtle-secondary" icon={iconReset} disabled={!!busy} onClick={() => void reset()}>
              Reset to built-in
            </IxButton>
          ) : null}
        </div>
      </div>
      {backendOnline === false ? (
        <IxTypography format="body-sm" textColor="soft">
          Offline: the backend is not reachable, so syncing from a tenant is unavailable. Browsing and extending work offline.
        </IxTypography>
      ) : null}
      <MasterDetail master={master} detail={detail} />
    </div>
  );
}

