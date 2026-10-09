// Tenant connections (/tenants): connections grouped by environment, create /
// edit (write-only secrets), test, delete, open the explorer.
// PageHeader renders this route's single <h1>.

import { useState } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxCard, IxCardContent, IxChip, IxEmptyState, IxMessageBar, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconCloud, iconConnected, iconOpenExternal, iconPen, iconRefresh, iconTrashcan } from "@siemens/ix-icons/icons";
import { api, type ConnectionSummary, type ConnectionTestResult } from "@/api/client";
import { confirmDialog } from "@/components/dialogs";
import { notifySuccess } from "@/components/notify";
import { Page, Section } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { authModeLabel, groupByEnvironment, SIMULATOR_LABEL } from "@/online/connections";
import { describeError, OFFLINE_HINT } from "@/online/errors";
import { useConnections } from "@/online/hooks";
import { useMeStore } from "@/state/meStore";
import { ErrorBanner, formatTime, KeyValueGrid, Loading, notifyFailure } from "./explorer/ui";
import { openConnectionDialog } from "./ConnectionFormDialog";
import styles from "./ConnectionsPage.module.css";

function TestResult({ c, live }: { c: ConnectionSummary; live?: ConnectionTestResult }) {
  if (live) {
    return (
      <div className={styles.result}>
        <IxChip variant={live.ok ? "success" : "alarm"} outline inactive>
          {live.ok ? "test passed" : "test failed"}
        </IxChip>
        <IxTypography format="body-sm">
          {live.ok
            ? `${live.latencyMs} ms · root asset ${live.rootName ?? ""}${live.rootAssetId ? ` (${live.rootAssetId})` : ""}`
            : live.message ?? "Failed"}
        </IxTypography>
      </div>
    );
  }
  if (!c.lastTest) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        Not tested yet.
      </IxTypography>
    );
  }
  return (
    <div className={styles.result}>
      <IxChip variant={c.lastTest.ok ? "success" : "alarm"} outline inactive>
        {c.lastTest.ok ? "last test passed" : "last test failed"}
      </IxChip>
      <IxTypography format="body-sm" textColor="soft">
        {formatTime(c.lastTest.at)}
        {c.lastTest.latencyMs !== undefined ? ` · ${c.lastTest.latencyMs} ms` : ""}
        {c.lastTest.message ? ` · ${c.lastTest.message}` : ""}
      </IxTypography>
    </div>
  );
}

