// Searchable, virtualised single-select list of assets (keyboard accessible
// listbox with aria-activedescendant). Used by the "Move to…" dialog.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IxIcon, IxInput, IxTypography } from "@siemens/ix-react";
import { iconSearch, iconSuccess } from "@siemens/ix-icons/icons";
import { ROOT_ASSET_UID } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { assetPathLabel } from "./fields";
import styles from "./AssetPicker.module.css";

const ROW_HEIGHT = 48;

export interface AssetPickerProps {
  index: ModelIndex;
  value: string | undefined;
  onChange(uid: string): void;
  /** Assets that cannot be chosen (hidden from the list). */
  exclude?: Set<string>;
  label: string;
  idPrefix: string;
}

export function AssetPicker({ index, value, onChange, exclude, label, idPrefix }: AssetPickerProps) {
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = index.project.assets.filter(
      (a) =>
        !exclude?.has(a.uid) &&
        index.isAttached(a.uid) &&
        (!q || a.name.toLowerCase().includes(q) || (a.externalId ?? "").toLowerCase().includes(q)),
    );
    // Root first, then by hierarchy level and name.
    return list.sort(
      (a, b) =>
        (a.uid === ROOT_ASSET_UID ? -1 : 0) - (b.uid === ROOT_ASSET_UID ? -1 : 0) ||
        index.levelOf(a.uid) - index.levelOf(b.uid) ||
        a.name.localeCompare(b.name),
    );
  }, [index, query, exclude]);

  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);

  const virtualizer = useVirtualizer({
    count: candidates.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const optionId = (uid: string) => `${idPrefix}-option-${uid}`;
  const activeAsset = candidates[Math.min(active, candidates.length - 1)];

  function move(i: number) {
    const next = Math.max(0, Math.min(candidates.length - 1, i));
    setActive(next);
    virtualizer.scrollToIndex(next, { align: "auto" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const page = 6;
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(candidates.length - 1);
    else if (e.key === "PageDown") move(active + page);
    else if (e.key === "PageUp") move(active - page);
    else if ((e.key === "Enter" || e.key === " ") && activeAsset) onChange(activeAsset.uid);
    else return;
    e.preventDefault();
  }

  return (
    <div className={styles.picker}>
      <search aria-label={`Search ${label.toLowerCase()}`}>
        <IxInput label={`Search ${label.toLowerCase()}`} value={query} onValueChange={(e) => setQuery(e.detail)} placeholder="Name or external id">
          <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
        </IxInput>
      </search>
      <IxTypography format="label-sm" textColor="soft" id={`${idPrefix}-label`}>
        {label} · {candidates.length.toLocaleString()} {candidates.length === 1 ? "match" : "matches"}
      </IxTypography>
      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        aria-labelledby={`${idPrefix}-label`}
        tabIndex={0}
        aria-activedescendant={activeAsset ? optionId(activeAsset.uid) : undefined}
        onKeyDown={onKeyDown}
      >
        <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const a = candidates[item.index]!;
            const selected = a.uid === value;
            return (
              <div
                key={a.uid}
                id={optionId(a.uid)}
                role="option"
                aria-selected={selected ? "true" : "false"}
                className={`${styles.option} ${selected ? styles.selected : ""} ${item.index === active ? styles.active : ""}`}
                style={{ top: item.start, height: ROW_HEIGHT }}
                onClick={() => {
                  setActive(item.index);
                  onChange(a.uid);
                }}
              >
                <span className={styles.check}>
                  {selected ? <IxIcon name={iconSuccess} size="16" color="color-primary" aria-hidden="true" /> : null}
                </span>
                <span className={styles.text}>
                  <IxTypography format="body" className={styles.oneLine}>
                    {a.uid === ROOT_ASSET_UID ? "Tenant root" : a.name}
                  </IxTypography>
                  <IxTypography format="body-xs" textColor="soft" className={styles.oneLine}>
                    {assetPathLabel(index, a.uid)}
                  </IxTypography>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
