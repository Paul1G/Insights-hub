// Shared building blocks for the tenant explorer: dialog host, banners,
// loading state, key/value grid, impact rendering, ETag conflict dialog.

import { useState, type ReactNode } from "react";
import {
  IxButton,
  IxMessageBar,
  IxModalContent,
  IxModalFooter,
  IxModalHeader,
  IxSpinner,
  IxTypography,
  Modal,
  showModal,
  type ModalRef,
} from "@siemens/ix-react";
import { iconInfo, iconWarning } from "@siemens/ix-icons/icons";
import type { ListResult } from "@/api/client";
import { confirmDialog } from "@/components/dialogs";
import { DiffView } from "@/components/DiffView";
import { notifyError, notifyInfo } from "@/components/notify";
import { describeError, errorText } from "@/online/errors";
import { updateWithEtag, type Conflict, type ConflictDecision, type EditSession, type Etag, type ResolvedResult } from "@/online/etag";
import type { Impact } from "@/online/impact";
import { defaultTransport } from "@/online/transport";
import styles from "./explorer.module.css";

// ---------------------------------------------------------------------------
// Dialog host
// ---------------------------------------------------------------------------

export type DialogSize = "360" | "480" | "600" | "720" | "840" | "full-width";

export interface DialogControl<T> {
  /** Resolve with a result and close. */
  close(result: T): void;
  /** Resolve with undefined and close. */
  dismiss(): void;
  /** While busy, Escape / the header close button cannot dismiss the dialog. */
  setBusy(busy: boolean): void;
}

/**
 * iX 5.0 workaround (conventions A8): showModal's ariaLabelledby lands on the
 * ix-modal host, not on the inner <dialog>, so name the dialog directly.
 */
function nameDialog(host: unknown, name: string): void {
  const el = host as { shadowRoot?: ShadowRoot | null } | null;
  el?.shadowRoot?.querySelector("dialog")?.setAttribute("aria-label", name);
}

/** Open a custom modal; resolves with the closing result (undefined when dismissed). */
export function openDialog<T>(opts: {
  title: string;
  size?: DialogSize;
  content: (ctl: DialogControl<T>) => ReactNode;
}): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    const settle = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const ref: { current: ModalRef | null } = { current: null };
    const ctl: DialogControl<T> = {
      close: (result) => {
        busy = false;
        settle(result);
        ref.current?.close(result);
      },
      dismiss: () => {
        busy = false;
        settle(undefined);
        ref.current?.dismiss("cancel");
      },
      setBusy: (b) => {
        busy = b;
      },
    };
    void showModal({
      size: opts.size ?? "600",
      closeOnBackdropClick: false,
      beforeDismiss: () => !busy,
      content: (
        <Modal
          ref={(r) => {
            ref.current = r;
          }}
        >
          {opts.content(ctl)}
        </Modal>
      ),
    }).then((instance) => {
      nameDialog(instance.htmlElement, opts.title);
      instance.onDismiss.once(() => settle(undefined));
    });
  });
}

