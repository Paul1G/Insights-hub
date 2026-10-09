// Read-only variable table for inherited variables, aspect type variables
// shown inside an asset type, and core library types.

import { IxIcon, IxTypography } from "@siemens/ix-react";
import { iconLock } from "@siemens/ix-icons/icons";
import type { VariableLike } from "@/domain/resolve";
import styles from "./MasterDetail.module.css";

export interface ReadonlyVariableRow extends VariableLike {
  /** "inherited from X", "core", … */
  origin?: string;
}

export function ReadonlyVariables({
  variables,
  caption,
  showOrigin = false,
  showQualityCode = false,
  empty = "No variables.",
}: {
  variables: ReadonlyVariableRow[];
  caption: string;
  showOrigin?: boolean;
  showQualityCode?: boolean;
  empty?: string;
}) {
  if (variables.length === 0) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        {empty}
      </IxTypography>
    );
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">
              <IxTypography format="label-sm" textColor="soft">Name</IxTypography>
            </th>
            <th scope="col">
              <IxTypography format="label-sm" textColor="soft">Data type</IxTypography>
            </th>
            <th scope="col">
              <IxTypography format="label-sm" textColor="soft">Unit</IxTypography>
            </th>
            <th scope="col">
              <IxTypography format="label-sm" textColor="soft">Length</IxTypography>
            </th>
            <th scope="col">
              <IxTypography format="label-sm" textColor="soft">Searchable</IxTypography>
            </th>
            <th scope="col">
              <IxTypography format="label-sm" textColor="soft">Default</IxTypography>
            </th>
            {showQualityCode ? (
              <th scope="col">
                <IxTypography format="label-sm" textColor="soft">Quality code</IxTypography>
              </th>
            ) : null}
            {showOrigin ? (
              <th scope="col">
                <IxTypography format="label-sm" textColor="soft">Defined on</IxTypography>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {variables.map((v) => (
            <tr key={`${v.origin ?? ""}:${v.name}`}>
              <td>
                <span className={styles.inlineRow}>
                  <IxIcon name={iconLock} size="12" aria-label="Read-only" />
                  <IxTypography format="code-sm">{v.name}</IxTypography>
                </span>
              </td>
              <td>
                <IxTypography format="body-sm">{v.dataType}</IxTypography>
              </td>
              <td>
                <IxTypography format="body-sm">{v.unit || "—"}</IxTypography>
              </td>
              <td>
                <IxTypography format="body-sm">{v.length ?? "—"}</IxTypography>
              </td>
              <td>
                <IxTypography format="body-sm">{v.searchable ? "Yes" : "No"}</IxTypography>
              </td>
              <td>
                <IxTypography format="body-sm">{v.defaultValue ?? "—"}</IxTypography>
              </td>
              {showQualityCode ? (
                <td>
                  <IxTypography format="body-sm">{v.qualityCode ? "Yes" : "No"}</IxTypography>
                </td>
              ) : null}
              {showOrigin ? (
                <td>
                  <IxTypography format="body-sm" textColor="soft">
                    {v.origin ?? "—"}
                  </IxTypography>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
