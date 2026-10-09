// Display labels shared by the deployment UI.

import type { AuthMode } from "@/api/client";
import type { RunStatus, StepOp, StepStatus } from "@/deploy/types";

export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  client_credentials: "Service credentials (OAuth client credentials)",
  app_credentials: "Application credentials (Token Management Service)",
  bearer: "Pasted bearer token",
  simulator: "Simulator",
};

export const OP_LABELS: Record<StepOp, string> = {
  create: "New",
  upload: "Upload",
  update: "Update",
  location: "Location",
  assign: "Assign files",
  unassign: "Unassign files",
  move: "Move",
  delete: "Deletion",
  skip: "Unchanged",
};

export const STATUS_LABELS: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  conflict: "Conflict",
  skipped: "Skipped",
  "skipped-dependency": "Skipped (dependency)",
  "rolled-back": "Rolled back",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  planned: "Planned",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  "completed-with-errors": "Completed with errors",
  failed: "Failed",
  "rolled-back": "Rolled back",
  cancelled: "Cancelled",
};
