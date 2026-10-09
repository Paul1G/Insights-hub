// Opens a custom iX modal whose body is a React component receiving a
// `close` callback (interactive/confirm-dialog pattern, custom content).

import type { ReactNode } from "react";
import { Modal, showModal, type ModalRef } from "@siemens/ix-react";

export type ModalSize = "360" | "480" | "600" | "720" | "840" | "full-width";

/**
 * iX 5.0 workaround (conventions A8): showModal's ariaLabelledby lands on the
 * ix-modal host, not on the inner <dialog>, so name the dialog directly.
 */
function nameDialog(host: unknown, name: string): void {
  const el = host as { shadowRoot?: ShadowRoot | null } | null;
  el?.shadowRoot?.querySelector("dialog")?.setAttribute("aria-label", name);
}

export function openModal(opts: { title: string; size?: ModalSize; render: (close: () => void) => ReactNode }): void {
  const ref: { current: ModalRef | null } = { current: null };
  const close = () => ref.current?.dismiss("done");
  void showModal({
    size: opts.size ?? "600",
    closeOnBackdropClick: false,
    content: (
      <Modal
        ref={(r) => {
          ref.current = r;
        }}
      >
        {opts.render(close)}
      </Modal>
    ),
  }).then((instance) => nameDialog(instance.htmlElement, opts.title));
}
