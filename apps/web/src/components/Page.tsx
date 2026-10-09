// Shared page layout primitives (tokens only, see foundations/spacing-scale).
// Every route renders its single <h1> through the shared PageHeader inside Page.

import type { ReactNode } from "react";
import styles from "./Page.module.css";

export function Page({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className={styles.page} aria-label={label}>
      {children}
    </div>
  );
}

/** A titled page section. `level` is the document outline level (A1), the look is h4. */
export function Section({
  title,
  level = "h2",
  actions,
  children,
}: {
  title?: string;
  level?: "h2" | "h3";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const Heading = level;
  return (
    <section className={styles.section}>
      {title || actions ? (
        <div className={styles.row} style={{ justifyContent: "space-between" }}>
          {title ? <Heading className={`typography-h4 ${styles.sectionTitle}`}>{title}</Heading> : <span />}
          {actions ? <div className={styles.row}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Row({ children, justify }: { children: ReactNode; justify?: "space-between" | "flex-end" }) {
  return (
    <div className={styles.row} style={justify ? { justifyContent: justify } : undefined}>
      {children}
    </div>
  );
}

export function Stack({ children }: { children: ReactNode }) {
  return <div className={styles.stack}>{children}</div>;
}