/** Header (real <h2>, A1) + content + footer for custom dialogs. */
export function DialogFrame({
  title,
  danger,
  busy,
  children,
  footer,
}: {
  title: string;
  danger?: boolean;
  busy?: boolean;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <>
      <IxModalHeader
        icon={danger ? iconWarning : iconInfo}
        iconColor={danger ? "color-alarm" : "color-primary"}
        ariaLabelIcon={danger ? "Warning" : "Information"}
        hideClose={busy}
      >
        <h2 className={`typography-h5 ${styles.dialogTitle}`}>{title}</h2>
      </IxModalHeader>
      <IxModalContent>
        <div className={styles.dialogBody} aria-busy={busy ? "true" : "false"}>
          {children}
        </div>
      </IxModalContent>
      <IxModalFooter>{footer}</IxModalFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Banners and states
// ---------------------------------------------------------------------------

export function ErrorBanner({ error, prefix }: { error: unknown; prefix?: string }) {
  if (!error) return null;
  const info = describeError(error);
  return (
    <IxMessageBar type={info.offline ? "warning" : "alarm"} persistent>
      <div className={styles.tightStack}>
        <IxTypography format="body" bold>
          {prefix ? `${prefix}: ${info.title}` : info.title}
        </IxTypography>
        {info.messages.map((m) => (
          <IxTypography key={m} format="body-sm">
            {m}
          </IxTypography>
        ))}
        {info.hint ? (
          <IxTypography format="body-sm" textColor="soft">
            {info.hint}
          </IxTypography>
        ) : null}
      </div>
    </IxMessageBar>
  );
}

export function PartialFailureBanner({ result, what }: { result: ListResult<unknown> | null; what: string }) {
  if (!result || result.partialFailures.length === 0) return null;
  const pages = result.partialFailures;
  return (
    <IxMessageBar type="warning" persistent>
      <div className={styles.tightStack}>
        <IxTypography format="body" bold>
          The {what} list is incomplete: {pages.length} of {result.totalPages} page{result.totalPages === 1 ? "" : "s"} failed after retries.
        </IxTypography>
        {pages.slice(0, 5).map((p) => (
          <IxTypography key={p.page} format="body-sm">
            Page {p.page + 1}: HTTP {p.status} — {p.message}
          </IxTypography>
        ))}
        <IxTypography format="body-sm" textColor="soft">
          Showing {result.items.length} of {result.totalElements}. Refresh to try again.
        </IxTypography>
      </div>
    </IxMessageBar>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className={styles.loading}>
      <IxSpinner size="small" />
      <IxTypography format="body-sm" textColor="soft">
        {label}
      </IxTypography>
    </div>
  );
}

export function KeyValueGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className={styles.fieldGrid}>
      {items.map((it) => (
        <div key={it.label} className={styles.field}>
          <IxTypography format="label-sm" textColor="soft">
            {it.label}
          </IxTypography>
          {typeof it.value === "string" || typeof it.value === "number" ? (
            <IxTypography format="body">{it.value === "" ? "—" : it.value}</IxTypography>
          ) : (
            it.value
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

export function ImpactView({ impact }: { impact: Impact }) {
  return (
    <div className={styles.stack}>
      {impact.reasons.length ? (
        <IxMessageBar type={impact.blocked ? "alarm" : "warning"} persistent>
          <div className={styles.tightStack}>
            {impact.reasons.map((r) => (
              <IxTypography key={r} format="body-sm">
                {r}
              </IxTypography>
            ))}
          </div>
        </IxMessageBar>
      ) : null}
      {impact.groups.map((g) => (
        <section key={g.title} className={styles.tightStack} aria-label={g.title}>
          <IxTypography format="label" bold>
            {g.title}: {g.total}
            {g.incomplete ? " (count may be incomplete)" : ""}
          </IxTypography>
          {g.items.length ? (
            <ul className={styles.list}>
              {g.items.map((it) => (
                <li key={it.id} className={styles.listItem}>
                  <IxTypography format="body-sm">{it.label}</IxTypography>
                  {it.detail ? (
                    <IxTypography format="body-xs" textColor="soft">
                      {it.detail}
                    </IxTypography>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {g.total > g.items.length ? (
            <IxTypography format="body-xs" textColor="soft">
              …and {g.total - g.items.length} more.
            </IxTypography>
          ) : null}
        </section>
      ))}
      {!impact.reasons.length && !impact.groups.length ? (
        <IxTypography format="body-sm" textColor="soft">
          No dependent objects found.
        </IxTypography>
      ) : null}
    </div>
  );
}

/** Danger confirm with the impact analysis; blocked impacts can only be acknowledged. */
export async function confirmWithImpact(opts: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  impact: Impact;
}): Promise<boolean> {
  if (opts.impact.blocked) {
    await confirmDialog({
      title: opts.title,
      message: "This operation is blocked:",
      confirmLabel: "Understood",
      cancelLabel: "Back",
      danger: true,
      details: <ImpactView impact={opts.impact} />,
    });
    return false;
  }
  return confirmDialog({
    title: opts.title,
    message: opts.message,
    confirmLabel: opts.confirmLabel,
    danger: true,
    details: <ImpactView impact={opts.impact} />,
  });
}

// ---------------------------------------------------------------------------
// ETag conflicts
// ---------------------------------------------------------------------------

function ConflictBody<R>({
  conflict,
  what,
  ctl,
}: {
  conflict: Conflict<R>;
  what: string;
  ctl: DialogControl<ConflictDecision>;
}) {
  return (
    <DialogFrame
      title="Changed on the server"
      danger
      footer={
        <>
          <IxButton variant="secondary" onClick={() => ctl.close("discard")}>
            Discard my changes
          </IxButton>
          <IxButton variant="primary" onClick={() => ctl.close("overwrite")}>
            Overwrite with my changes
          </IxButton>
        </>
      }
    >
      <IxTypography>
        {what} was modified by someone else since you loaded it (current ETag {String(conflict.serverEtag)}). Insights Hub rejected
        the request with HTTP 412.
      </IxTypography>
      {conflict.completedSteps.length ? (
        <IxTypography format="body-sm" textColor="soft">
          Already applied before the conflict: {conflict.completedSteps.join(", ")}.
        </IxTypography>
      ) : null}
      <IxTypography format="body-sm" textColor="soft">
        “Overwrite” re-applies your changes on top of the current server version.
      </IxTypography>
      <DiffView
        changes={conflict.changes}
        beforeLabel="Server (current)"
        afterLabel="Your edit"
        empty="The server version already matches your edit."
      />
    </DialogFrame>
  );
}

export async function openConflictDialog<R>(conflict: Conflict<R>, what: string): Promise<ConflictDecision> {
  const res = await openDialog<ConflictDecision>({
    title: "Changed on the server",
    size: "840",
    content: (ctl) => <ConflictBody conflict={conflict} what={what} ctl={ctl} />,
  });
  return res ?? "discard";
}

/** Execute an edit session with interactive 412 handling (conflict dialog with DiffView). */
export async function runEdit<R>(
  connectionId: string,
  session: EditSession<R>,
  start: { resource: R; etag: Etag },
  what: string,
): Promise<ResolvedResult<R>> {
  const res = await updateWithEtag(defaultTransport, connectionId, session, start, (c) => openConflictDialog(c, what));
  if (res.kind === "discarded") notifyInfo(`Your changes to ${what} were discarded; the server version was kept.`);
  return res;
}

/** Small busy-state helper for dialog submit buttons. */
export function useBusy(ctl: { setBusy(b: boolean): void }) {
  const [busy, setBusyState] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusyState(true);
    ctl.setBusy(true);
    try {
      return await fn();
    } finally {
      setBusyState(false);
      ctl.setBusy(false);
    }
  };
  return { busy, run };
}

/** Error toast with the upstream message and the actionable hint (e.g. roles for 401/403). */
export function notifyFailure(e: unknown, prefix?: string): void {
  const hint = describeError(e).hint;
  notifyError(hint ? `${errorText(e)} — ${hint}` : errorText(e), prefix);
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
