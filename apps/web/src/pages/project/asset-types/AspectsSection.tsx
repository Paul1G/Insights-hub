// Aspects of an asset type: own aspects (rename, change aspect type while not
// deployed, remove with impact) and inherited aspects (read-only). Every
// aspect expands to show the variables of its aspect type.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxChip, IxIconButton, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconChevronDownSmall, iconChevronRightSmall, iconLock, iconTrashcan } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { notifyError, notifySuccess } from "@/components/notify";
import { newUid, typeRefKey, type AspectRefDef, type AssetTypeDef, type Project, type TypeRef } from "@/domain/model";
import { DomainError, removeAspect, renameAspect, toIdentifier, uniqueName } from "@/domain/ops";
import type { ModelIndex, ResolvedAspect, ResolvedAssetType } from "@/domain/resolve";
import { LIMITS, PATTERNS, isReservedWord } from "@/domain/rules";
import { currentIndex } from "@/features/types/currentIndex";
import { fieldIssues, fieldProps } from "@/features/types/fieldState";
import { formDialog } from "@/features/types/formDialog";
import { dialogStyles, masterDetailStyles as md } from "@/features/types/styles";
import { DetailSection } from "@/features/types/MasterDetail";
import { ReadonlyVariables } from "@/features/types/ReadonlyVariables";
import { useEntityIssues, useModelIndex, useProject } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import styles from "./AssetTypes.module.css";

interface AspectTypeOption {
  key: string;
  ref: TypeRef;
  label: string;
  baseName: string;
}

function aspectTypeOptions(index: ModelIndex, current?: TypeRef): AspectTypeOption[] {
  const project = [...index.project.aspectTypes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      key: typeRefKey({ kind: "project", uid: t.uid }),
      ref: { kind: "project", uid: t.uid } as TypeRef,
      label: `${t.name || "(unnamed)"} ({tenant}.${t.idSuffix}) · ${t.category}`,
      baseName: t.name,
    }));
  const core = [...index.core.library.aspectTypes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      key: typeRefKey({ kind: "core", id: t.id }),
      ref: { kind: "core", id: t.id } as TypeRef,
      label: `${t.name} (${t.id}) · ${t.category} · core, not billable`,
      baseName: t.name,
    }));
  const existing = [...index.externalAspectTypes()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      key: typeRefKey({ kind: "external", id: t.id }),
      ref: { kind: "external", id: t.id } as TypeRef,
      label: `${t.name} (${t.id}) · ${t.category} · existing in tenant`,
      baseName: t.name,
    }));
  const out = [...project, ...existing, ...core];
  if (current && !out.some((o) => o.key === typeRefKey(current))) {
    const resolved = index.resolveAspectType(current);
    out.unshift({
      key: typeRefKey(current),
      ref: current,
      label: resolved ? `${resolved.displayId} — external` : "(missing aspect type)",
      baseName: resolved?.name ?? "aspect",
    });
  }
  return out;
}

/** Aspect names (lower case) used in the type family, excluding one own aspect. */
function familyAspectNames(index: ModelIndex, type: AssetTypeDef, exceptUid?: string): string[] {
  const resolved = index.resolveAssetType({ kind: "project", uid: type.uid });
  return [
    ...(resolved?.aspects ?? []).filter((a) => a.uid !== exceptUid || a.inherited).map((a) => a.name),
    ...index.descendantTypesOf(type.uid).flatMap((d) => d.aspects.map((a) => a.name)),
  ];
}

function aspectNameError(name: string, taken: string[]): string | undefined {
  if (!name) return "Enter an aspect name.";
  if (!PATTERNS.aspectName.test(name)) return "Use letters, digits and _ only.";
  if (name.length > LIMITS.aspectNameMax) return `At most ${LIMITS.aspectNameMax} characters.`;
  if (isReservedWord(name)) return `“${name}” is a reserved word.`;
  if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) return "This name is already used in the type family (ancestors and descendants).";
  return undefined;
}

