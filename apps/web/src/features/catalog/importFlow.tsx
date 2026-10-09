// Preview → confirm → apply an import of existing tenant objects into a project.

import { IxTypography } from "@siemens/ix-react";
import { previewImport, runImport } from "@/catalog/importService";
import type { ImportPlan, ImportSelection } from "@/catalog/importToProject";
import { confirmDialog } from "@/components/dialogs";
import { notifyError, notifyInfo, notifySuccess } from "@/components/notify";
import type { TenantCatalogRecord } from "@/storage/db";
import styles from "./catalog.module.css";

const KIND_LABEL = { aspectType: "Aspect type", assetType: "Asset type", asset: "Asset" } as const;
const PREVIEW_ROWS = 60;

function PlanDetails({ plan }: { plan: ImportPlan }) {
  const imported = plan.items.filter((i) => i.status === "import");
  return (
    <div className={styles.stack}>
      <IxTypography format="body-sm">
        {plan.counts.aspectTypes} aspect type(s), {plan.counts.assetTypes} asset type(s) and {plan.counts.assets} asset(s) will be added.
        {plan.counts.alreadyInProject ? ` ${plan.counts.alreadyInProject} object(s) are already in the project and are reused.` : ""}
      </IxTypography>
      <ul className={styles.list}>
        {imported.slice(0, PREVIEW_ROWS).map((i) => (
          <li key={`${i.kind}:${i.tenantId}`}>
            <IxTypography format="body-sm" className={styles.text}>
              {KIND_LABEL[i.kind]} <strong>{i.name}</strong> — {i.reason}
            </IxTypography>
          </li>
        ))}
        {imported.length > PREVIEW_ROWS ? (
          <li>
            <IxTypography format="body-sm" textColor="soft">
              … and {imported.length - PREVIEW_ROWS} more.
            </IxTypography>
          </li>
        ) : null}
      </ul>
      {plan.warnings.map((w) => (
        <IxTypography key={w} format="body-sm" textColor="soft" className={styles.text}>
          {w}
        </IxTypography>
      ))}
      <IxTypography format="body-sm" textColor="soft">
        Imported objects keep their tenant ids: deploying the project to this tenant updates them instead of creating copies. Sync mode
        never deletes imported objects.
      </IxTypography>
    </div>
  );
}

/** Returns true when the import was applied. */
export async function importWithPreview(
  projectId: string,
  projectName: string,
  catalog: TenantCatalogRecord,
  selection: ImportSelection,
): Promise<boolean> {
  try {
    const plan = await previewImport(projectId, catalog, selection);
    const total = plan.counts.aspectTypes + plan.counts.assetTypes + plan.counts.assets;
    if (total === 0) {
      notifyInfo("Everything selected is already in the project.");
      return false;
    }
    const ok = await confirmDialog({
      title: `Import into “${projectName}”?`,
      message: `${total} existing object(s) from tenant ${catalog.tenant} will be added to the project as editable definitions.`,
      details: <PlanDetails plan={plan} />,
      confirmLabel: `Import ${total} object(s)`,
      size: "720",
    });
    if (!ok) return false;
    await runImport(projectId, catalog, plan);
    notifySuccess(`Imported ${total} object(s) from tenant ${catalog.tenant}.`);
    return true;
  } catch (e) {
    notifyError(e, "Import failed");
    return false;
  }
}
