// Step details dialog: request previews (method, path, conditional headers,
// body JSON), the diff against the target and — in a run — the execution
// record with conflict resolution (retry with the fresh ETag or skip).

import { useState } from "react";
import {
  IxButton,
  IxKeyValue,
  IxKeyValueList,
  IxMessageBar,
  IxModalContent,
  IxModalFooter,
  IxModalHeader,
  IxTypography,
  type ModalRef,
} from "@siemens/ix-react";
import { iconInfo } from "@siemens/ix-icons/icons";
import { DiffView } from "@/components/DiffView";
import { ENTITY_KIND_LABELS, PHASE_LABELS, type DeploymentPlan, type PlanStep, type PlannedRequest, type StepRun } from "@/deploy/types";
import { OpChip, StatusChip } from "./chips";
import { OP_LABELS } from "./labels";
import styles from "./deploy.module.css";


const TOKEN = /\{\{(asset|file):([^}]+)\}\}/g;

/** Readable labels for `{{asset:<uid>}}` tokens: the object created earlier in the run. */
function tokenLabels(plan: DeploymentPlan): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of plan.steps) if (s.createsToken) out.set(s.createsToken, `${s.entity.kind === "file" ? "file" : "asset"} “${s.entity.label}” (created in this run)`);
  return out;
}

function prettify(text: string, labels: Map<string, string>): string {
  return text.replace(TOKEN, (_m, kind: string, uid: string) => `<id of ${labels.get(`${kind}:${uid}`) ?? `${kind} ${uid}`}>`);
}

function RequestPreview({ req, index, total, labels, freshEtag }: { req: PlannedRequest; index: number; total: number; labels: Map<string, string>; freshEtag: boolean }) {
  const headers: string[] = [];
  if (req.ifMatch !== undefined) headers.push(`If-Match: ${freshEtag ? `<fresh ETag read right before the step> (plan time: ${String(req.ifMatch)})` : String(req.ifMatch)}`);
  if (req.ifNoneMatch !== undefined) headers.push(`If-None-Match: ${req.ifNoneMatch}`);
  if (req.transport === "upload" || req.transport === "replace") headers.push("Content-Type: multipart/form-data (fields file, name, scope, description)");
  else if (req.contentType) headers.push(`Content-Type: ${req.contentType}`);
  const body = req.body === undefined ? undefined : prettify(JSON.stringify(req.body, null, 2), labels);
  return (
    <li className={styles.tightStack}>
      <IxTypography format="label-sm" textColor="soft">
        Request {index + 1} of {total}
        {req.purpose ? ` — ${req.purpose}` : ""}
      </IxTypography>
      <IxTypography format="code" className={styles.code}>
        {req.method} {prettify(req.path, labels)}
      </IxTypography>
      {headers.map((h) => (
        <IxTypography key={h} format="code-sm" className={styles.code}>
          {h}
        </IxTypography>
      ))}
      {body !== undefined ? (
        <pre className={styles.pre}>
          <IxTypography format="code-sm">{body}</IxTypography>
        </pre>
      ) : null}
    </li>
  );
}