export function ConnectionsPage() {
  const navigate = useNavigate();
  const connections = useConnections();
  const backendOnline = useMeStore((s) => s.backendOnline);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const offline = backendOnline === false || (connections.error ? describeError(connections.error).offline : false);

  async function create() {
    const saved = await openConnectionDialog();
    if (saved) connections.reload();
  }

  async function edit(c: ConnectionSummary) {
    const saved = await openConnectionDialog(c);
    if (saved) connections.reload();
  }

  async function test(c: ConnectionSummary) {
    setTesting(c.id);
    try {
      const r = await api.connections.test(c.id);
      setResults((m) => ({ ...m, [c.id]: r }));
      if (r.ok) notifySuccess(`${c.name}: connected in ${r.latencyMs} ms.`);
      else notifyFailure(new Error(r.message ?? "Test failed"), c.name);
      connections.reload();
    } catch (e) {
      notifyFailure(e, `${c.name}: test failed`);
    } finally {
      setTesting(null);
    }
  }

  async function remove(c: ConnectionSummary) {
    const ok = await confirmDialog({
      title: `Delete connection ${c.name}?`,
      message: "The connection and its stored (encrypted) credentials are deleted from the backend. Nothing on the tenant is changed.",
      confirmLabel: "Delete connection",
      danger: true,
      details: (
        <ul className={styles.impact}>
          <li>
            <IxTypography format="body-sm">Tenant {c.tenant} · {c.environment} · {authModeLabel(c.authMode)}</IxTypography>
          </li>
          <li>
            <IxTypography format="body-sm">
              Deployment mappings and audit entries that reference this connection stay but can no longer be used to reach the tenant.
            </IxTypography>
          </li>
          {c.authMode === "simulator" ? (
            <li>
              <IxTypography format="body-sm">The simulated tenant data of this connection may be discarded by the backend.</IxTypography>
            </li>
          ) : null}
        </ul>
      ),
    });
    if (!ok) return;
    try {
      await api.connections.remove(c.id);
      notifySuccess(`Connection ${c.name} deleted.`);
      connections.reload();
    } catch (e) {
      notifyFailure(e, `Connection ${c.name} was not deleted`);
    }
  }

  const list = connections.data ?? [];
  const groups = groupByEnvironment(list);

  return (
    <Page>
      <PageHeader
        title="Tenant connections"
        subtitle="Insights Hub tenants per environment. Credentials stay in the backend and are never shown again."
        primaryAction={offline ? undefined : { label: "New connection", icon: iconAdd, onClick: () => void create() }}
        meta={
          <IxButton variant="secondary" icon={iconRefresh} loading={connections.loading} onClick={() => connections.reload()}>
            Refresh
          </IxButton>
        }
      />

      {offline ? (
        <IxMessageBar type="warning" persistent>
          <div className={styles.stack}>
            <IxTypography format="body" bold>
              The Asset Model Studio backend is not reachable.
            </IxTypography>
            <IxTypography format="body-sm">{OFFLINE_HINT}</IxTypography>
          </div>
        </IxMessageBar>
      ) : (
        <ErrorBanner error={connections.error} prefix="Connections could not be loaded" />
      )}

      {connections.loading && !connections.data ? <Loading label="Loading connections…" /> : null}

      {connections.data && list.length === 0 ? (
        <IxEmptyState
          icon={iconCloud}
          header="No tenant connections yet"
          subHeader="Add an Insights Hub tenant, or a simulated tenant to try everything without credentials."
          action="New connection"
          onActionClick={() => void create()}
        />
      ) : null}

      {groups.map((g) => (
        <Section key={g.environment} title={`${g.environment} (${g.connections.length})`}>
          <div className={styles.grid}>
            {g.connections.map((c) => (
              <IxCard key={c.id} variant="outline" className={styles.card} passive>
                <IxCardContent>
                  <div className={styles.cardBody}>
                    <div className={styles.cardHead}>
                      <h3 className={`typography-h5 ${styles.title}`}>{c.name}</h3>
                      <div className={styles.chips}>
                        <IxChip variant="primary" outline inactive>
                          {c.environment}
                        </IxChip>
                        {c.authMode === "simulator" ? (
                          <IxChip variant="warning" inactive>
                            simulated
                          </IxChip>
                        ) : null}
                      </div>
                    </div>
                    {c.authMode === "simulator" ? (
                      <IxTypography format="body-sm" bold>
                        {SIMULATOR_LABEL}
                      </IxTypography>
                    ) : null}
                    <KeyValueGrid
                      items={[
                        { label: "Tenant", value: c.tenant },
                        { label: "Authentication", value: authModeLabel(c.authMode) },
                        { label: "API base URL", value: c.authMode === "simulator" ? "in-process simulator" : c.apiBaseUrl ?? "" },
                        ...(c.tokenUrl ? [{ label: "Token URL", value: c.tokenUrl }] : []),
                        ...(c.clientIdHint ? [{ label: "Client ID", value: c.clientIdHint }] : []),
                        ...(c.appName ? [{ label: "App", value: `${c.appName} ${c.appVersion ?? ""}` }] : []),
                      ]}
                    />
                    <TestResult c={c} live={results[c.id]} />
                    <div className={styles.actions}>
                      <IxButton variant="primary" icon={iconOpenExternal} onClick={() => navigate(`/tenants/${encodeURIComponent(c.id)}`)}>
                        Open explorer
                      </IxButton>
                      <IxButton variant="secondary" icon={iconConnected} loading={testing === c.id} disabled={!!testing} onClick={() => void test(c)}>
                        Test connection
                      </IxButton>
                      <IxButton variant="secondary" icon={iconPen} onClick={() => void edit(c)}>
                        Edit {c.name}
                      </IxButton>
                      <IxButton variant="danger-secondary" icon={iconTrashcan} onClick={() => void remove(c)}>
                        Delete {c.name}
                      </IxButton>
                    </div>
                  </div>
                </IxCardContent>
              </IxCard>
            ))}
          </div>
        </Section>
      ))}
    </Page>
  );
}
