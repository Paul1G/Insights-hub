// Audit log (/audit): upstream calls, connection changes and app-level actions
// of the signed-in user, newest first; connection filter, "load older" via the
// `before` cursor, refresh and CSV export. PageHeader renders the route's <h1>.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { IxButton, IxChip, IxEmptyState, IxMessageBar, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAuditReport, iconDownload, iconRefresh } from "@siemens/ix-icons/icons";
import { api, type AuditEntry } from "@/api/client";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { notifySuccess } from "@/components/notify";
import { AUDIT_PAGE_SIZE, auditCsv, auditCsvFileName, auditOutcome, mergeOlder, olderCursor } from "@/online/audit";
import { describeError, OFFLINE_HINT } from "@/online/errors";
import { saveBlob } from "@/online/files";
import { useConnections } from "@/online/hooks";
import { useMeStore } from "@/state/meStore";
import { Grid } from "../tenants/explorer/Grid";
import { ErrorBanner, formatTime, Loading, notifyFailure } from "../tenants/explorer/ui";
import styles from "./AuditPage.module.css";

const ALL = "__all__";

function StatusCell({ data }: ICellRendererParams<AuditEntry>) {
  if (!data) return null;
  const outcome = auditOutcome(data);
  if (outcome === "info") return null;
  return (
    <IxChip variant={outcome === "ok" ? "success" : "alarm"} outline inactive>
      {data.status !== undefined ? String(data.status) : "error"}
    </IxChip>
  );
}

export function AuditPage() {
  const connections = useConnections();
  const backendOnline = useMeStore((s) => s.backendOnline);
  const [connectionId, setConnectionId] = useState(ALL);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hasMore, setHasMore] = useState(false);
  const scope = connectionId === ALL ? undefined : connectionId;

  const load = useCallback(
    async (mode: "reset" | "older", current: AuditEntry[] = []) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.audit.list({
          connectionId: scope,
          limit: AUDIT_PAGE_SIZE,
          before: mode === "older" ? olderCursor(current) : undefined,
        });
        setEntries(mode === "older" ? mergeOlder(current, page) : page);
        setHasMore(page.length >= AUDIT_PAGE_SIZE);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    void load("reset");
  }, [load]);

  const names = useMemo(() => new Map((connections.data ?? []).map((c) => [c.id, c.name])), [connections.data]);
  const columns = useMemo<ColDef<AuditEntry>[]>(
    () => [
      { headerName: "Time", width: 190, sort: "desc", valueGetter: (p) => p.data?.at ?? "", valueFormatter: (p) => formatTime(p.value as string) },
      { field: "userId", headerName: "User", width: 150 },
      {
        headerName: "Connection",
        width: 170,
        valueGetter: (p) => (p.data ? p.data.connectionName ?? (p.data.connectionId ? names.get(p.data.connectionId) ?? p.data.connectionId : "") : ""),
      },
      { field: "kind", headerName: "Kind", width: 120 },
      { field: "method", headerName: "Method", width: 100 },
      { headerName: "Path / action", flex: 2, minWidth: 220, valueGetter: (p) => (p.data ? (p.data.path ?? p.data.action ?? "") : "") },
      { headerName: "Status", width: 110, cellRenderer: StatusCell, valueGetter: (p) => p.data?.status ?? "" },
      { field: "durationMs", headerName: "Duration (ms)", width: 140, type: "rightAligned" },
      { field: "attempts", headerName: "Attempts", width: 110, type: "rightAligned" },
      { headerName: "Summary / error", flex: 3, minWidth: 240, valueGetter: (p) => (p.data ? p.data.error ?? p.data.summary ?? "" : ""), tooltipValueGetter: (p) => p.value as string },
    ],
    [names],
  );

  function exportCsv() {
    try {
      const name = scope ? names.get(scope) : undefined;
      saveBlob(new Blob([auditCsv(entries)], { type: "text/csv;charset=utf-8" }), auditCsvFileName(new Date(), name));
      notifySuccess(`${entries.length} audit entries exported.`);
    } catch (e) {
      notifyFailure(e, "Export failed");
    }
  }

  const offline = backendOnline === false || (error ? describeError(error).offline : false);

  return (
    <Page>
      <PageHeader
        title="Audit log"
        subtitle="Every write to a tenant, every connection change and app-level actions such as batch operations. Bodies and secrets are never recorded."
        meta={
          <>
            <IxButton variant="secondary" icon={iconRefresh} loading={loading} onClick={() => void load("reset")}>
              Refresh
            </IxButton>
            <IxButton variant="secondary" icon={iconDownload} disabled={!entries.length} onClick={exportCsv}>
              Export CSV
            </IxButton>
          </>
        }
      />
      <search aria-label="Audit log filters" className={styles.toolbar}>
        <IxSelect
          className={styles.select}
          label="Connection"
          value={connectionId}
          onValueChange={(e) => {
            if (typeof e.detail === "string") setConnectionId(e.detail || ALL);
          }}
        >
          <IxSelectItem value={ALL} label="All connections" />
          {(connections.data ?? []).map((c) => (
            <IxSelectItem key={c.id} value={c.id} label={`${c.name} (${c.environment})`} />
          ))}
        </IxSelect>
        <IxTypography format="body-sm" textColor="soft" role="status">
          {loading ? "Loading…" : `${entries.length} entr${entries.length === 1 ? "y" : "ies"} loaded${hasMore ? " (older entries available)" : ""}.`}
        </IxTypography>
      </search>
      {offline ? (
        <IxMessageBar type="warning" persistent>
          The backend is not reachable, so the audit log is unavailable. {OFFLINE_HINT}
        </IxMessageBar>
      ) : (
        <ErrorBanner error={error} prefix="The audit log could not be loaded" />
      )}
      {loading && !entries.length ? <Loading label="Loading the audit log…" /> : null}
      {!loading && !error && entries.length === 0 ? (
        <IxEmptyState
          icon={iconAuditReport}
          header="No audit entries"
          subHeader={scope ? "Nothing was recorded for this connection yet." : "Changes to tenants and connections appear here."}
          action="Refresh"
          onActionClick={() => void load("reset")}
        />
      ) : null}
      {entries.length ? (
        <Grid label="Audit entries" size="tall" rows={entries} columns={columns} rowId={(e) => e.id} />
      ) : null}
      {hasMore ? (
        <div>
          <IxButton variant="secondary" loading={loading} onClick={() => void load("older", entries)}>
            Load older entries
          </IxButton>
        </div>
      ) : null}
    </Page>
  );
}

