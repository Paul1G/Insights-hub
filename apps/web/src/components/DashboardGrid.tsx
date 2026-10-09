/**
 * @component DashboardGrid
 * @pattern dashboard
 * @section page-archetypes
 * @description The copy-once responsive panel grid for a dashboard route. A CSS
 * grid of 12 implicit columns into which children claim a width via the
 * {@link DashboardPanel} `span` prop (span-1 / span-2 / full). Gaps are
 * --theme-space tokens and every track is `minmax(0, 1fr)` so panels shrink
 * instead of clipping; the grid stretches each cell so a row of panels stays
 * equal-height (Layout Contract §10 rule 8). Copy this file (plus
 * DashboardGrid.module.css) and DashboardPanel into your app's components/
 * once, then arrange any number of panels by composition.
 * @use-when You are laying out a monitoring/overview route as N panels of mixed
 * width (a KPI row, a chart, a table preview, an event feed) and want them to
 * reflow responsively and stay equal-height without per-page grid CSS.
 * @ix-components — (layout primitive; renders a styled div, no iX component)
 */
import type { ReactNode } from "react";
import styles from "./DashboardGrid.module.css";

export type DashboardGridProps = {
  /** The panels (usually {@link DashboardPanel}s) to lay out. */
  children: ReactNode;
};

/**
 * Responsive 12-column dashboard grid. Children set their own width via the
 * panel's `span` prop; this component only owns the track sizing, the token
 * gap, and equal-height stretch.
 */
export function DashboardGrid({ children }: DashboardGridProps) {
  return <div className={styles.grid}>{children}</div>;
}
