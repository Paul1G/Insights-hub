// Virtualized table of plan steps grouped by phase (dry run and run report).
// Rows are rendered on demand (@tanstack/react-virtual), so plans with tens of
// thousands of steps stay responsive.

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { ENTITY_KIND_LABELS, PHASES, PHASE_LABELS, type DeploymentPlan, type Phase, type PlanStep, type StepRun } from "@/deploy/types";
import { OpChip, StatusChip } from "./chips";
import styles from "./deploy.module.css";

export type StepFilter = "all" | "changes" | "blocked" | "destructive" | "problems";

const FILTER_LABELS: Record<StepFilter, string> = {
  all: "All steps",
  changes: "Changes only",
  blocked: "Blocked steps",
  destructive: "Destructive steps",
  problems: "Failed, conflicts and skipped",
};

type Row = { type: "group"; phase: Phase; count: number } | { type: "step"; step: PlanStep };

function matches(step: PlanStep, item: StepRun | undefined, filter: StepFilter, query: string): boolean {
  if (query && !step.entity.label.toLowerCase().includes(query) && !step.tenantId.toLowerCase().includes(query)) return false;
  switch (filter) {
    case "all":
      return true;
    case "changes":
      return step.op !== "skip" || !!step.blocked;
    case "blocked":
      return !!step.blocked;
    case "destructive":
      return step.destructive;
    case "problems":
      return !!item && (item.status === "failed" || item.status === "conflict" || item.status === "skipped-dependency" || (item.status === "skipped" && !!step.blocked));
  }
}

export function StepTable({
  plan,
  items,
  version,
  onOpen,
  label,
  initialFilter = "changes",
}: {
  plan: DeploymentPlan;
  /** Run state per step id (run report / live progress). */
  items?: Map<string, StepRun>;
  /** Changes whenever `items` were mutated in place. */
  version?: number;
  onOpen: (step: PlanStep) => void;
  label: string;
  initialFilter?: StepFilter;
}) {
  const [filter, setFilter] = useState<StepFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const withStatus = !!items;

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const byPhase = new Map<Phase, PlanStep[]>();
    for (const s of plan.steps) {
      if (!matches(s, items?.get(s.id), filter, q)) continue;
      const list = byPhase.get(s.phase) ?? [];
      list.push(s);
      byPhase.set(s.phase, list);
    }
    const out: Row[] = [];
    for (const p of PHASES) {
      const list = byPhase.get(p);
      if (!list?.length) continue;
      out.push({ type: "group", phase: p, count: list.length });
      for (const step of list) out.push({ type: "step", step });
    }
    return out;
    // `version` re-evaluates the filter when run items change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, items, filter, query, version]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "group" ? 36 : 56),
    overscan: 12,
  });
  const rowClass = `${styles.dataRow} ${withStatus ? styles.withStatus : ""}`;
  const filters: StepFilter[] = withStatus ? ["all", "changes", "problems", "blocked", "destructive"] : ["all", "changes", "blocked", "destructive"];

  return (
    <div className={styles.stack}>
      <div role="search" aria-label={`Filter ${label.toLowerCase()}`} className={styles.formGrid}>
        <IxSelect
          label="Show"
          value={filter}
          onValueChange={(e) => {
            const v = (Array.isArray(e.detail) ? e.detail[0] : e.detail) as StepFilter | undefined;
            if (v) setFilter(v);
          }}
        >
          {filters.map((f) => (
            <IxSelectItem key={f} value={f} label={FILTER_LABELS[f]} />
          ))}
        </IxSelect>
        <IxInput label="Filter by name or tenant id" value={query} onValueChange={(e) => setQuery(e.detail)} />
      </div>
      <IxTypography format="body-sm" textColor="soft" role="status">
        {rows.filter((r) => r.type === "step").length} of {plan.steps.length} steps shown
      </IxTypography>
      {rows.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          No steps match the filter.
        </IxTypography>
      ) : (
        <div className={styles.tableWrap} role="table" aria-label={label} aria-rowcount={rows.length + 1}>
          <div role="rowgroup">
            <div role="row" aria-rowindex={1} className={`${styles.headRow} ${withStatus ? styles.withStatus : ""}`}>
              <span role="columnheader"><IxTypography format="label-sm" textColor="soft">Operation</IxTypography></span>
              <span role="columnheader"><IxTypography format="label-sm" textColor="soft">Entity</IxTypography></span>
              <span role="columnheader"><IxTypography format="label-sm" textColor="soft">Tenant id</IxTypography></span>
              <span role="columnheader"><IxTypography format="label-sm" textColor="soft">Reason</IxTypography></span>
              {withStatus ? <span role="columnheader"><IxTypography format="label-sm" textColor="soft">Status</IxTypography></span> : null}
            </div>
          </div>
          <div ref={scrollRef} className={styles.scroller} role="rowgroup">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vr) => {
                const row = rows[vr.index]!;
                const common = {
                  "data-index": vr.index,
                  ref: virtualizer.measureElement,
                  role: "row",
                  "aria-rowindex": vr.index + 2,
                  style: { transform: `translateY(${vr.start}px)` },
                } as const;
                if (row.type === "group") {
                  return (
                    <div key={`g:${row.phase}`} {...common} className={`${styles.virtualRow} ${styles.groupRow}`}>
                      <span role="cell" className={styles.cell}>
                        <IxTypography format="label" bold>
                          {PHASE_LABELS[row.phase]}
                        </IxTypography>
                        <IxTypography format="label-sm" textColor="soft">
                          {row.count} step{row.count === 1 ? "" : "s"}
                        </IxTypography>
                      </span>
                    </div>
                  );
                }
                const s = row.step;
                const item = items?.get(s.id);
                return (
                  <div key={s.id} {...common} className={`${styles.virtualRow} ${rowClass}`}>
                    <span role="cell" className={styles.cell}>
                      <OpChip op={s.op} blocked={!!s.blocked} />
                      {s.destructive ? (
                        <IxTypography format="label-xs" textColor="alarm">
                          Destructive
                        </IxTypography>
                      ) : null}
                    </span>
                    <span role="cell" className={styles.cell}>
                      <span className={styles.tightStack}>
                        <IxTypography format="label-xs" textColor="soft">
                          {ENTITY_KIND_LABELS[s.entity.kind]}
                        </IxTypography>
                        <button type="button" className={styles.linkButton} onClick={() => onOpen(s)}>
                          <IxTypography format="body">{s.entity.label || "(unnamed)"}</IxTypography>
                        </button>
                      </span>
                    </span>
                    <span role="cell" className={styles.cell}>
                      <IxTypography format="code-sm" className={styles.code}>
                        {s.tenantId === "pending" ? "new" : s.tenantId}
                      </IxTypography>
                    </span>
                    <span role="cell" className={styles.cell}>
                      <IxTypography format="body-sm" textColor={s.blocked ? "alarm" : "std"} className={styles.text}>
                        {s.blocked ? `Blocked: ${s.blocked.reason}` : s.reason}
                      </IxTypography>
                    </span>
                    {withStatus ? (
                      <span role="cell" className={styles.cell}>
                        {item ? <StatusChip status={item.status} /> : null}
                        {item && item.attempts > 1 ? (
                          <IxTypography format="label-xs" textColor="soft">
                            {item.attempts} attempts
                          </IxTypography>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
