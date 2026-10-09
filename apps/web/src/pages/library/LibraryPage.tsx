// Library: core (OOTB) type browser with tenant sync, existing tenant types
// and assets (tenant catalog), and user libraries.
// The route's <h1> is rendered by the shared PageHeader; tab panels follow
// the entity-detail-tabs archetype (ids + aria-controls / aria-labelledby).

import { useState } from "react";
import { IxTabItem, IxTabs } from "@siemens/ix-react";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { CoreLibraryTab } from "./CoreLibraryTab";
import { TenantTypesTab } from "./TenantTypesTab";
import { UserLibrariesTab } from "./UserLibrariesTab";
import styles from "./Library.module.css";

const TABS = [
  { key: "core", label: "Core library" },
  { key: "tenant", label: "Tenant types" },
  { key: "user", label: "User libraries" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const tabId = (key: TabKey) => `library-tab-${key}`;
const panelId = (key: TabKey) => `library-panel-${key}`;

export function LibraryPage() {
  const [tab, setTab] = useState<TabKey>("core");
  return (
    <Page>
      <PageHeader
        title="Library"
        subtitle="Core types every tenant provides, the existing types and assets of your tenants, and your own reusable type collections."
      />
      <IxTabs activeTabKey={tab} onTabChange={(e) => setTab((e.detail as TabKey | undefined) ?? "core")}>
        {TABS.map((t) => (
          <IxTabItem key={t.key} tabKey={t.key} id={tabId(t.key)} aria-controls={panelId(t.key)}>
            {t.label}
          </IxTabItem>
        ))}
      </IxTabs>
      {TABS.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={panelId(t.key)}
          aria-labelledby={tabId(t.key)}
          hidden={tab !== t.key}
          className={styles.panel}
        >
          {t.key === "core" ? <CoreLibraryTab /> : t.key === "tenant" ? tab === "tenant" ? <TenantTypesTab /> : null : <UserLibrariesTab />}
        </div>
      ))}
    </Page>
  );
}
