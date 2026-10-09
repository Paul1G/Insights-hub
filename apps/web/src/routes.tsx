// Route table. Project-scoped routes live under /p/:projectId and share the
// ProjectLayout (opens the project, toolbar with undo/redo and save state).
// Pages are code-split; App renders them inside a Suspense boundary.

import { lazy } from "react";
import type { RouteObject } from "react-router";
import { ProjectLayout } from "./pages/project/ProjectLayout";

const AuditPage = lazy(() => import("./pages/audit/AuditPage").then((m) => ({ default: m.AuditPage })));
const BackupPage = lazy(() => import("./pages/backup/BackupPage").then((m) => ({ default: m.BackupPage })));
const CrossTenantCopyPage = lazy(() => import("./pages/copy/CrossTenantCopyPage").then((m) => ({ default: m.CrossTenantCopyPage })));
const LibraryPage = lazy(() => import("./pages/library/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const AspectTypesPage = lazy(() => import("./pages/project/aspect-types/AspectTypesPage").then((m) => ({ default: m.AspectTypesPage })));
const AssetTypesPage = lazy(() => import("./pages/project/asset-types/AssetTypesPage").then((m) => ({ default: m.AssetTypesPage })));
const DeployPage = lazy(() => import("./pages/project/deploy/DeployPage").then((m) => ({ default: m.DeployPage })));
const FilesPage = lazy(() => import("./pages/project/files/FilesPage").then((m) => ({ default: m.FilesPage })));
const HierarchyPage = lazy(() => import("./pages/project/hierarchy/HierarchyPage").then((m) => ({ default: m.HierarchyPage })));
const OverviewPage = lazy(() => import("./pages/project/overview/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const PortabilityPage = lazy(() => import("./pages/project/portability/PortabilityPage").then((m) => ({ default: m.PortabilityPage })));
const TenantModelPage = lazy(() => import("./pages/project/tenant/TenantModelPage").then((m) => ({ default: m.TenantModelPage })));
const VersionsPage = lazy(() => import("./pages/project/versions/VersionsPage").then((m) => ({ default: m.VersionsPage })));
const ProjectsPage = lazy(() => import("./pages/projects/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const SettingsPage = lazy(() => import("./pages/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const ConnectionsPage = lazy(() => import("./pages/tenants/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage })));
const TenantExplorerPage = lazy(() => import("./pages/tenants/TenantExplorerPage").then((m) => ({ default: m.TenantExplorerPage })));

export const routes: RouteObject[] = [
  { index: true, element: <ProjectsPage /> },
  { path: "library", element: <LibraryPage /> },
  { path: "settings", element: <SettingsPage /> },
  { path: "tenants", element: <ConnectionsPage /> },
  { path: "tenants/:connectionId", element: <TenantExplorerPage /> },
  { path: "copy", element: <CrossTenantCopyPage /> },
  { path: "backup", element: <BackupPage /> },
  { path: "audit", element: <AuditPage /> },
  {
    path: "p/:projectId",
    element: <ProjectLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "aspect-types", element: <AspectTypesPage /> },
      { path: "aspect-types/:uid", element: <AspectTypesPage /> },
      { path: "asset-types", element: <AssetTypesPage /> },
      { path: "asset-types/:uid", element: <AssetTypesPage /> },
      { path: "hierarchy", element: <HierarchyPage /> },
      { path: "hierarchy/:uid", element: <HierarchyPage /> },
      { path: "files", element: <FilesPage /> },
      { path: "versions", element: <VersionsPage /> },
      { path: "portability", element: <PortabilityPage /> },
      { path: "tenant", element: <TenantModelPage /> },
      { path: "deploy", element: <DeployPage /> },
    ],
  },
];
