// Copy wizard, step "Selection": aspect types, asset types and asset subtrees
// of the source tenant (lists are filtered; the asset tree is virtualized).

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IxButton, IxCheckbox, IxInput, IxTypography } from "@siemens/ix-react";
import { ROOT_ASSET_UID, type Project } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import type { CopyClosure } from "@/tenant/copy";
import styles from "../project/deploy/components/deploy.module.css";
import copyStyles from "./copy.module.css";

export interface SelectionState {
  aspectTypes: Set<string>;
  assetTypes: Set<string>;
  assetRoots: Set<string>;
}

function toggle(set: Set<string>, uid: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(uid);
  else next.delete(uid);
  return next;
}

function TypeList({
  title,
  items,
  selected,
  required,
  onChange,
}: {
  title: string;
  items: { uid: string; label: string; detail: string }[];
  selected: Set<string>;
  required: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q)) : items;
  return (
    <section className={styles.stack} aria-label={title}>
      <div className={styles.row}>
        <h3 className={`typography-h5 ${styles.heading}`}>
          {title} ({selected.size} of {items.length} selected)
        </h3>
      </div>
      <div className={styles.row}>
        <IxButton variant="tertiary" disabled={!items.length} onClick={() => onChange(new Set(items.map((i) => i.uid)))}>
          Select all
        </IxButton>
        <IxButton variant="tertiary" disabled={!selected.size} onClick={() => onChange(new Set())}>
          Clear selection
        </IxButton>
      </div>
      {items.length > 8 ? <IxInput label={`Filter ${title.toLowerCase()}`} value={query} onValueChange={(e) => setQuery(e.detail)} /> : null}
      {items.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          The source tenant has none.
        </IxTypography>
      ) : (
        <div className={`${styles.tableWrap} ${styles.scrollerShort}`}>
          <ul className={`${styles.list} ${copyStyles.checkList}`}>
            {shown.map((i) => (
              <li key={i.uid} className={styles.listItem}>
                <IxCheckbox
                  label={`${i.label} — ${i.detail}${required.has(i.uid) && !selected.has(i.uid) ? " (included as a dependency)" : ""}`}
                  checked={selected.has(i.uid)}
                  onCheckedChange={(e) => onChange(toggle(selected, i.uid, e.detail))}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AssetTree({ project, index, selected, closure, onChange }: { project: Project; index: ModelIndex; selected: Set<string>; closure: CopyClosure; onChange: (next: Set<string>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const out: { uid: string; name: string; level: number; type: string; children: number }[] = [];
    const seen = new Set<string>([ROOT_ASSET_UID]);
    // Depth-first; returns the number of descendants so each row can show it.
    const visit = (uid: string, level: number): number => {
      let total = 0;
      for (const c of index.childrenOf(uid)) {
        if (seen.has(c.uid)) continue;
        seen.add(c.uid);
        const row = { uid: c.uid, name: c.name, level, type: index.assetTypeName(c.type), children: 0 };
        out.push(row);
        row.children = visit(c.uid, level + 1);
        total += 1 + row.children;
      }
      return total;
    };
    visit(ROOT_ASSET_UID, 0);
    return out;
  }, [index]);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => ref.current, estimateSize: () => 40, overscan: 12 });
  return (
    <section className={styles.stack} aria-label="Asset subtrees">
      <h3 className={`typography-h5 ${styles.heading}`}>
        Asset subtrees ({selected.size} selected, {closure.assets.size} of {Math.max(0, project.assets.length - 1)} assets copied)
      </h3>
      <IxTypography format="body-sm" textColor="soft">
        Select the top asset of each subtree to copy; its descendants come along. Copied subtrees are placed under the target tenant's root.
      </IxTypography>
      <IxInput label="Filter assets by name" value={query} onValueChange={(e) => setQuery(e.detail)} />
      {shown.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          {rows.length ? "No asset matches the filter." : "The source tenant has no assets (or they were not read)."}
        </IxTypography>
      ) : (
        <div className={styles.tableWrap}>
          <div ref={ref} className={styles.scroller} role="list" aria-label="Source assets">
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {v.getVirtualItems().map((vr) => {
                const r = shown[vr.index]!;
                const inherited = closure.assets.has(r.uid) && !selected.has(r.uid);
                return (
                  <div
                    key={r.uid}
                    role="listitem"
                    data-index={vr.index}
                    ref={v.measureElement}
                    className={`${styles.virtualRow} ${copyStyles.treeRow}`}
                    style={{ transform: `translateY(${vr.start}px)`, paddingInlineStart: `calc(var(--theme-space-4) * ${q ? 0 : r.level} + var(--theme-space-2))` }}
                  >
                    <IxCheckbox
                      label={`${r.name} — ${r.type}${r.children ? ` · ${r.children} below` : ""}${inherited ? " (part of a selected subtree)" : ""}`}
                      checked={selected.has(r.uid) || inherited}
                      disabled={inherited}
                      onCheckedChange={(e) => onChange(toggle(selected, r.uid, e.detail))}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function CopySelection({
  project,
  index,
  selection,
  closure,
  includeAssets,
  onChange,
}: {
  project: Project;
  index: ModelIndex;
  selection: SelectionState;
  closure: CopyClosure;
  includeAssets: boolean;
  onChange: (next: SelectionState) => void;
}) {
  const aspectItems = useMemo(
    () => project.aspectTypes.map((t) => ({ uid: t.uid, label: t.name, detail: `${t.idSuffix} · ${t.category} · ${t.variables.length} variables` })),
    [project],
  );
  const assetTypeItems = useMemo(
    () =>
      project.assetTypes.map((t) => ({
        uid: t.uid,
        label: t.name,
        detail: `${t.idSuffix} · parent ${t.parent.kind === "project" ? (index.assetTypes.get(t.parent.uid)?.name ?? "?") : t.parent.id}`,
      })),
    [project, index],
  );
  return (
    <div className={styles.stack}>
      <div className={styles.formGrid}>
        <TypeList title="Aspect types" items={aspectItems} selected={selection.aspectTypes} required={closure.aspectTypes} onChange={(aspectTypes) => onChange({ ...selection, aspectTypes })} />
        <TypeList title="Asset types" items={assetTypeItems} selected={selection.assetTypes} required={closure.assetTypes} onChange={(assetTypes) => onChange({ ...selection, assetTypes })} />
      </div>
      {includeAssets ? <AssetTree project={project} index={index} selected={selection.assetRoots} closure={closure} onChange={(assetRoots) => onChange({ ...selection, assetRoots })} /> : null}
    </div>
  );
}