function suggestAspectName(baseName: string, taken: string[]): string {
  const id = toIdentifier(baseName, "aspect");
  const lowerFirst = id.charAt(0).toLowerCase() + id.slice(1);
  return uniqueName(isReservedWord(lowerFirst) ? `${lowerFirst}_aspect` : lowerFirst, taken);
}

function findType(d: Project, uid: string): AssetTypeDef {
  const t = d.assetTypes.find((x) => x.uid === uid);
  if (!t) throw new DomainError("Asset type not found.");
  return t;
}

function ExpandButton({ expanded, name, onToggle }: { expanded: boolean; name: string; onToggle: () => void }) {
  return (
    <IxIconButton
      icon={expanded ? iconChevronDownSmall : iconChevronRightSmall}
      variant="subtle-tertiary"
      size="24"
      aria-expanded={expanded ? "true" : "false"}
      aria-label={`${expanded ? "Hide" : "Show"} variables of ${name}`}
      onClick={onToggle}
    />
  );
}

function AspectVariables({ aspect }: { aspect: ResolvedAspect }) {
  const at = aspect.aspectType;
  if (!at.known) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        The definition of {at.displayId} is not available offline.
      </IxTypography>
    );
  }
  return (
    <ReadonlyVariables
      caption={`Variables of aspect ${aspect.name}`}
      variables={at.variables}
      showQualityCode
      empty="The aspect type has no variables."
    />
  );
}

