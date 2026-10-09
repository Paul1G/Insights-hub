// Master/detail layout for the type editors and the library browser:
// a searchable list on the left (stacks above the detail on narrow screens)
// and a detail pane with a sticky header carrying the entity name and its
// issue counts.

import type { CSSProperties, ReactNode } from "react";
import { IxIcon, IxInput, IxTypography } from "@siemens/ix-react";
import { iconSearch } from "@siemens/ix-icons/icons";
import styles from "./MasterDetail.module.css";

export function MasterDetail({ master, detail }: { master: ReactNode; detail: ReactNode }) {
  return (
    <div className={styles.layout}>
      <div className={styles.master}>{master}</div>
      <div className={styles.detail}>{detail}</div>
    </div>
  );
}

export function MasterList({
  title,
  searchLabel,
  query,
  onQuery,
  filters,
  status,
  children,
}: {
  title: string;
  searchLabel: string;
  query: string;
  onQuery: (q: string) => void;
  /** Extra narrowing controls next to the search field. */
  filters?: ReactNode;
  /** Short result summary, announced politely (e.g. "3 of 12 shown"). */
  status: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.listPanel} aria-label={title}>
      <h2 className={`typography-h5 ${styles.listTitle}`}>{title}</h2>
      <search aria-label={`${title} search`} className={styles.search}>
        <IxInput label={searchLabel} value={query} onValueChange={(e) => onQuery(e.detail)}>
          <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
        </IxInput>
        {filters}
      </search>
      <IxTypography format="body-xs" textColor="soft" role="status">
        {status}
      </IxTypography>
      <ul className={styles.list}>{children}</ul>
    </section>
  );
}

export function MasterItem({
  selected,
  onSelect,
  level = 0,
  primary,
  secondary,
  trailing,
  muted = false,
}: {
  selected: boolean;
  onSelect: () => void;
  level?: number;
  primary: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  /** Context rows (e.g. ancestors kept by a search filter). */
  muted?: boolean;
}) {
  const style = { "--md-level": level } as CSSProperties;
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={`${styles.itemButton} ${selected ? styles.selected : ""} ${muted ? styles.muted : ""}`}
        style={style}
        aria-current={selected ? "true" : "false"}
        onClick={onSelect}
      >
        <span className={styles.itemText}>
          <IxTypography format="label" className={styles.itemPrimary}>
            {primary}
          </IxTypography>
          {secondary ? (
            <IxTypography format="body-xs" textColor="soft" className={styles.itemSecondary}>
              {secondary}
            </IxTypography>
          ) : null}
        </span>
        {trailing ? <span className={styles.itemTrailing}>{trailing}</span> : null}
      </button>
    </li>
  );
}

export function DetailHeader({
  title,
  subtitle,
  badges,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.detailHeader}>
      <div className={styles.detailTitleZone}>
        <div className={styles.detailTitleRow}>
          <h2 className={`typography-h3 ${styles.detailTitle}`}>{title}</h2>
          {badges ? <span className={styles.badges}>{badges}</span> : null}
        </div>
        {subtitle ? (
          <IxTypography format="body-sm" textColor="soft" className={styles.detailSubtitle}>
            {subtitle}
          </IxTypography>
        ) : null}
      </div>
      {actions ? <div className={styles.detailActions}>{actions}</div> : null}
    </div>
  );
}

/** Card-like detail section with an h3 title (A1: h2 is the detail header). */
export function DetailSection({
  title,
  description,
  actions,
  children,
  readOnly = false,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Visually marks inherited / core content as not editable. */
  readOnly?: boolean;
}) {
  return (
    <section className={`${styles.section} ${readOnly ? styles.readOnly : ""}`}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitleZone}>
          <h3 className={`typography-h5 ${styles.sectionTitle}`}>{title}</h3>
          {description ? (
            <IxTypography format="body-sm" textColor="soft" className={styles.sectionDescription}>
              {description}
            </IxTypography>
          ) : null}
        </div>
        {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

