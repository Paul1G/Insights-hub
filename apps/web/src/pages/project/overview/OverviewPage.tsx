// Overview & health (/p/:projectId): KPI tiles, Model Health, validation
// issues and the Asset Attribute Estimator on the dashboard archetype
// (DashboardGrid + DashboardPanel). The route's <h1> is rendered by the
// shared PageHeader.

import { useNavigate } from "react-router";
import { IxIcon, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconApps, iconCalculator, iconFolder, iconObjectsTree, iconTree } from "@siemens/ix-icons/icons";
import { DashboardGrid } from "@/components/DashboardGrid";
import { DashboardPanel } from "@/components/DashboardPanel";
import { notifyError } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { TECHNICAL_LIMITS, type GuardrailProfile } from "@/domain/rules";
import { useEstimate, useProject } from "@/state/hooks";
import { useSettingsStore } from "@/state/settingsStore";
import { EstimatorPanel } from "./EstimatorPanel";
import { HealthPanel } from "./HealthPanel";
import { IssuesPanel } from "./IssuesPanel";
import { LimitMeter } from "./LimitMeter";
import styles from "./Overview.module.css";

function KpiTile({ label, value, caption, icon, href }: { label: string; value: string; caption?: string; icon: string; href?: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiHead}>
        <span className={styles.kpiIcon}>
          {/* Decorative: the KPI label sits right next to it. */}
          <IxIcon name={icon} size="24" aria-hidden="true" />
        </span>
        <IxTypography format="label" className={styles.wrap}>
          {label}
        </IxTypography>
      </div>
      <IxTypography format="display-sm" className={styles.kpiValue}>
        {value}
      </IxTypography>
      <div className={styles.kpiFoot}>
        {caption ? (
          <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
            {caption}
          </IxTypography>
        ) : null}
        {href ? (
          <a className={styles.link} href={href}>
            Open {label.toLowerCase()}
          </a>
        ) : null}
      </div>
    </div>
  );
}

const PROFILE_LABEL: Record<GuardrailProfile, string> = {
  recommended: "Recommended only",
  technical: "Recommended + technical limits",
};

export function OverviewPage() {
  const project = useProject();
  const navigate = useNavigate();
  const estimate = useEstimate();
  const guardrails = useSettingsStore((s) => s.guardrails);
  const setGuardrails = useSettingsStore((s) => s.setGuardrails);
  const base = `#/p/${project.id}`;
  const assets = project.assets.length - 1;
  const instantiated = estimate.types.filter((t) => t.instances > 0).length;

  return (
    <Page>
      <PageHeader
        title="Overview & health"
        subtitle={project.description || `Last changed ${new Date(project.updatedAt).toLocaleString()}`}
        meta={
          <div className={styles.profile}>
            <IxSelect
              label="Guardrail profile"
              value={guardrails.profile}
              helperText={
                guardrails.profile === "technical"
                  ? "Technical limits are errors that block deployment."
                  : "Technical limits are reported as information only."
              }
              onValueChange={(e) => {
                const v = e.detail;
                if (v === "recommended" || v === "technical") {
                  setGuardrails({ ...guardrails, profile: v }).catch((err: unknown) => notifyError(err, "Could not save the guardrail profile"));
                }
              }}
            >
              {(Object.keys(PROFILE_LABEL) as GuardrailProfile[]).map((p) => (
                <IxSelectItem key={p} value={p} label={PROFILE_LABEL[p]} />
              ))}
            </IxSelect>
          </div>
        }
      />
      <DashboardGrid>
        <DashboardPanel title="Key figures" span="full">
          <div className={styles.kpiRow}>
            <KpiTile label="Aspect types" value={project.aspectTypes.length.toLocaleString()} icon={iconApps} href={`${base}/aspect-types`} />
            <KpiTile
              label="Asset types"
              value={project.assetTypes.length.toLocaleString()}
              caption={`${instantiated} type(s) with instances`}
              icon={iconObjectsTree}
              href={`${base}/asset-types`}
            />
            <KpiTile label="Assets" value={assets.toLocaleString()} caption="below the tenant root" icon={iconTree} href={`${base}/hierarchy`} />
            <KpiTile label="Files" value={project.files.length.toLocaleString()} icon={iconFolder} href={`${base}/files`} />
            <KpiTile
              label="Estimated asset attributes"
              value={estimate.totalAttributes.toLocaleString()}
              caption={estimate.incomplete ? "lower bound — external types are unknown offline" : "sum over all assets"}
              icon={iconCalculator}
            />
            <div className={styles.kpi}>
              <IxTypography format="label" className={styles.wrap}>
                Share of the tenant limit
              </IxTypography>
              <IxTypography format="display-sm" className={styles.kpiValue}>
                {(estimate.tenantLimitShare * 100).toFixed(estimate.tenantLimitShare < 0.1 ? 2 : 1)}%
              </IxTypography>
              <div className={styles.kpiFoot}>
                <LimitMeter label="Per-tenant technical limit" value={estimate.totalAttributes} limit={TECHNICAL_LIMITS.maxAttributesPerTenant} />
              </div>
            </div>
          </div>
        </DashboardPanel>

        <DashboardPanel title="Model health" span="span-2">
          <HealthPanel projectId={project.id} onNavigate={navigate} />
        </DashboardPanel>

        <DashboardPanel title="Validation issues" span="span-2">
          <IssuesPanel projectId={project.id} onNavigate={navigate} />
        </DashboardPanel>

        <DashboardPanel title="Asset attribute estimator" span="full">
          <EstimatorPanel />
        </DashboardPanel>
      </DashboardGrid>
    </Page>
  );
}
