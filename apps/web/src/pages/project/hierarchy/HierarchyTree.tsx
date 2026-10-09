// Virtualised asset tree (@tanstack/react-virtual, fixed row height).
//
// Accessibility: the scroll container is the role="tree" widget and keeps DOM
// focus; the active row is announced through aria-activedescendant, which
// works with virtualisation because the active row is always scrolled into
// the rendered window. Rows are role="treeitem" with aria-level /
// aria-expanded / aria-selected as strings (A4).

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IxChip, IxIcon, IxTypography } from "@siemens/ix-react";
import { iconChevronDownSmall, iconChevronRightSmall } from "@siemens/ix-icons/icons";
import { IssueCounts } from "@/components/IssueList";
import { ROOT_ASSET_UID } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import type { Issue } from "@/domain/validator";
import { highlightParts, treeKeyAction, type TreeRow } from "@/features/hierarchy/tree";
import styles from "./HierarchyTree.module.css";

/** Fixed row height in CSS pixels (the virtualiser needs a constant). */
export const TREE_ROW_HEIGHT = 36;
const DRAG_MIME = "application/x-asset-model-studio-asset";

const treeRowId = (uid: string) => `hierarchy-node-${uid}`;

export interface HierarchyTreeProps {
  rows: TreeRow[];
  index: ModelIndex;
  selectedUid: string;
  query: string;
  matches: Set<string>;
  issuesByEntity: Map<string, Issue[]>;
  onToggle(uid: string, open?: boolean): void;
  onSelect(uid: string): void;
  onMove(uid: string, newParentUid: string): void;
}

interface DragState {
  uid: string;
  /** The dragged asset and its subtree: not valid drop targets. */
  forbidden: Set<string>;
}

export function HierarchyTree({
  rows,
  index,
  selectedUid,
  query,
  matches,
  issuesByEntity,
  onToggle,
  onSelect,
  onMove,
}: HierarchyTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeUid, setActiveUid] = useState(selectedUid);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.uid, i));
    return m;
  }, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    overscan: 12,
  });

  // Follow external selection changes (URL, breadcrumbs, search results).
  useEffect(() => {
    setActiveUid(selectedUid);
    const i = rowIndex.get(selectedUid);
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: "auto" });
    // Only when the selection changes or the selected row (re)appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, rowIndex.get(selectedUid)]);

  const activeIndex = rowIndex.get(activeUid) ?? rowIndex.get(selectedUid) ?? 0;
  const active = rows[activeIndex];

  function focusRow(i: number) {
    const row = rows[i];
    if (!row) return;
    setActiveUid(row.uid);
    virtualizer.scrollToIndex(i, { align: "auto" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const pageSize = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 360) / TREE_ROW_HEIGHT) - 1);
    const action = treeKeyAction(rows, activeIndex, e.key, pageSize);
    if (action.type === "none") return;
    e.preventDefault();
    if (action.type === "focus") focusRow(action.row);
    else if (action.type === "expand") onToggle(action.uid, true);
    else if (action.type === "collapse") onToggle(action.uid, false);
    else if (action.type === "select") {
      const row = rows[action.row];
      if (row) onSelect(row.uid);
    }
  }

  // --- Drag & drop re-parenting -------------------------------------------

  function onDragStart(e: DragEvent<HTMLDivElement>, uid: string) {
    if (uid === ROOT_ASSET_UID) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DRAG_MIME, uid);
    e.dataTransfer.setData("text/plain", index.assets.get(uid)?.name ?? uid);
    e.dataTransfer.effectAllowed = "move";
    setDrag({ uid, forbidden: new Set([uid, ...index.descendantsOf(uid)]) });
  }

  function canDrop(target: string): boolean {
    return !!drag && !drag.forbidden.has(target);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>, target: string) {
    if (!drag) return;
    if (!canDrop(target)) {
      e.dataTransfer.dropEffect = "none";
      if (dropTarget !== null) setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== target) setDropTarget(target);
  }

  function onDrop(e: DragEvent<HTMLDivElement>, target: string) {
    e.preventDefault();
    const uid = drag?.uid ?? e.dataTransfer.getData(DRAG_MIME);
    const ok = canDrop(target);
    setDrag(null);
    setDropTarget(null);
    if (!uid || !ok) return;
    if (index.assets.get(uid)?.parentUid === target) return;
    onMove(uid, target);
  }

  function endDrag() {
    setDrag(null);
    setDropTarget(null);
  }

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      role="tree"
      aria-label="Asset hierarchy"
      aria-activedescendant={active ? treeRowId(active.uid) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]!;
          const asset = index.assets.get(row.uid);
          if (!asset) return null;
          const selected = row.uid === selectedUid;
          const isActive = row.uid === active?.uid;
          const isMatch = matches.has(row.uid);
          const issues = issuesByEntity.get(row.uid) ?? [];
          const typeName = row.uid === ROOT_ASSET_UID ? "placeholder for the target tenant" : index.assetTypeName(asset.type);
          const cls = [
            styles.row,
            selected ? styles.selected : "",
            isActive ? styles.active : "",
            dropTarget === row.uid ? styles.dropTarget : "",
            drag?.uid === row.uid ? styles.dragging : "",
          ].join(" ");
          return (
            <div
              key={row.uid}
              id={treeRowId(row.uid)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-setsize={row.setSize}
              aria-posinset={row.posInSet}
              aria-expanded={row.hasChildren ? (row.expanded ? "true" : "false") : undefined}
              aria-selected={selected ? "true" : "false"}
              className={cls}
              style={{ top: item.start, height: TREE_ROW_HEIGHT }}
              title={asset.name}
              draggable={row.uid !== ROOT_ASSET_UID}
              onDragStart={(e) => onDragStart(e, row.uid)}
              onDragOver={(e) => onDragOver(e, row.uid)}
              onDragLeave={() => dropTarget === row.uid && setDropTarget(null)}
              onDrop={(e) => onDrop(e, row.uid)}
              onDragEnd={endDrag}
              onClick={() => {
                setActiveUid(row.uid);
                onSelect(row.uid);
              }}
              onDoubleClick={() => row.hasChildren && onToggle(row.uid)}
            >
              {/* Indentation is a multiple of a spacing token. */}
              <span className={styles.indent} style={{ width: `calc(var(--theme-space-3) * ${row.depth})` }} aria-hidden="true" />
              {row.hasChildren ? (
                <span
                  className={styles.toggle}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(row.uid);
                  }}
                >
                  {/* Decorative: aria-expanded on the treeitem carries the state. */}
                  <IxIcon name={row.expanded ? iconChevronDownSmall : iconChevronRightSmall} size="16" aria-hidden="true" />
                </span>
              ) : (
                <span className={styles.toggle} aria-hidden="true" />
              )}
              <span className={styles.label}>
                <IxTypography format="body" className={styles.name} bold={selected}>
                  {highlightParts(asset.name || "(unnamed asset)", isMatch ? query : "").map((p, i) =>
                    p.match ? (
                      <mark key={i} className={styles.mark}>
                        {p.text}
                      </mark>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
                </IxTypography>
                <IxTypography format="body-xs" textColor="soft" className={styles.type}>
                  {typeName}
                </IxTypography>
              </span>
              {row.detached ? (
                <IxChip variant="alarm" outline>
                  Detached
                </IxChip>
              ) : null}
              <IssueCounts issues={issues} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