function OwnAspectRow({
  type,
  aspect,
  resolved,
  deployed,
  options,
}: {
  type: AssetTypeDef;
  aspect: AspectRefDef;
  resolved?: ResolvedAspect;
  deployed: boolean;
  options: AspectTypeOption[];
}) {
  const index = useModelIndex();
  const apply = useProjectStore((s) => s.apply);
  const issues = useEntityIssues(type.uid, aspect.uid);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(aspect.name);
  const [nameError, setNameError] = useState<string | undefined>();
  useEffect(() => {
    setDraft(aspect.name);
    setNameError(undefined);
  }, [aspect.name]);
  const label = aspect.name || "(unnamed)";

  const rename = (name: string) => {
    setDraft(name);
    if (name === aspect.name) {
      setNameError(undefined);
      return;
    }
    try {
      apply(`Rename aspect ${label}`, (d) => renameAspect(d, index, type.uid, aspect.uid, name), {
        coalesceKey: `${type.uid}:${aspect.uid}:name`,
      });
      setNameError(undefined);
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e));
    }
  };

  const changeType = (key: string) => {
    const option = options.find((o) => o.key === key);
    if (!option || key === typeRefKey(aspect.aspectType)) return;
    try {
      apply(`Change aspect type of ${label}`, (d) => {
        const a = findType(d, type.uid).aspects.find((x) => x.uid === aspect.uid);
        if (!a) throw new DomainError("Aspect not found.");
        a.aspectType = option.ref;
      });
    } catch (e) {
      notifyError(e);
    }
  };

  const remove = async () => {
    const ix = currentIndex();
    const descendants = ix.descendantTypesOf(type.uid);
    const assets = ix.assetsOfType({ kind: "project", uid: type.uid }, true);
    const name = aspect.name.toLowerCase();
    const withValues = assets.filter((a) => a.aspects.some((av) => av.name.toLowerCase() === name && av.variables.length > 0)).length;
    const ok = await confirmDialog({
      title: `Remove aspect “${label}”?`,
      message: `The aspect is removed from “${type.name}”${descendants.length ? ` and no longer inherited by ${descendants.length} descendant type${descendants.length === 1 ? "" : "s"}` : ""}.${deployed ? " It exists in a tenant: the next deployment removes it there, including its data." : ""}`,
      confirmLabel: "Remove aspect",
      danger: true,
      details: (
        <ul className={dialogStyles.list}>
          <li>
            <IxTypography format="body-sm">
              {assets.length} asset{assets.length === 1 ? "" : "s"} of this type (incl. descendant types) lose the aspect
            </IxTypography>
          </li>
          <li>
            <IxTypography format="body-sm">
              {withValues} asset{withValues === 1 ? "" : "s"} with static values for it that will be removed
            </IxTypography>
          </li>
        </ul>
      ),
    });
    if (!ok) return;
    try {
      apply(`Remove aspect ${label} from ${type.name}`, (d) => removeAspect(d, currentIndex(), type.uid, aspect.uid));
      notifySuccess(`Aspect “${label}” removed.`);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <li className={styles.aspectRow} aria-label={`Aspect ${label}`}>
      <div className={styles.aspectHead}>
        <ExpandButton expanded={expanded} name={label} onToggle={() => setExpanded((x) => !x)} />
        <div className={styles.aspectFields}>
          <IxInput
            label="Aspect name"
            value={draft}
            required
            maxLength={LIMITS.aspectNameMax}
            onValueChange={(e) => rename(e.detail)}
            onIxBlur={() => {
              if (nameError) {
                setDraft(aspect.name);
                setNameError(undefined);
              }
            }}
            {...fieldProps(fieldIssues(issues, "name"), nameError)}
          />
          <IxSelect
            label="Aspect type"
            value={typeRefKey(aspect.aspectType)}
            disabled={deployed}
            helperText={
              deployed
                ? "Locked: the aspect exists in a tenant; only its name can be changed."
                : type.baseline
                  ? "Can only be changed while the aspect is not deployed."
                  : undefined
            }
            onValueChange={(e) => changeType(String(e.detail))}
            {...fieldProps(fieldIssues(issues, "aspectType"))}
          >
            {options.map((o) => (
              <IxSelectItem key={o.key} value={o.key} label={o.label} />
            ))}
          </IxSelect>
        </div>
        <span className={styles.aspectMeta}>
          {resolved ? (
            <IxChip variant={resolved.aspectType.category === "dynamic" ? "info" : "neutral"} outline inactive>
              {resolved.aspectType.category} · {resolved.aspectType.variables.length} var
            </IxChip>
          ) : null}
          {deployed ? (
            <IxChip variant="neutral" outline icon={iconLock} inactive>
              Deployed
            </IxChip>
          ) : null}
          <IxIconButton
            icon={iconTrashcan}
            variant="danger-tertiary"
            size="24"
            aria-label={`Remove aspect ${label}`}
            onClick={() => void remove()}
          />
        </span>
      </div>
      {expanded && resolved ? <AspectVariables aspect={resolved} /> : null}
    </li>
  );
}

function InheritedAspectRow({ aspect }: { aspect: ResolvedAspect }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={`${styles.aspectRow} ${styles.inheritedRow}`} aria-label={`Inherited aspect ${aspect.name}`}>
      <div className={styles.aspectHead}>
        <ExpandButton expanded={expanded} name={aspect.name} onToggle={() => setExpanded((x) => !x)} />
        <span className={styles.aspectSummary}>
          <IxTypography format="code" className={md.text}>
            {aspect.name}
          </IxTypography>
          <IxTypography format="body-sm" textColor="soft" className={md.text}>
            {aspect.aspectType.name} ({aspect.aspectType.displayId}) · inherited from {aspect.definedOnName}
          </IxTypography>
        </span>
        <span className={styles.aspectMeta}>
          <IxChip variant={aspect.aspectType.category === "dynamic" ? "info" : "neutral"} outline inactive>
            {aspect.aspectType.category} · {aspect.aspectType.variables.length} var
          </IxChip>
          <IxChip variant="neutral" outline icon={iconLock} inactive>
            Read-only
          </IxChip>
        </span>
      </div>
      {expanded ? <AspectVariables aspect={aspect} /> : null}
    </li>
  );
}

