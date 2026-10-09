// Header action cluster of the Projects page. Further entry points (e.g.
// "Import project", "Backup from tenant") are added as children; they render
// before the primary "Create project" button.

import type { ReactNode } from "react";
import { IxButton } from "@siemens/ix-react";
import { iconAdd } from "@siemens/ix-icons/icons";
import styles from "./ProjectsPage.module.css";

export function ProjectsHeaderActions({ onCreate, children }: { onCreate: () => void; children?: ReactNode }) {
  return (
    <div className={styles.headerActions}>
      {children}
      <IxButton variant="primary" icon={iconAdd} onClick={onCreate}>
        Create project
      </IxButton>
    </div>
  );
}
