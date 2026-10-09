// Dry run: summary counts, validation gate, blockers, the steps grouped by
// phase and the objects that exist only in the target. Shared by the deploy
// page and the cross-tenant copy wizard.

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IxButton, IxMessageBar, IxTypography } from "@siemens/ix-react";
import { iconArrowRight } from "@siemens/ix-icons/icons";
import type { Blocker, DeploymentPlan, PlanStep, TargetOnlyItem } from "@/deploy/types";
import { ENTITY_KIND_LABELS } from "@/deploy/types";
import { PlanSummaryTiles } from "./chips";
import { StepTable } from "./StepTable";
import styles from "./deploy.module.css";

const MAX_BLOCKERS = 100;

function BlockerList({ blockers }: { blockers: Blocker[] }) {
  const shown = blockers.slice(0, MAX_BLOCKERS);
  return (
    <div className={styles.tightStack}>
      <ul className={styles.list} aria-label="Blockers">
        {shown.map((b, i) => (
          <li key={`${b.code}:${b.stepId ?? b.entity?.uid ?? i}`} className={styles.listItem}>
            <span className={styles.grow}>
              <IxTypography format="body-sm" className={styles.text}>
                {b.message}
              </IxTypography>
              {b.hint ? (
                <IxTypography format="body-xs" textColor="soft" className={styles.text}>
                  {b.hint}
                </IxTypography>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {blockers.length > shown.length ? (
        <IxTypography format="body-xs" textColor="soft">
          … and {blockers.length - shown.length} more.
        </IxTypography>
      ) : null}
    </div>
  );
}

/** Virtualized list of tenant objects (target-only / removed from the project). */
export function ObjectList({ items, label, empty }: { items: TargetOnlyItem[]; label: string; empty: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => ref.current, estimateSize: () => 44, overscan: 10 });
  if (items.length === 0) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        {empty}
      </IxTypography>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <div ref={ref} className={styles.scrollerShort} role="list" aria-label={label}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vr) => {
            const it = items[vr.index]!;
            return (
              <div
                key={`${it.kind}:${it.tenantId}`}
                role="listitem"
                data-index={vr.index}
                ref={v.measureElement}
                className={`${styles.virtualRow} ${styles.groupRow}`}
                style={{ transform: `translateY(${vr.start}px)` }}
              >
                <IxTypography format="label-xs" textColor="soft">
                  {ENTITY_KIND_LABELS[it.kind]}
                </IxTypography>
                <span className={styles.grow}>
                  <IxTypography format="body-sm">{it.label}</IxTypography>
                </span>
                <IxTypography format="code-sm" className={styles.code}>
                  {it.tenantId}
                </IxTypography>
                {it.detail ? (
                  <IxTypography format="body-xs" textColor="soft">
                    {it.detail}
                  </IxTypography>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function DryRunView({
  plan,
  onOpenStep,
  onOpenValidation,
}: {
  plan: DeploymentPlan;
  onOpenStep: (step: PlanStep) => void;
  /** Navigate to the project's validation overview (absent in the copy wizard). */
  onOpenValidation?: () => void;
}) {
  const validation = useMemo(() => plan.blockers.filter((b) => b.kind === "validation"), [plan]);
  const others = useMemo(() => plan.blockers.filter((b) => b.kind !== "validation"), [plan]);
  const notes = useMemo(() => [...new Set(plan.notes)], [plan]);
  return (
    <div className={styles.stack}>
      <PlanSummaryTiles summary={plan.summary} />

      {validation.length ? (
        <div className={styles.stack}>
          <IxMessageBar type="alarm" persistent>
            Error — {validation.length} validation error{validation.length === 1 ? "" : "s"} in the project block the deployment. The dry run still shows the plan.
          </IxMessageBar>
          {onOpenValidation ? (
            <div className={styles.row}>
              <IxButton variant="secondary" iconRight={iconArrowRight} onClick={onOpenValidation}>
                Open overview &amp; health
              </IxButton>
            </div>
          ) : null}
          <BlockerList blockers={validation} />
        </div>
      ) : (
        <IxTypography format="body-sm" textColor="soft">
          Validation passed{plan.validation.warnings ? ` with ${plan.validation.warnings} warning${plan.validation.warnings === 1 ? "" : "s"}` : ""} — no errors block the deployment.
        </IxTypography>
      )}

      {others.length ? (
        <section className={styles.stack} aria-label="Blockers">
          <h3 className={`typography-h5 ${styles.heading}`}>Blockers ({others.length})</h3>
          <BlockerList blockers={others} />
        </section>
      ) : null}

      {notes.length ? (
        <section className={styles.stack} aria-label="Notes">
          <h3 className={`typography-h5 ${styles.heading}`}>Notes</h3>
          <ul className={styles.list}>
            {notes.slice(0, 50).map((n) => (
              <li key={n} className={styles.listItem}>
                <IxTypography format="body-sm" className={styles.text}>
                  {n}
                </IxTypography>
              </li>
            ))}
          </ul>
          {notes.length > 50 ? (
            <IxTypography format="body-xs" textColor="soft">
              … and {notes.length - 50} more.
            </IxTypography>
          ) : null}
        </section>
      ) : null}

      <section className={styles.stack} aria-label="Steps">
        <h3 className={`typography-h5 ${styles.heading}`}>Steps by phase</h3>
        <StepTable plan={plan} onOpen={onOpenStep} label="Planned steps" />
      </section>

      {plan.mode === "deploy" && plan.removedFromProject.length ? (
        <section className={styles.stack} aria-label="Removed from the project">
          <h3 className={`typography-h5 ${styles.heading}`}>Removed from the project ({plan.removedFromProject.length})</h3>
          <IxTypography format="body-sm" textColor="soft">
            These objects were deployed by this project earlier and are no longer in it. Deploy mode keeps them; Sync mode deletes them physically.
          </IxTypography>
          <ObjectList items={plan.removedFromProject} label="Removed from the project" empty="" />
        </section>
      ) : null}

      <section className={styles.stack} aria-label="Only in the target">
        <h3 className={`typography-h5 ${styles.heading}`}>Only in the target ({plan.targetOnly.length})</h3>
        <IxTypography format="body-sm" textColor="soft">
          Objects in the tenant that this project does not know. They are never modified or deleted.
        </IxTypography>
        <ObjectList items={plan.targetOnly} label="Objects only in the target" empty="The target contains nothing beyond this project." />
      </section>
    </div>
  );
}
