// Tenant explorer (/tenants/:connectionId): online CRUD for aspect types,
// asset types, assets and files of one connection (entity-detail-tabs).
// PageHeader renders this route's single <h1>.

import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { IxButton, IxEmptyState, IxMessageBar, IxTabItem, IxTabs, IxTypography } from "@siemens/ix-react";
import { iconCloud, iconRefresh } from "@siemens/ix-icons/icons";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { authModeLabel, SIMULATOR_LABEL } from "@/online/connections";
import { useConnections } from "@/online/hooks";
import { useMeStore } from "@/state/meStore";
import { AspectTypesTab } from "./explorer/AspectTypesTab";
import { AssetsTab } from "./explorer/AssetsTab";
import { AssetTypesTab } from "./explorer/AssetTypesTab";
import { useCatalog } from "./explorer/catalog";
import { FilesTab } from "./explorer/FilesTab";
import { ErrorBanner, Loading } from "./explorer/ui";
import styles from "./TenantExplorerPage.module.css";

const TABS = [
  { key: "aspecttypes", label: "Aspect types" },
  { key: "assettypes", label: "Asset types" },
  { key: "assets", label: "Assets" },
  { key: "files", label: "Files" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const tabId = (k: TabKey) => `tenant-explorer-tab-${k}`;
const panelId = (k: TabKey) => `tenant-explorer-panel-${k}`;

export function TenantExplorerPage() {
  const { connectionId = "" } = useParams();
  const navigate = useNavigate();
  const backendOnline = useMeStore((s) => s.backendOnline);
  const connections = useConnections();
  const connection = connections.data?.find((c) => c.id === connectionId) ?? null;
  const catalog = useCatalog(connection);
  const [tab, setTab] = useState<TabKey>("aspecttypes");
  // Panels are mounted on first visit and kept (state survives tab switches).
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set(["aspecttypes"]));

  const select = (k: TabKey) => {
    setTab(k);
    setVisited((v) => (v.has(k) ? v : new Set(v).add(k)));
  };

  const breadcrumb = [{ label: "Tenants", href: "#/tenants" }, { label: connection?.name ?? "Tenant explorer" }];

  if (backendOnline === false || (connections.error && !connections.data)) {
    return (
      <Page>
        <PageHeader title="Tenant explorer" breadcrumb={breadcrumb} />
        <ErrorBanner error={connections.error} prefix="Connections could not be loaded" />
        {backendOnline === false && !connections.error ? (
          <IxMessageBar type="warning" persistent>
            The backend is not reachable. Tenant features are unavailable offline; projects, modelling and validation keep working.
          </IxMessageBar>
        ) : null}
        <div>
          <IxButton variant="secondary" icon={iconRefresh} onClick={() => connections.reload()}>
            Retry
          </IxButton>
        </div>
      </Page>
    );
  }

  if (!connection) {
    return (
      <Page>
        <PageHeader title="Tenant explorer" breadcrumb={breadcrumb} />
        {connections.loading || !connections.data ? (
          <Loading label="Loading the connection…" />
        ) : (
          <IxEmptyState
            icon={iconCloud}
            header="Connection not found"
            subHeader="It may have been deleted. Choose a connection on the tenant connections page."
            action="Open tenant connections"
            onActionClick={() => navigate("/tenants")}
          />
        )}
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={connection.name}
        subtitle={`Tenant ${connection.tenant} · ${connection.environment} · ${authModeLabel(connection.authMode)}`}
        breadcrumb={breadcrumb}
      />
      {connection.authMode === "simulator" ? (
        <IxMessageBar type="info" persistent>
          {SIMULATOR_LABEL}. Changes stay in the backend's simulator and never reach Insights Hub.
        </IxMessageBar>
      ) : (
        <IxTypography format="body-sm" textColor="soft">
          Changes are applied directly to {connection.apiBaseUrl ?? "the tenant"} and recorded in the audit log.
        </IxTypography>
      )}

      <IxTabs activeTabKey={tab} onTabChange={(e) => e.detail && select(e.detail as TabKey)}>
        {TABS.map((t) => (
          <IxTabItem key={t.key} tabKey={t.key} id={tabId(t.key)} aria-controls={panelId(t.key)}>
            {t.label}
          </IxTabItem>
        ))}
      </IxTabs>

      {catalog
        ? TABS.map((t) => (
            <div
              key={t.key}
              role="tabpanel"
              id={panelId(t.key)}
              aria-labelledby={tabId(t.key)}
              hidden={tab !== t.key}
              className={styles.panel}
            >
              {visited.has(t.key) ? (
                t.key === "aspecttypes" ? (
                  <AspectTypesTab catalog={catalog} />
                ) : t.key === "assettypes" ? (
                  <AssetTypesTab catalog={catalog} />
                ) : t.key === "assets" ? (
                  <AssetsTab catalog={catalog} />
                ) : (
                  <FilesTab catalog={catalog} />
                )
              ) : null}
            </div>
          ))
        : null}
    </Page>
  );
}
