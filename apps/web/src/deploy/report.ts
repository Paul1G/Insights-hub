// Run reports: summary + per-step timings, downloadable as JSON or Markdown.

import { PHASES, PHASE_LABELS, ENTITY_KIND_LABELS, type DeploymentRun, type RunReport, type StepStatus } from "./types";

export function buildReport(run: DeploymentRun): RunReport {
  const items = new Map(run.state.items.map((i) => [i.stepId, i]));
  const byStatus: Record<string, number> = {};
  const phases = new Map<string, { total: number; succeeded: number; failed: number; durationMs: number }>();
  const steps = run.plan.steps.map((s) => {
    const item = items.get(s.id);
    const status: StepStatus = item?.status ?? "pending";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const p = phases.get(s.phase) ?? { total: 0, succeeded: 0, failed: 0, durationMs: 0 };
    p.total++;
    if (status === "succeeded" || status === "skipped") p.succeeded++;
    if (status === "failed" || status === "conflict" || status === "skipped-dependency") p.failed++;
    p.durationMs += item?.durationMs ?? 0;
    phases.set(s.phase, p);
    return {
      stepId: s.id,
      phase: s.phase,
      op: s.op,
      entity: `${ENTITY_KIND_LABELS[s.entity.kind]} ${s.entity.label}`,
      status,
      attempts: item?.attempts ?? 0,
      ...(item?.httpStatus !== undefined ? { httpStatus: item.httpStatus } : {}),
      ...(item?.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      errors: [...(item?.errors ?? []), ...(item?.note ? [item.note] : [])],
    };
  });
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return {
    runId: run.id,
    mode: run.mode,
    status: run.status,
    projectName: run.plan.projectName,
    connectionName: run.connectionName,
    tenant: run.tenant,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    durationMs: Number.isFinite(started) ? Math.max(0, finished - started) : 0,
    plan: run.plan.summary,
    byStatus,
    byPhase: PHASES.filter((p) => phases.has(p)).map((p) => ({ phase: p, ...phases.get(p)! })),
    steps,
    warnings: [...run.state.warnings],
    notRevertible: run.plan.notRevertible ?? [],
  };
}

function ms(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function reportToMarkdown(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Deployment report — ${md(r.projectName)}`);
  lines.push("");
  lines.push(`- Run: \`${r.runId}\` (${r.mode})`);
  lines.push(`- Target: ${md(r.connectionName)} (tenant \`${r.tenant}\`)`);
  lines.push(`- Status: **${r.status}**`);
  if (r.startedAt) lines.push(`- Started: ${r.startedAt}`);
  if (r.finishedAt) lines.push(`- Finished: ${r.finishedAt}`);
  lines.push(`- Duration: ${ms(r.durationMs)}`);
  lines.push("");
  lines.push("## Plan");
  lines.push("");
  lines.push("| Create | Update | Skip | Delete | Move | Blocked |");
  lines.push("|---:|---:|---:|---:|---:|---:|");
  lines.push(`| ${r.plan.create} | ${r.plan.update} | ${r.plan.skip} | ${r.plan.delete} | ${r.plan.move} | ${r.plan.blocked} |`);
  lines.push("");
  lines.push("## Result by phase");
  lines.push("");
  lines.push("| Phase | Steps | Succeeded / skipped | Failed | Time |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const p of r.byPhase) lines.push(`| ${PHASE_LABELS[p.phase]} | ${p.total} | ${p.succeeded} | ${p.failed} | ${ms(p.durationMs)} |`);
  lines.push("");
  lines.push(`Status counts: ${Object.entries(r.byStatus).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  if (r.warnings.length) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of r.warnings) lines.push(`- ${md(w)}`);
  }
  if (r.notRevertible.length) {
    lines.push("");
    lines.push("## Not rolled back");
    lines.push("");
    for (const n of r.notRevertible) lines.push(`- ${md(n.label)}: ${md(n.reason)}`);
  }
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  lines.push("| Phase | Operation | Entity | Status | HTTP | Attempts | Time | Messages |");
  lines.push("|---|---|---|---|---:|---:|---:|---|");
  for (const s of r.steps) {
    lines.push(
      `| ${PHASE_LABELS[s.phase]} | ${s.op} | ${md(s.entity)} | ${s.status} | ${s.httpStatus ?? ""} | ${s.attempts} | ${ms(s.durationMs)} | ${md(s.errors.join("; "))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function reportToJson(r: RunReport): string {
  return JSON.stringify(r, null, 2);
}
