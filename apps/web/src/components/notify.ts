// Toast helpers (feedback/toast). Error messages are taken from the thrown
// value; DomainError / UpstreamError / ApiError messages are user-facing.

import { showToast } from "@siemens/ix-react";

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function notifySuccess(message: string): void {
  void showToast({ type: "success", message });
}

export function notifyInfo(message: string): void {
  void showToast({ type: "info", message });
}

export function notifyError(e: unknown, prefix?: string): void {
  const msg = errorMessage(e);
  void showToast({ type: "error", message: prefix ? `${prefix}: ${msg}` : msg });
}
