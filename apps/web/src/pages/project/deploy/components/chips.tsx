// Operation / status chips and the plan summary tiles.

import { IxCard, IxCardContent, IxChip, IxTypography } from "@siemens/ix-react";
import type { PlanSummary, RunStatus, StepOp, StepStatus } from "@/deploy/types";
import { OP_LABELS, RUN_STATUS_LABELS, STATUS_LABELS } from "./labels";
import styles from "./deploy.module.css";

type ChipVariant = "primary" | "success" | "info" | "warning" | "alarm" | "neutral" | "critical";


const OP_VARIANT: Record<StepOp, ChipVariant> = {
  create: "success",
  upload: "success",
  update: "info",
  location: "info",
  assign: "info",
  unassign: "warning",
  move: "primary",
  delete: "alarm",
  skip: "neutral",
};

export function OpChip({ op, blocked }: { op: StepOp; blocked?: boolean }) {
  if (blocked) {
    return (
      <IxChip variant="critical" outline>
        Blocked · {OP_LABELS[op]}
      </IxChip>
    );
  }
  return (
    <IxChip variant={OP_VARIANT[op]} outline>
      {OP_LABELS[op]}
    </IxChip>
  );
}


const STATUS_VARIANT: Record<StepStatus, ChipVariant> = {
  pending: "neutral",
  running: "primary",
  succeeded: "success",
  failed: "alarm",
  conflict: "warning",
  skipped: "neutral",
  "skipped-dependency": "neutral",
  "rolled-back": "info",
};

export function StatusChip({ status }: { status: StepStatus }) {
  return <IxChip variant={STATUS_VARIANT[status]}>{STATUS_LABELS[status]}</IxChip>;
}


const RUN_STATUS_VARIANT: Record<RunStatus, ChipVariant> = {
  planned: "neutral",
  running: "primary",
  paused: "warning",
  completed: "success",
  "completed-with-errors": "warning",
  failed: "alarm",
  "rolled-back": "info",
  cancelled: "neutral",
};

export function RunStatusChip({ status }: { status: RunStatus }) {
  return <IxChip variant={RUN_STATUS_VARIANT[status]}>{RUN_STATUS_LABELS[status]}</IxChip>;
}

export function Tiles({ items, label }: { items: { label: string; value: number | string }[]; label: string }) {
  return (
    <ul className={styles.tiles} aria-label={label}>
      {items.map((t) => (
        <li key={t.label} className={styles.tile}>
          <IxCard variant="outline" className={styles.tile} passive>
            <IxCardContent>
              <div className={styles.tileBody}>
                <IxTypography format="label-sm" textColor="soft">
                  {t.label}
                </IxTypography>
                <IxTypography format="display-sm">{t.value}</IxTypography>
              </div>
            </IxCardContent>
          </IxCard>
        </li>
      ))}
    </ul>
  );
}

export function PlanSummaryTiles({ summary }: { summary: PlanSummary }) {
  return (
    <Tiles
      label="Plan summary"
      items={[
        { label: "New", value: summary.create },
        { label: "Updates", value: summary.update },
        { label: "Moves", value: summary.move },
        { label: "Deletions", value: summary.delete },
        { label: "Unchanged", value: summary.skip },
        { label: "Blocked", value: summary.blocked },
      ]}
    />
  );
}
