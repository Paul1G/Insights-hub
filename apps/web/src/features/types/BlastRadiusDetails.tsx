// Impact analysis shown in destructive confirmations (delete / recreate a
// variable): affected asset types, assets carrying the variable and assets
// whose stored values are lost.

import { IxTypography } from "@siemens/ix-react";
import type { BlastRadius } from "@/domain/ops";
import styles from "./formDialog.module.css";

const MAX_LISTED = 12;

export function BlastRadiusDetails({ radius, valuesVerb = "lost" }: { radius: BlastRadius; valuesVerb?: string }) {
  const types = radius.assetTypes;
  return (
    <div className={styles.stack}>
      <IxTypography format="label">Impact</IxTypography>
      <ul className={styles.list}>
        <li>
          <IxTypography format="body-sm">
            {types.length} affected asset type{types.length === 1 ? "" : "s"}
            {types.length
              ? `: ${types
                  .slice(0, MAX_LISTED)
                  .map((t) => t.name || t.idSuffix)
                  .join(", ")}${types.length > MAX_LISTED ? ` and ${types.length - MAX_LISTED} more` : ""}`
              : ""}
          </IxTypography>
        </li>
        <li>
          <IxTypography format="body-sm">
            {radius.assets} asset{radius.assets === 1 ? "" : "s"} carry the variable
          </IxTypography>
        </li>
        <li>
          <IxTypography format="body-sm">
            {radius.assetsWithValues} asset{radius.assetsWithValues === 1 ? "" : "s"} with a stored value that will be {valuesVerb}
          </IxTypography>
        </li>
      </ul>
    </div>
  );
}