export function AspectsSection({
  type,
  resolved,
  deployedUids,
}: {
  type: AssetTypeDef;
  resolved: ResolvedAssetType;
  deployedUids: Set<string>;
}) {
  const project = useProject();
  const index = useModelIndex();
  const navigate = useNavigate();
  const apply = useProjectStore((s) => s.apply);
  const options = aspectTypeOptions(index);
  const own = resolved.aspects.filter((a) => !a.inherited);
  const inherited = resolved.aspects.filter((a) => a.inherited);
  const resolvedByUid = new Map(own.map((a) => [a.uid, a]));

  const add = async () => {
    if (options.length === 0) return;
    const taken = familyAspectNames(index, type);
    const first = options[0]!;
    const result = await formDialog<{ key: string; name: string; auto: boolean }>({
      title: `Add aspect to ${type.name}`,
      initial: { key: first.key, name: suggestAspectName(first.baseName, taken), auto: true },
      confirmLabel: "Add aspect",
      size: "600",
      render: (v, patch) => {
        const error = v.name ? aspectNameError(v.name, taken) : undefined;
        return (
          <>
            <IxSelect
              label="Aspect type"
              value={v.key}
              helperText="Project aspect types and core aspect types (core aspect type variables are not billable)."
              onValueChange={(e) => {
                const key = String(e.detail);
                const option = options.find((o) => o.key === key);
                patch(v.auto && option ? { key, name: suggestAspectName(option.baseName, taken) } : { key });
              }}
            >
              {options.map((o) => (
                <IxSelectItem key={o.key} value={o.key} label={o.label} />
              ))}
            </IxSelect>
            <IxInput
              label="Aspect name"
              value={v.name}
              required
              helperText="Unique within the type family; letters, digits and _."
              invalidText={error}
              className={error ? "ix-invalid" : undefined}
              onValueChange={(e) => patch({ name: e.detail, auto: false })}
            />
          </>
        );
      },
      validate: (v) => aspectNameError(v.name, taken) ?? (options.some((o) => o.key === v.key) ? undefined : "Choose an aspect type."),
    });
    if (!result) return;
    const option = options.find((o) => o.key === result.key)!;
    try {
      apply(`Add aspect ${result.name} to ${type.name}`, (d) => {
        findType(d, type.uid).aspects.push({ uid: newUid(), name: result.name, aspectType: option.ref });
      });
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <DetailSection
        title={`Own aspects (${type.aspects.length})`}
        description="Aspects add the variables of an aspect type under an aspect name. Renaming is always possible; the aspect type of a deployed aspect cannot be changed."
        actions={
          options.length ? (
            <IxButton variant="secondary" icon={iconAdd} onClick={() => void add()}>
              Add aspect
            </IxButton>
          ) : (
            <IxButton variant="secondary" icon={iconAdd} onClick={() => navigate(`/p/${project.id}/aspect-types`)}>
              Create an aspect type first
            </IxButton>
          )
        }
      >
        {type.aspects.length ? (
          <ul className={styles.aspectList}>
            {type.aspects.map((a) => (
              <OwnAspectRow
                key={a.uid}
                type={type}
                aspect={a}
                resolved={resolvedByUid.get(a.uid)}
                deployed={deployedUids.has(a.uid)}
                options={aspectTypeOptions(index, a.aspectType)}
              />
            ))}
          </ul>
        ) : (
          <IxTypography format="body-sm" textColor="soft">
            No own aspects.
          </IxTypography>
        )}
      </DetailSection>

      {inherited.length ? (
        <DetailSection
          title={`Inherited aspects (${inherited.length})`}
          description="Defined on ancestor types. Inherited aspects cannot be modified here — edit the type that defines them."
          readOnly
        >
          <ul className={styles.aspectList}>
            {inherited.map((a) => (
              <InheritedAspectRow key={`${typeRefKey(a.definedOn)}:${a.name}`} aspect={a} />
            ))}
          </ul>
        </DetailSection>
      ) : null}
    </>
  );
}
