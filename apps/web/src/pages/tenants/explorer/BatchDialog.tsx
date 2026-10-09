// Batch operation dialog: preview of every request → confirmation → execution
// with at most 4 requests in flight → per-item results and summary → audit entry.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IxButton, IxChip, IxMessageBar, IxProgressIndicator, IxTypography } from "@siemens/ix-react";
import {
  BATCH_CONCURRENCY,
  describeBody,
  describeRequest,
  recordBatchAudit,
  runBatch,
  summaryText,
  type BatchItem,
  type BatchItemResult,
  type BatchSummary,
} from "@/online/batch";
import { errorText } from "@/online/errors";
import { defaultAuditSink, defaultTransport } from "@/online/transport";
import { DialogFrame, notifyFailure, openDialog, type DialogControl } from "./ui";
import styles from "./explorer.module.css";

interface Row {
  key: string;
  title: string;
  lines: string[];
  chip?: { label: string; variant: "success" | "alarm" | "neutral" | "warning" | "info" };
}

function VirtualRows({ rows, label }: { rows: Row[]; label: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });
  return (
    <div ref={parentRef} className={styles.scrollBox} role="list" aria-label={label} tabIndex={0}>
      <div className={styles.virtualInner} style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((vi) => {
          const r = rows[vi.index]!;
          return (
            <div
              key={r.key}
              role="listitem"
              data-index={vi.index}
              ref={v.measureElement}
              className={styles.virtualRow}
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <div className={styles.row}>
                {r.chip ? (
                  <IxChip variant={r.chip.variant} outline inactive>
                    {r.chip.label}
                  </IxChip>
                ) : null}
                <IxTypography format="body-sm" bold>
                  {r.title}
                </IxTypography>
              </div>
              {r.lines.map((l, i) => (
                <IxTypography key={i} format="code-sm" textColor="soft" className={styles.code}>
                  {l}
                </IxTypography>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const OUTCOME_CHIP: Record<BatchItemResult["outcome"], Row["chip"]> = {
  succeeded: { label: "succeeded", variant: "success" },
  failed: { label: "failed", variant: "alarm" },
  skipped: { label: "skipped", variant: "neutral" },
};

type Phase = "preview" | "running" | "done";

function BatchBody({
  connectionId,
  title,
  auditAction,
  items,
  intro,
  danger,
  ctl,
}: {
  connectionId: string;
  title: string;
  auditAction: string;
  items: BatchItem[];
  intro?: ReactNode;
  danger: boolean;
  ctl: DialogControl<BatchSummary>;
}) {
  const [phase, setPhase] = useState<Phase>("preview");
  const [results, setResults] = useState<BatchItemResult[]>([]);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [auditNote, setAuditNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runnable = items.filter((i) => i.request).length;
  const blocked = items.length - runnable;

  const previewRows = useMemo<Row[]>(
    () =>
      items.map((i) => ({
        key: i.key,
        title: i.label,
        lines: i.request ? [describeRequest(i.request), describeBody(i.request)].filter((x): x is string => !!x) : [i.blockedReason ?? "Blocked"],
        chip: i.request ? { label: "will run", variant: "info" } : { label: "blocked", variant: "warning" },
      })),
    [items],
  );

  const resultRows = useMemo<Row[]>(
    () =>
      results.map((r) => ({
        key: r.key,
        title: r.label,
        lines: [
          [r.status !== undefined ? `HTTP ${r.status}` : null, r.message, r.attempts && r.attempts > 1 ? `${r.attempts} attempts` : null]
            .filter(Boolean)
            .join(" · "),
        ],
        chip: OUTCOME_CHIP[r.outcome],
      })),
    [results],
  );

  async function execute() {
    setPhase("running");
    ctl.setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const collected: BatchItemResult[] = [];
    try {
      const res = await runBatch(defaultTransport, connectionId, items, {
        concurrency: BATCH_CONCURRENCY,
        signal: ctrl.signal,
        onResult: (r) => {
          collected.push(r);
          setResults([...collected]);
        },
      });
      setResults(res.results);
      setSummary(res.summary);
      try {
        await recordBatchAudit(defaultAuditSink, connectionId, auditAction, title, res.summary);
        setAuditNote("Recorded in the audit log.");
      } catch (e) {
        setAuditNote(`The audit entry could not be recorded: ${errorText(e)}`);
      }
    } catch (e) {
      notifyFailure(e, title);
    } finally {
      ctl.setBusy(false);
      setPhase("done");
    }
  }

  const done = results.length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 100;

  const footer =
    phase === "preview" ? (
      <>
        <IxButton variant="secondary" onClick={() => ctl.dismiss()}>
          Cancel
        </IxButton>
        <IxButton variant={danger ? "danger-primary" : "primary"} disabled={runnable === 0} onClick={() => void execute()}>
          Run {runnable} request{runnable === 1 ? "" : "s"}
        </IxButton>
      </>
    ) : phase === "running" ? (
      <IxButton variant="secondary" onClick={() => abortRef.current?.abort()}>
        Stop after running requests
      </IxButton>
    ) : (
      <IxButton variant="primary" onClick={() => ctl.close(summary ?? { total: items.length, succeeded: 0, failed: 0, skipped: items.length })}>
        Done
      </IxButton>
    );

  return (
    <DialogFrame title={title} danger={danger} busy={phase === "running"} footer={footer}>
      {phase === "preview" ? (
        <>
          {intro ? <IxTypography>{intro}</IxTypography> : null}
          <IxTypography format="body-sm" textColor="soft">
            {runnable} of {items.length} item{items.length === 1 ? "" : "s"} will be sent{blocked ? `, ${blocked} blocked` : ""}.
            At most {BATCH_CONCURRENCY} requests run at the same time; every request carries the ETag shown here.
          </IxTypography>
          <VirtualRows rows={previewRows} label="Requests to send" />
        </>
      ) : (
        <>
          {/* iX 5.0: ix-progress-indicator is not nameable (conventions A8) — the
              text next to it carries the value for assistive tech. */}
          <IxProgressIndicator aria-hidden="true" value={pct} max={100} status={phase === "done" && summary?.failed ? "warning" : "default"} />
          <IxTypography format="body-sm" role="status">
            {phase === "running" ? `${done} of ${items.length} processed…` : summary ? summaryText(title, summary) : ""}
          </IxTypography>
          {phase === "done" && summary ? (
            <IxMessageBar type={summary.failed ? "warning" : "success"} persistent>
              {summary.failed
                ? `${summary.failed} request${summary.failed === 1 ? "" : "s"} failed. Review the messages below; 412 means the object changed since the preview.`
                : "All runnable requests succeeded."}
            </IxMessageBar>
          ) : null}
          {auditNote ? (
            <IxTypography format="body-xs" textColor="soft">
              {auditNote}
            </IxTypography>
          ) : null}
          <VirtualRows rows={resultRows} label="Results" />
        </>
      )}
    </DialogFrame>
  );
}

/** Preview → confirm → execute; resolves with the summary (undefined when cancelled in the preview). */
export function openBatchDialog(opts: {
  connectionId: string;
  title: string;
  /** Audit action id, e.g. "batch.delete-assets". */
  auditAction: string;
  items: BatchItem[];
  intro?: ReactNode;
  danger?: boolean;
}): Promise<BatchSummary | undefined> {
  return openDialog<BatchSummary>({
    title: opts.title,
    size: "840",
    content: (ctl) => (
      <BatchBody
        connectionId={opts.connectionId}
        title={opts.title}
        auditAction={opts.auditAction}
        items={opts.items}
        intro={opts.intro}
        danger={!!opts.danger}
        ctl={ctl}
      />
    ),
  });
}
