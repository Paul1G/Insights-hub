/**
 * @component DashboardPanel
 * @pattern dashboard
 * @section page-archetypes
 * @description The copy-once panel wrapper for a {@link DashboardGrid}. One
 * IxCard with a uniform header (title + optional right-side slot for a
 * "View all →" link / refresh button) and a free body slot that takes any
 * content — a KPI row, a chart, a table preview, an event feed. It owns the
 * grid-cell width via the `span` prop (span-1 / span-2 / full) and obeys the
 * Layout Contract §10: the card is width:100% + height:100% so it fills the
 * stretched cell and a row of panels stays equal-height. Copy this file (plus
 * DashboardPanel.module.css) and DashboardGrid into your app's components/ once.
 * @use-when You need a titled surface inside a dashboard grid and want every
 * panel to share one header layout, span behaviour, and equal-height rule
 * instead of hand-building each card.
 * @ix-components IxCard, IxCardContent
 */
import type { ReactNode } from "react";
import { IxCard, IxCardContent } from "@siemens/ix-react";
import styles from "./DashboardPanel.module.css";

export type DashboardPanelProps = {
  /** Panel heading, e.g. "CPU & memory" or "Recent deployments". */
  title: string;
  /**
   * Track width inside the 12-column DashboardGrid:
   * - "span-1" → a quarter on wide screens (3 of 12),
   * - "span-2" → a half (6 of 12),
   * - "full"   → the whole row (12 of 12).
   * Defaults to "span-2".
   */
  span?: "span-1" | "span-2" | "full";
  /**
   * Heading level the panel title renders as. Every panel is a section of the
   * dashboard page, so "h2" (under the page's single h1) is the default; pass
   * "h3" when panels sit inside an already-nested section. The look is always
   * the h4 type ramp — the level is document structure, not size.
   */
  titleLevel?: "h2" | "h3" | "h4";
  /** Optional right-aligned header element — a "View all →" link, a refresh button, a status chip. */
  action?: ReactNode;
  /** The panel body — any content. */
  children: ReactNode;
};

const SPAN_CLASS: Record<NonNullable<DashboardPanelProps["span"]>, string> = {
  "span-1": styles.span1,
  "span-2": styles.span2,
  full: styles.full,
};

export function DashboardPanel({
  title,
  span = "span-2",
  titleLevel = "h2",
  action,
  children,
}: DashboardPanelProps) {
  // A real heading element: IxTypography is pure typography (no role, no
  // semantics), so a panel title written with it is invisible to the heading
  // navigation every screen-reader user relies on to scan a dashboard.
  const Heading = titleLevel;
  return (
    <div className={`${styles.cell} ${SPAN_CLASS[span]}`}>
      <IxCard variant="outline" className={styles.card}>
        <IxCardContent>
          <div className={styles.stack}>
            <header className={styles.head}>
              <Heading className={`typography-h4 ${styles.title}`}>{title}</Heading>
              {action ? <div className={styles.action}>{action}</div> : null}
            </header>
            <div className={styles.body}>{children}</div>
          </div>
        </IxCardContent>
      </IxCard>
    </div>
  );
}
