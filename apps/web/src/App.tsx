// Application shell: header, menu (global + project-scoped entries) and the
// routed content region.

import { registerTheme } from "@siemens/ix-echarts";
import {
  iconAuditReport,
  iconBackup,
  iconCloud,
  iconCloudDownload,
  iconCloudUpload,
  iconCogwheel,
  iconCopy,
  iconDocument,
  iconFolder,
  iconHealth,
  iconHome,
  iconLibrary,
  iconObjectsTree,
  iconProject,
  iconTree,
  iconVersionHistory,
  iconApps,
} from "@siemens/ix-icons/icons";
import {
  IxApplication,
  IxApplicationHeader,
  IxAvatar,
  IxContent,
  IxMenu,
  IxMenuCategory,
  IxMenuItem,
  IxSpinner,
} from "@siemens/ix-react";
import * as echarts from "echarts/core";
import { Suspense, useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import AppHeaderBrand from "./AppHeaderBrand";
import { useMeStore } from "./state/meStore";
import { useProjectStore } from "./state/projectStore";
import { useSettingsStore } from "./state/settingsStore";

registerTheme(echarts);

// Id of the <main>-side landmark content, shared by the skip link and its target.
const MAIN_CONTENT_ID = "main-content";

interface NavEntry {
  path: string;
  label: string;
  icon: string;
  /** Match the path exactly instead of as a prefix. */
  exact?: boolean;
}

const GLOBAL_NAV: NavEntry[] = [
  { path: "/library", label: "Library", icon: iconLibrary },
  { path: "/tenants", label: "Tenants", icon: iconCloud },
  { path: "/copy", label: "Cross-tenant copy", icon: iconCopy },
  { path: "/backup", label: "Backup tenant", icon: iconBackup },
  { path: "/audit", label: "Audit log", icon: iconAuditReport },
  { path: "/settings", label: "Guardrails & settings", icon: iconCogwheel },
];

function projectNav(id: string): NavEntry[] {
  const base = `/p/${id}`;
  return [
    { path: base, label: "Overview & health", icon: iconHealth, exact: true },
    { path: `${base}/tenant`, label: "Tenant model", icon: iconCloudDownload },
    { path: `${base}/aspect-types`, label: "Aspect types", icon: iconApps },
    { path: `${base}/asset-types`, label: "Asset types", icon: iconObjectsTree },
    { path: `${base}/hierarchy`, label: "Hierarchy", icon: iconTree },
    { path: `${base}/files`, label: "Files", icon: iconFolder },
    { path: `${base}/versions`, label: "Versions", icon: iconVersionHistory },
    { path: `${base}/portability`, label: "Import, export & docs", icon: iconDocument },
    { path: `${base}/deploy`, label: "Deploy", icon: iconCloudUpload },
  ];
}

function isActive(pathname: string, entry: NavEntry): boolean {
  return entry.exact ? pathname === entry.path : pathname === entry.path || pathname.startsWith(`${entry.path}/`);
}

function App() {
  const menuRef = useRef<HTMLIxMenuElement>(null);
  const contentRef = useRef<HTMLIxContentElement>(null);
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const previousPathname = useRef<string | null>(null);
  const project = useProjectStore((s) => s.project);
  const me = useMeStore((s) => s.me);
  const backendOnline = useMeStore((s) => s.backendOnline);

  useEffect(() => {
    void useSettingsStore.getState().init();
    void useMeStore.getState().load();
  }, []);

  // WCAG 2.4.1 (Bypass Blocks). The router is a *hash* router, so letting the
  // browser follow href="#main-content" would be read as a route change.
  // Move the focus ourselves instead.
  function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    contentRef.current?.focus();
  }

  // WCAG 2.4.3 (Focus Order): move focus into the content on route changes.
  useEffect(() => {
    if (previousPathname.current !== null && previousPathname.current !== pathname) {
      contentRef.current?.focus();
    }
    previousPathname.current = pathname;
  }, [pathname]);

  const item = (entry: NavEntry) => (
    <IxMenuItem
      key={entry.path}
      icon={entry.icon}
      active={isActive(pathname, entry)}
      onClick={() => navigate(entry.path)}
    >
      {entry.label}
    </IxMenuItem>
  );

  const userName = me?.username ?? me?.email ?? (me?.anonymous ? "Local user" : "User");
  const status = backendOnline === false ? "Offline — tenant features unavailable" : me?.email ?? "Signed in";

  return (
    <>
      <a className="skip-link" href={`#${MAIN_CONTENT_ID}`} onClick={skipToContent}>
        {t("skip-to-main-content")}
      </a>

      <IxApplication>
        <IxApplicationHeader>
          <AppHeaderBrand name="Asset Model Studio" />
          <IxAvatar username={userName} extra={status} />
        </IxApplicationHeader>

        <IxMenu ref={menuRef} enableToggleTheme i18nToggleTheme={t("toggle-theme")}>
          <IxMenuItem home icon={iconHome} active={pathname === "/"} onClick={() => navigate("/")}>
            Projects
          </IxMenuItem>
          {project ? (
            <IxMenuCategory label={project.name} icon={iconProject}>
              {projectNav(project.id).map(item)}
            </IxMenuCategory>
          ) : null}
          {GLOBAL_NAV.map(item)}
        </IxMenu>

        {/* tabIndex={-1}: focusable for the skip link / route change, no tab stop. */}
        <IxContent ref={contentRef} id={MAIN_CONTENT_ID} tabIndex={-1}>
          <Suspense
            fallback={
              <div className="route-loading">
                <IxSpinner size="large" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </IxContent>
      </IxApplication>
    </>
  );
}

export default App;
