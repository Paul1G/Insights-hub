// Preview of a spreadsheet import: per-row action (create / update /
// unchanged / error) with field diffs, then Apply (one undoable step) or Cancel.

import { useMemo, useState } from "react";
import { IxButton, IxChip, IxMessageBar, IxRadio, IxRadioGroup, IxTypography } from "@siemens/ix-react";
import { iconRefresh } from "@siemens/ix-icons/icons";
import { DashboardPanel } from "@/components/DashboardPanel";
import { DiffView } from "@/components/DiffView";
import { planChangeCount, type ImportRowResult, type RowAction, type TableImportPlan } from "@/portability/tables";
import { MessageList } from "./FileDrop";
import styles from "./Portability.module.css";

type Filter = "changes" | "errors" | "all";

const PAGE = 200;

const ACTION_CHIP: Record<RowAction, { variant: "success" | "info" | "neutral" | "alarm"; label: string }> = {
  create: { variant: "success", label: "create" },
  update: { variant: "info", label: "update" },
  unchanged: { variant: "neutral", label: "unchanged" },
  error: { variant: "alarm", label: "error" },
};

function RowEntry({ row }: { row: ImportRowResult }) {
  const chip = ACTION_CHIP[row.action];
  return (
    <li className={styles.rowItem}>
      <div className={styles.rowHead}>
        <IxChip variant={chip.variant} outline>
          {chip.label}
        </IxChip>
        <IxTypography format="label-sm" textColor="soft" className={styles.meta}>
          {`${row.table} · row ${row.rowNumber}`}
        </IxTypography>
        <IxTypography format="body-sm" bold className={styles.rowLabel}>
          {row.label}
        </IxTypography>
      </div>
      {row.errors.length ? <MessageList items={row.errors} /> : null}
      {row.warnings.length ? (
        <IxTypography format="body-xs" textColor="soft" className={styles.text}>
          {row.warnings.join(" ")}
        </IxTypography>
      ) : null}
      {row.changes.length && row.action !== "error" ? (
        <DiffView changes={row.changes} beforeLabel="Current" afterLabel={row.action === "create" ? "New" : "Imported"} />
      ) : null}
    </li>
  );
}

export function ImportPreview({
  plan,
  fileWarnings,
  stale,
  onRefresh,
  onApply,
  onCancel,
}: {
  plan: TableImportPlan;
  fileWarnings: string[];
  stale: boolean;
  onRefresh: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState<Filter>(plan.counts.create + plan.counts.update + plan.counts.error > 0 ? "changes" : "all");
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(
    () =>
      plan.rows.filter((r) =>
        filter === "all" ? true : filter === "errors" ? r.action === "error" : r.action !== "unchanged",
      ),
    [plan, filter],
  );
  const changes = planChangeCount(plan);
  const shown = rows.slice(0, limit);

  return (
    <DashboardPanel title="Import preview" span="full">
      <div className={styles.stack}>
        <div className={styles.summary} role="status">
          <IxChip variant="success" outline>{`${plan.counts.create} create`}</IxChip>
          <IxChip variant="info" outline>{`${plan.counts.update} update`}</IxChip>
          <IxChip variant="neutral" outline>{`${plan.counts.unchanged} unchanged`}</IxChip>
          <IxChip variant={plan.counts.error ? "alarm" : "neutral"} outline>{`${plan.counts.error} errors`}</IxChip>
          <IxTypography format="body-sm" textColor="soft" className={styles.text}>
            {changes === 0
              ? "Nothing to apply."
              : `${changes} entit${changes === 1 ? "y" : "ies"} will change${
                  plan.indirect ? `, ${plan.indirect} of them as a side effect (renamed variables or aspects carry their values)` : ""
                }.`}
          </IxTypography>
        </div>

        {stale ? (
          <IxMessageBar type="warning" persistent>
            The project was edited after this preview was created. Refresh the preview before applying.
          </IxMessageBar>
        ) : null}
        {fileWarnings.length ? (
          <IxMessageBar type="warning">
            <MessageList items={fileWarnings} />
          </IxMessageBar>
        ) : null}
        {plan.counts.error ? (
          <IxMessageBar type="alarm" persistent>
            {`${plan.counts.error} row(s) have errors and will be skipped. Fix them in the file and import it again, or apply the valid rows.`}
          </IxMessageBar>
        ) : null}

        <IxRadioGroup
          label="Show rows"
          direction="row"
          value={filter}
          onValueChange={(e) => {
            setFilter(e.detail === "errors" || e.detail === "all" ? e.detail : "changes");
            setLimit(PAGE);
          }}
        >
          <IxRadio label="Changes and errors" value="changes" />
          <IxRadio label="Errors only" value="errors" />
          <IxRadio label="All rows" value="all" />
        </IxRadioGroup>

        {rows.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            No rows match this filter.
          </IxTypography>
        ) : (
          <ul className={styles.rows} aria-label="Import rows">
            {shown.map((r) => (
              <RowEntry key={`${r.table}:${r.rowNumber}`} row={r} />
            ))}
          </ul>
        )}
        {rows.length > shown.length ? (
          <div className={styles.row}>
            <IxTypography format="body-sm" textColor="soft">{`Showing ${shown.length} of ${rows.length} rows.`}</IxTypography>
            <IxButton variant="subtle-secondary" onClick={() => setLimit((n) => n + PAGE)}>
              Show more rows
            </IxButton>
          </div>
        ) : null}

        <div className={styles.actions}>
          <IxButton variant="secondary" onClick={onCancel}>
            Discard preview
          </IxButton>
          {stale ? (
            <IxButton variant="primary" icon={iconRefresh} onClick={onRefresh}>
              Refresh preview
            </IxButton>
          ) : (
            <IxButton variant="primary" disabled={changes === 0} onClick={onApply}>
              {`Apply ${changes} change${changes === 1 ? "" : "s"}`}
            </IxButton>
          )}
        </div>
      </div>
    </DashboardPanel>
  );
}
