// Banner on the editor pages: how the project relates to its linked tenant
// (existing objects not yet in the project), or a hint to link one.

import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router";
import { IxButton, IxIcon, IxTypography } from "@siemens/ix-react";
import { iconCloudDownload, iconInfo } from "@siemens/ix-icons/icons";
import { correspondence } from "@/catalog/importToProject";
import { mappingId } from "@/deploy/mapping";
import { db } from "@/storage/db";
import { useLinkedCatalog } from "@/state/catalogStore";
import { useProject } from "@/state/hooks";
import styles from "./catalog.module.css";

export function LinkedTenantBanner({ focus }: { focus: "assets" | "assetTypes" | "aspectTypes" }) {
  const project = useProject();
  const navigate = useNavigate();
  const { connectionId, catalog } = useLinkedCatalog(project.id);
  const mapping = useLiveQuery(
    () => (connectionId ? db.mappings.get(mappingId(project.id, connectionId)) : undefined),
    [project.id, connectionId],
  );
  const missing = useMemo(() => {
    if (!catalog) return undefined;
    const s = catalog.record.snapshot;
    const m = correspondence(project, s, mapping);
    if (focus === "assets") return s.assets.filter((a) => !m.assets.has(a.assetId)).length;
    if (focus === "assetTypes") return s.assetTypes.tenant.filter((t) => !m.assetTypes.has(t.id.toLowerCase())).length;
    return s.aspectTypes.tenant.filter((t) => !m.aspectTypes.has(t.id.toLowerCase())).length;
  }, [catalog, project, mapping, focus]);

  const noun = focus === "assets" ? "asset(s)" : focus === "assetTypes" ? "asset type(s)" : "aspect type(s)";
  const text = !connectionId
    ? "This project is not linked to a tenant. Link it to see and use the tenant's existing types and assets."
    : !catalog
      ? "The linked tenant has not been read yet."
      : missing
        ? `Tenant ${catalog.record.tenant} has ${missing.toLocaleString()} existing ${noun} that are not in this project (read ${new Date(catalog.record.readAt).toLocaleString()}).`
        : `All existing ${noun} of tenant ${catalog.record.tenant} are in this project.`;
  return (
    <div className={styles.row} role="note">
      <IxIcon name={iconInfo} size="16" color="color-info" aria-hidden="true" />
      <IxTypography format="body-sm" textColor="soft" className={styles.text}>
        {text}
      </IxTypography>
      <IxButton variant="tertiary" icon={iconCloudDownload} onClick={() => navigate(`/p/${project.id}/tenant`)}>
        {!connectionId ? "Link tenant" : missing ? "Review & import" : "Tenant model"}
      </IxButton>
    </div>
  );
}
