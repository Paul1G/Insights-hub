// Opens the step details dialog (iX showModal).

import { Modal, showModal, type ModalRef } from "@siemens/ix-react";
import type { DeploymentPlan, PlanStep, StepRun } from "@/deploy/types";
import { StepDetailsBody } from "./StepDetailsBody";

/**
 * iX 5.0 workaround (conventions A8): showModal's ariaLabelledby lands on the
 * ix-modal host, not on the inner <dialog>, so the dialog is named directly.
 */
function nameDialog(host: unknown, name: string): void {
  const el = host as { shadowRoot?: ShadowRoot | null } | null;
  el?.shadowRoot?.querySelector("dialog")?.setAttribute("aria-label", name);
}

export function openStepDetails(input: { step: PlanStep; plan: DeploymentPlan; item?: StepRun; onRetry?: () => void; onSkip?: () => void }): void {
  const modalRef: { current: ModalRef | null } = { current: null };
  const title = `Step details: ${input.step.entity.label}`;
  void showModal({
    size: "840",
    closeOnBackdropClick: true,
    content: (
      <Modal
        ref={(r) => {
          modalRef.current = r;
        }}
      >
        <StepDetailsBody {...input} item={input.item ? structuredClone(input.item) : undefined} modal={modalRef} />
      </Modal>
    ),
  }).then((instance) => nameDialog(instance.htmlElement, title));
}
