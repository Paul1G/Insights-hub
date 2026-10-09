// Promise-based confirm / prompt dialogs on top of iX showModal, following
// interactive/confirm-dialog (destructive-confirm, typed-confirmation).

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  IxButton,
  IxInput,
  IxModalContent,
  IxModalFooter,
  IxModalHeader,
  IxTypography,
  Modal,
  showModal,
  type ModalRef,
} from "@siemens/ix-react";
import { iconInfo, iconWarning } from "@siemens/ix-icons/icons";
import styles from "./dialogs.module.css";

/**
 * iX 5.0 workaround (conventions A8): showModal's ariaLabelledby lands on the
 * ix-modal host, not on the inner <dialog>, so name the dialog directly.
 */
function nameDialog(host: unknown, name: string): void {
  const el = host as { shadowRoot?: ShadowRoot | null } | null;
  el?.shadowRoot?.querySelector("dialog")?.setAttribute("aria-label", name);
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Danger styling for destructive actions. */
  danger?: boolean;
  /** Require typing this exact text before the confirm button unlocks. */
  typedConfirmation?: string;
  /** Extra content (lists, impact analysis) under the message. */
  details?: ReactNode;
  size?: "360" | "480" | "600" | "720" | "840";
}

function ConfirmBody({
  opts,
  modal,
  settle,
}: {
  opts: ConfirmOptions;
  modal: { current: ModalRef | null };
  settle: (ok: boolean) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const unlocked = !opts.typedConfirmation || typed === opts.typedConfirmation;
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
        <div className={styles.body}>
          <IxTypography className={styles.message}>{opts.message}</IxTypography>
          {opts.details ? <div className={styles.details}>{opts.details}</div> : null}
          {opts.typedConfirmation ? (
            <IxInput
              label={`Type ${opts.typedConfirmation} to confirm`}
              value={typed}
              placeholder={opts.typedConfirmation}
              onValueChange={(e) => setTyped(e.detail)}
            />
          ) : null}
        </div>
      </IxModalContent>
      <IxModalFooter>
        <IxButton
          variant="secondary"
          onClick={() => {
            settle(false);
            modal.current?.dismiss("cancel");
          }}
        >
          {opts.cancelLabel ?? t("cancel")}
        </IxButton>
        <IxButton
          variant={opts.danger ? "danger-primary" : "primary"}
          disabled={!unlocked}
          onClick={() => {
            if (!unlocked) return;
            settle(true);
            modal.current?.close("confirmed");
          }}
        >
          {opts.confirmLabel}
        </IxButton>
      </IxModalFooter>
    </>
  );
}

/** Resolves true when the user confirms, false on cancel / Escape / close. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const modalRef: { current: ModalRef | null } = { current: null };
    void showModal({
      size: opts.size ?? (opts.details ? "600" : "480"),
      closeOnBackdropClick: false,
      content: (
        <Modal
          ref={(r) => {
            modalRef.current = r;
          }}
        >
          <ConfirmBody opts={opts} modal={modalRef} settle={settle} />
        </Modal>
      ),
    }).then((instance) => {
      nameDialog(instance.htmlElement, opts.title);
      instance.onDismiss.once(() => settle(false));
      instance.onClose.once(() => settle(true));
    });
  });
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  helper?: string;
  /** Return an error message to block confirmation. */
  validate?: (value: string) => string | undefined;
}

function PromptBody({
  opts,
  modal,
  settle,
}: {
  opts: PromptOptions;
  modal: { current: ModalRef | null };
  settle: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(opts.initial ?? "");
  const error = opts.validate?.(value);
  const submit = () => {
    if (error) return;
    settle(value);
    modal.current?.close("confirmed");
  };
  return (
    <>
      <IxModalHeader icon={iconInfo} iconColor="color-primary" ariaLabelIcon="Information">
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
          <IxInput
            label={opts.label}
            value={value}
            helperText={opts.helper}
            invalidText={error}
            className={error ? "ix-invalid" : undefined}
            onValueChange={(e) => setValue(e.detail)}
          />
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
          {t("cancel")}
        </IxButton>
        <IxButton variant="primary" disabled={!!error} onClick={submit}>
          {opts.confirmLabel ?? t("ok")}
        </IxButton>
      </IxModalFooter>
    </>
  );
}

/** Resolves the entered text, or null when cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const modalRef: { current: ModalRef | null } = { current: null };
    void showModal({
      size: "480",
      closeOnBackdropClick: false,
      content: (
        <Modal
          ref={(r) => {
            modalRef.current = r;
          }}
        >
          <PromptBody opts={opts} modal={modalRef} settle={settle} />
        </Modal>
      ),
    }).then((instance) => {
      nameDialog(instance.htmlElement, opts.title);
      instance.onDismiss.once(() => settle(null));
    });
  });
}
