// Promise-based form dialog on top of iX showModal (same structure as the
// shared confirm/prompt dialogs in components/dialogs.tsx). The body is a
// render function over a local form state; the promise resolves with the
// final value, or null when cancelled.
//
// Dialog content renders outside the router: never use router hooks in
// `render` — navigate after the promise resolves.

import { useState, type ReactNode } from "react";
import i18next from "i18next";
import {
  IxButton,
  IxModalContent,
  IxModalFooter,
  IxModalHeader,
  IxTypography,
  Modal,
  showModal,
  type ModalRef,
} from "@siemens/ix-react";
import { iconInfo, iconWarning } from "@siemens/ix-icons/icons";
import styles from "./formDialog.module.css";

/**
 * iX 5.0 workaround (conventions A8): showModal's ariaLabelledby lands on the
 * ix-modal host, not on the inner <dialog>, so name the dialog directly.
 */
function nameDialog(host: unknown, name: string): void {
  const el = host as { shadowRoot?: ShadowRoot | null } | null;
  el?.shadowRoot?.querySelector("dialog")?.setAttribute("aria-label", name);
}

export interface FormDialogOptions<T extends object> {
  title: string;
  initial: T;
  confirmLabel: string;
  cancelLabel?: string;
  /** Danger styling for destructive confirmations. */
  danger?: boolean;
  size?: "360" | "480" | "600" | "720" | "840";
  /** Render the form body from the current value. Must not call hooks. */
  render: (value: T, patch: (changes: Partial<T>) => void) => ReactNode;
  /** Return a message to block confirmation (shown under the form). */
  validate?: (value: T) => string | undefined;
}

function FormBody<T extends object>({
  opts,
  modal,
  settle,
}: {
  opts: FormDialogOptions<T>;
  modal: { current: ModalRef | null };
  settle: (v: T | null) => void;
}) {
  const [value, setValue] = useState<T>(opts.initial);
  const patch = (changes: Partial<T>) => setValue((prev) => ({ ...prev, ...changes }));
  const error = opts.validate?.(value);
  const submit = () => {
    if (error) return;
    settle(value);
    modal.current?.close("confirmed");
  };
  return (
    <>
      <IxModalHeader
        icon={opts.danger ? iconWarning : iconInfo}
        iconColor={opts.danger ? "color-alarm" : "color-primary"}
        ariaLabelIcon={opts.danger ? "Warning" : "Information"}
      >
        <h2 className={`typography-h5 ${styles.title}`}>{opts.title}</h2>
      </IxModalHeader>
      <IxModalContent>
        <form
          className={styles.body}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {opts.render(value, patch)}
          {error ? (
            <IxTypography format="body-sm" textColor="soft" className={styles.blocker}>
              {error}
            </IxTypography>
          ) : null}
        </form>
      </IxModalContent>
      <IxModalFooter>
        <IxButton
          variant="secondary"
          onClick={() => {
            settle(null);
            modal.current?.dismiss("cancel");
          }}
        >
          {opts.cancelLabel ?? i18next.t("dialog-cancel", { defaultValue: "Cancel" })}
        </IxButton>
        <IxButton variant={opts.danger ? "danger-primary" : "primary"} disabled={!!error} onClick={submit}>
          {opts.confirmLabel}
        </IxButton>
      </IxModalFooter>
    </>
  );
}

export function formDialog<T extends object>(opts: FormDialogOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: T | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const modalRef: { current: ModalRef | null } = { current: null };
    void showModal({
      size: opts.size ?? "480",
      closeOnBackdropClick: false,
      content: (
        <Modal
          ref={(r) => {
            modalRef.current = r;
          }}
        >
          <FormBody opts={opts} modal={modalRef} settle={settle} />
        </Modal>
      ),
    }).then((instance) => {
      nameDialog(instance.htmlElement, opts.title);
      instance.onDismiss.once(() => settle(null));
    });
  });
}