export function StepDetailsBody({
  step,
  plan,
  item,
  onRetry,
  onSkip,
  modal,
}: {
  step: PlanStep;
  plan: DeploymentPlan;
  item?: StepRun;
  onRetry?: () => void;
  onSkip?: () => void;
  modal: { current: ModalRef | null };
}) {
  const [acted, setActed] = useState(false);
  const labels = tokenLabels(plan);
  const deps = step.dependsOn.map((d) => plan.steps.find((s) => s.id === d)).filter((s): s is PlanStep => !!s);
  const title = `${OP_LABELS[step.op]} · ${ENTITY_KIND_LABELS[step.entity.kind]} “${step.entity.label}”`;
  return (
    <>
      <IxModalHeader icon={iconInfo} iconColor="color-primary" ariaLabelIcon="Information">
        <h2 className={`typography-h5 ${styles.heading}`}>{title}</h2>
      </IxModalHeader>
      <IxModalContent>
        <div className={styles.stack}>
          <div className={styles.row}>
            <OpChip op={step.op} blocked={!!step.blocked} />
            {item ? <StatusChip status={item.status} /> : null}
          </div>
          {step.blocked ? (
            <IxMessageBar type="warning" persistent>
              Blocked — {step.blocked.reason}
              {step.blocked.hint ? ` ${step.blocked.hint}` : ""}
            </IxMessageBar>
          ) : null}
          <IxKeyValueList role="list">
            <IxKeyValue role="listitem" label="Phase" value={`${PHASE_LABELS[step.phase]} (level ${step.level})`} labelPosition="left" />
            <IxKeyValue role="listitem" label="Tenant id" value={step.tenantId === "pending" ? "Assigned when created" : step.tenantId} labelPosition="left" />
            <IxKeyValue role="listitem" label="Reason" value={step.reason} labelPosition="left" />
            <IxKeyValue role="listitem" label="Destructive" value={step.destructive ? "Yes — data in the tenant is removed or replaced" : "No"} labelPosition="left" />
            <IxKeyValue
              role="listitem"
              label="Runs after"
              value={deps.length ? deps.map((d) => `${PHASE_LABELS[d.phase]}: ${d.entity.label}`).join(", ") : "No dependencies"}
              labelPosition="left"
            />
            {item ? (
              <IxKeyValue
                role="listitem"
                label="Execution"
                value={[
                  `${item.attempts} attempt${item.attempts === 1 ? "" : "s"}`,
                  item.httpStatus !== undefined ? `HTTP ${item.httpStatus}` : "",
                  item.durationMs !== undefined ? `${item.durationMs} ms` : "",
                  item.createdIds.length ? `created ${item.createdIds.join(", ")}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                labelPosition="left"
              />
            ) : null}
          </IxKeyValueList>
          {item && (item.errors.length > 0 || item.note) ? (
            <ul className={styles.list} aria-label="Messages">
              {[...item.errors, ...(item.note ? [item.note] : [])].map((e) => (
                <li key={e} className={styles.listItem}>
                  <IxTypography format="body-sm" className={styles.text}>
                    {e}
                  </IxTypography>
                </li>
              ))}
            </ul>
          ) : null}
          {item?.status === "conflict" ? (
            <section className={styles.stack} aria-label="Conflict">
              <h3 className={`typography-h6 ${styles.heading}`}>What changed in the target since the analysis</h3>
              <DiffView changes={item.conflict ?? []} beforeLabel="At analysis" afterLabel="Now in the target" empty="The ETag changed but no compared field differs." />
            </section>
          ) : null}
          <section className={styles.stack} aria-label="Requests">
            <h3 className={`typography-h6 ${styles.heading}`}>Requests</h3>
            {step.requests.length === 0 ? (
              <IxTypography format="body-sm" textColor="soft">
                No request — the entity is unchanged.
              </IxTypography>
            ) : (
              <ol className={styles.list}>
                {step.requests.map((r, i) => (
                  <RequestPreview key={i} req={r} index={i} total={step.requests.length} labels={labels} freshEtag={!!step.resourcePath} />
                ))}
              </ol>
            )}
            {step.resourcePath ? (
              <IxTypography format="body-xs" textColor="soft">
                Before the first request the executor reads GET {prettify(step.resourcePath, labels)} for a fresh ETag and checks that the target did not change since the analysis.
              </IxTypography>
            ) : null}
          </section>
          <section className={styles.stack} aria-label="Differences to the target">
            <h3 className={`typography-h6 ${styles.heading}`}>Differences to the target</h3>
            <DiffView changes={step.changes} beforeLabel="Target" afterLabel="Project" empty="No differences." />
          </section>
        </div>
      </IxModalContent>
      <IxModalFooter>
        {item?.status === "conflict" && onSkip ? (
          <IxButton
            variant="secondary"
            disabled={acted}
            onClick={() => {
              setActed(true);
              onSkip();
              modal.current?.close("skip");
            }}
          >
            Skip this step
          </IxButton>
        ) : null}
        {item?.status === "conflict" && onRetry ? (
          <IxButton
            variant="primary"
            disabled={acted}
            onClick={() => {
              setActed(true);
              onRetry();
              modal.current?.close("retry");
            }}
          >
            Retry with the fresh ETag
          </IxButton>
        ) : null}
        <IxButton variant={item?.status === "conflict" ? "tertiary" : "primary"} onClick={() => modal.current?.dismiss("done")}>
          Close details
        </IxButton>
      </IxModalFooter>
    </>
  );
}

