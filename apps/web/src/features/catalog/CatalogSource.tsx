// Status of a tenant catalog (when it was read, what it contains) with a
// "Read from tenant" / "Refresh" action and live progress.

import { IxButton, IxMessageBar, IxSpinner, IxTypography } from "@siemens/ix-react";
import { iconCloudDownload, iconRefresh } from "@siemens/ix-icons/icons";
import type { ConnectionSummary } from "@/api/client";
import { catalogCounts } from "@/catalog/catalog";
import { notifyError, notifySuccess } from "@/components/notify";
import { useCatalogStore } from "@/state/catalogStore";
import styles from "./catalog.module.css";

export function CatalogSource({ connection }: { connection: ConnectionSummary }) {
  const catalog = useCatalogStore((s) => s.catalogs[connection.id]);
  const reading = useCatalogStore((s) => s.reading[connection.id]);
  const error = useCatalogStore((s) => s.errors[connection.id]);

  async function read() {
    try {
      const result = await useCatalogStore.getState().refresh(connection);
      const c = catalogCounts(result.record.snapshot);
      notifySuccess(`Read ${c.assetTypes} asset types, ${c.aspectTypes} aspect types and ${c.assets} assets from ${connection.name}.`);
    } catch (e) {
      notifyError(e, "Reading the tenant failed");
    }
  }

  const counts = catalog ? catalogCounts(catalog.record.snapshot) : undefined;
  const failures = catalog?.record.snapshot.partialFailures ?? [];
  return (
    <div className={styles.stack}>
      <div className={styles.statusPanel}>
        <div className={styles.stack}>
          {catalog && counts ? (
            <>
              <IxTypography format="body" className={styles.text}>
                {counts.assetTypes} asset types and {counts.aspectTypes} aspect types (plus {counts.coreAssetTypes} core asset types and{" "}
                {counts.coreAspectTypes} core aspect types) and {counts.assets.toLocaleString()} assets in tenant {catalog.record.tenant}.
              </IxTypography>
              <IxTypography format="body-sm" textColor="soft">
                Read {new Date(catalog.record.readAt).toLocaleString()} from {catalog.record.connectionName}. Stored locally, available offline.
              </IxTypography>
            </>
          ) : (
            <IxTypography format="body" textColor="soft">
              The tenant has not been read yet. Reading lists all aspect types, asset types and assets (pages of 200, read concurrently).
            </IxTypography>
          )}
          {reading ? (
            <div className={styles.row} role="status">
              <IxSpinner size="small" />
              <IxTypography format="body-sm">
                {reading.message} ({reading.counts.aspectTypes} aspect types, {reading.counts.assetTypes} asset types, {reading.counts.assets}{" "}
                assets so far)
              </IxTypography>
            </div>
          ) : null}
        </div>
        <IxButton
          variant={catalog ? "secondary" : "primary"}
          icon={catalog ? iconRefresh : iconCloudDownload}
          disabled={!!reading}
          onClick={() => void read()}
        >
          {catalog ? "Refresh from tenant" : "Read from tenant"}
        </IxButton>
      </div>
      {error ? (
        <IxMessageBar type="alarm" persistent>
          Reading the tenant failed: {error}
        </IxMessageBar>
      ) : null}
      {failures.length > 0 ? (
        <IxMessageBar type="warning" persistent>
          Incomplete read: {failures.length} page(s) failed ({failures.map((f) => `${f.resource} page ${f.page}: HTTP ${f.status}`).join("; ")}). Refresh to try again.
        </IxMessageBar>
      ) : null}
    </div>
  );
}
