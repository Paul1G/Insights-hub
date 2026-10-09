/**
 * @component PageHeader
 * @pattern page-header
 * @section navigation-layout
 * @description The copy-once, reusable page header. One props-driven block that
 * reproduces every page-header look used across the archetypes — an optional
 * breadcrumb row, the page title, an optional subtitle, an optional right-aligned
 * primary action, and an optional `meta` slot (used by monitoring pages for a
 * "last updated / refresh / auto-refresh" cluster). Copy this file (plus
 * PageHeader.module.css) into your app's components/ once, then render
 * <PageHeader … /> at the top of every route — every header is identical by
 * construction. It is self-contained: only @siemens/ix-react + @siemens/ix-icons.
 * @use-when You start a page/route and want a consistent title block (with optional
 * breadcrumb, subtitle, primary action, and a meta slot) without re-implementing
 * the header layout per route.
 * @ix-components IxBreadcrumb, IxBreadcrumbItem, IxButton, IxTypography
 */
import type { ReactNode } from "react";
import { IxBreadcrumb, IxBreadcrumbItem, IxButton, IxTypography } from "@siemens/ix-react";
import styles from "./PageHeader.module.css";

export type PageHeaderBreadcrumbItem = {
  /** Visible crumb label, e.g. "Teams". */
  label: string;
  /** Optional href; when set the crumb renders as an anchor. The last item is the current page and usually has no href. */
  href?: string;
  /** Optional @siemens/ix-icons icon constant shown before the label. */
  icon?: string;
};

export type PageHeaderAction = {
  /** Button label, e.g. "New team". */
  label: string;
  /** Optional @siemens/ix-icons icon constant for the leading icon. */
  icon?: string;
  /** Click handler. Use a real handler in your app (navigate / open dialog). */
  onClick?: () => void;
};

export type PageHeaderProps = {
  /** The page title. Wraps on long / German strings. */
  title: string;
  /**
   * Heading level the title renders as. A page header IS the page title, so
   * "h1" is the default and every route gets exactly one. Pass "h2" only when
   * the surrounding shell already owns the page's single h1 and this block
   * heads a section below it. The look is always the h1 type ramp — the level
   * is document structure, not size (conventions A1).
   */
  titleLevel?: "h1" | "h2";
  /** Optional one-line subtitle under the title, e.g. "5 members · 2 projects". */
  subtitle?: string;
  /** Optional breadcrumb trail shown above the title. The last item is the current page. */
  breadcrumb?: PageHeaderBreadcrumbItem[];
  /** Optional right-aligned primary action. */
  primaryAction?: PageHeaderAction;
  /**
   * Optional slot rendered in the right cluster, before the primary action.
   * Monitoring pages drop a "last updated / refresh / auto-refresh" group here.
   */
  meta?: ReactNode;
};

export function PageHeader({
  title,
  subtitle,
  titleLevel = "h1",
  breadcrumb,
  primaryAction,
  meta,
}: PageHeaderProps) {
  // A real heading element: IxTypography is pure typography (no role, no
  // semantics, no `as` prop), so a page title written with it leaves the route
  // without an h1 — and every page copied from this component inherits that
  // gap. The class keeps the look, the tag carries the outline (conventions A1).
  const Heading = titleLevel;
  return (
    <header className={styles.header}>
      {breadcrumb && breadcrumb.length > 0 ? (
        <IxBreadcrumb className={styles.breadcrumb}>
          {breadcrumb.map((crumb, index) => (
            <IxBreadcrumbItem
              key={crumb.label}
              // breadcrumbKey is required by IxBreadcrumbItem for item tracking.
              breadcrumbKey={crumb.label}
              label={crumb.label}
              icon={crumb.icon}
              // Last crumb is the current page: no link.
              href={index < breadcrumb.length - 1 ? crumb.href : undefined}
            />
          ))}
        </IxBreadcrumb>
      ) : null}

      <div className={styles.bar}>
        <div className={styles.titleZone}>
          <Heading className={`typography-h1 ${styles.title}`}>{title}</Heading>
          {subtitle ? (
            <IxTypography format="body-lg" textColor="soft" className={styles.subtitle}>
              {subtitle}
            </IxTypography>
          ) : null}
        </div>

        {meta || primaryAction ? (
          <div className={styles.actions}>
            {meta ? <div className={styles.meta}>{meta}</div> : null}
            {primaryAction ? (
              <IxButton variant="primary" icon={primaryAction.icon} onClick={primaryAction.onClick}>
                {primaryAction.label}
              </IxButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
