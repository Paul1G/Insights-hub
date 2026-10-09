// Guardrails & settings: guardrail profile, recommended thresholds, technical
// limits (read-only, with the documented error-message recommendations) and
// local storage. The route's <h1> is rendered by the shared PageHeader.

import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { IxButton, IxNumberInput, IxRadio, IxRadioGroup, IxTypography } from "@siemens/ix-react";
import { iconRefresh, iconReset, iconShield } from "@siemens/ix-icons/icons";
import { DashboardGrid } from "@/components/DashboardGrid";
import { DashboardPanel } from "@/components/DashboardPanel";
import { notifyError, notifyInfo, notifySuccess } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import {
  DEFAULT_RECOMMENDED,
  GUARDRAIL_NOTES,
  TECHNICAL_LIMITS,
  type GuardrailProfile,
  type RecommendedThresholds,
  type TechnicalLimits,
} from "@/domain/rules";
import { db } from "@/storage/db";
import { useSettingsStore } from "@/state/settingsStore";
import styles from "./SettingsPage.module.css";

const THRESHOLDS: { key: keyof RecommendedThresholds; label: string; doc: string }[] = [
  {
    key: "maxAssetTypes",
    label: "Asset types per project",
    doc: "It is recommended not to use more than 100 asset types overall.",
  },
  {
    key: "maxVariablesPerAspectType",
    label: "Variables per aspect type",
    doc: "It is recommended not to use more than 10 variables on a single aspect type.",
  },
  {
    key: "maxAspectsPerAssetType",
    label: "Aspects per asset type (incl. inherited)",
    doc: "It is recommended not to use more than 25 aspect types on a single asset type.",
  },
  {
    key: "maxVariablesPerAssetType",
    label: "Variables per asset type (incl. inherited and aspects)",
    doc: "It is recommended not to define more than 250 variables on a single asset type.",
  },
];

// Transcribed from docs/reference/overview-and-modelling-guidelines.txt,
// "Modeling Recommendations for P&P Tenant".
const TECHNICAL_ROWS: { key: keyof TechnicalLimits; label: string; error?: string; recommendation?: string; note?: string }[] = [
  {
    key: "maxVariablesPerAspectType",
    label: "Variables (static and dynamic) defined in an aspect type",
    error:
      "Aspect type cannot be created as aspect type variables technical limit exceeded for tenant. Please reduce the number of variables in aspect type.",
    recommendation:
      "1. Reduce the number of variables in aspect type. 2. Split variables across multiple aspect types, e.g. 30 variables on an aspect type can be split across 2 aspect types with 15 variables each.",
  },
  {
    key: "maxAspectsPerAssetType",
    label: "Aspects associated with an asset type",
    error:
      "Asset type cannot be created as asset type aspect technical limit exceeded for tenant. Please reduce the number of assettype-aspecttype associations.",
    recommendation:
      "Reduce the number of aspects on the asset type by increasing variables per aspect, but make sure that variables per aspect are within the limit of 20.",
  },
  {
    key: "maxDirectVariablesPerAssetType",
    label: "Static / direct variables on an asset type",
    error:
      "Asset type cannot be created as asset type direct variable technical limit exceeded for tenant. Please reduce the number of direct variables in asset type.",
    recommendation: "Reduce the number of direct variables on the asset type by shifting them over to a reusable aspect type.",
  },
  { key: "maxAssetTypeDepth", label: "Max depth in asset type hierarchy", note: GUARDRAIL_NOTES.assetTypeDepth },
  { key: "maxAssetHierarchyDepth", label: "Max depth in asset hierarchy", note: GUARDRAIL_NOTES.assetHierarchyDepth },
  { key: "maxAttributesPerAsset", label: "Max attribute count per asset", note: GUARDRAIL_NOTES.attributes },
  { key: "maxAttributesPerTenant", label: "Max attribute count per tenant" },
];

function thresholdError(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Enter a whole number of at least 1.";
  if (!Number.isInteger(value) || value < 1) return "Enter a whole number of at least 1.";
  return undefined;
}

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

function ProfilePanel() {
  const guardrails = useSettingsStore((s) => s.guardrails);
  const setGuardrails = useSettingsStore((s) => s.setGuardrails);
  const change = async (profile: GuardrailProfile) => {
    if (profile === guardrails.profile) return;
    try {
      await setGuardrails({ ...guardrails, profile });
      notifySuccess(profile === "technical" ? "Technical limits are now enforced as errors." : "Technical limits are now informational.");
    } catch (e) {
      notifyError(e, "Setting could not be saved");
    }
  };
  return (
    <DashboardPanel title="Guardrail profile" span="span-2">
      <div className={styles.stack}>
        <IxRadioGroup label="Active profile" value={guardrails.profile} onValueChange={(e) => void change(e.detail as GuardrailProfile)}>
          <IxRadio label="Recommended only" value="recommended" checked={guardrails.profile === "recommended"} />
          <IxRadio label="Recommended + technical limits" value="technical" checked={guardrails.profile === "technical"} />
        </IxRadioGroup>
        <dl className={styles.definitions}>
          <dt>
            <IxTypography format="label">Recommended only</IxTypography>
          </dt>
          <dd>
            <IxTypography format="body-sm" textColor="soft">
              Checks the performance recommendations (thresholds on the right) as warnings. Technical limits are reported as
              information and never block a deployment. Suitable for tenants without Capability Package limits.
            </IxTypography>
          </dd>
          <dt>
            <IxTypography format="label">Recommended + technical limits</IxTypography>
          </dt>
          <dd>
            <IxTypography format="body-sm" textColor="soft">
              Additionally enforces the technical limits of Capability Package based (P&amp;P) environments. Exceeding one is an
              error that blocks deployment — the platform would reject the request.
            </IxTypography>
          </dd>
        </dl>
      </div>
    </DashboardPanel>
  );
}

function ThresholdsPanel() {
  const guardrails = useSettingsStore((s) => s.guardrails);
  const setGuardrails = useSettingsStore((s) => s.setGuardrails);
  const [invalid, setInvalid] = useState<Partial<Record<keyof RecommendedThresholds, number | undefined>>>({});
  const rec = guardrails.recommended;
  const isDefault = THRESHOLDS.every((t) => rec[t.key] === DEFAULT_RECOMMENDED[t.key]);

  const change = async (key: keyof RecommendedThresholds, value: number | null | undefined) => {
    if (thresholdError(value)) {
      setInvalid((s) => ({ ...s, [key]: value ?? undefined }));
      return;
    }
    setInvalid((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });
    if (rec[key] === value) return;
    try {
      await setGuardrails({ ...guardrails, recommended: { ...rec, [key]: value as number } });
    } catch (e) {
      notifyError(e, "Threshold could not be saved");
    }
  };

  const reset = async () => {
    try {
      setInvalid({});
      await setGuardrails({ ...guardrails, recommended: { ...DEFAULT_RECOMMENDED } });
      notifySuccess("Recommended thresholds reset to the documented defaults.");
    } catch (e) {
      notifyError(e, "Reset failed");
    }
  };

  return (
    <DashboardPanel
      title="Recommended thresholds"
      span="span-2"
      action={
        <IxButton variant="subtle-secondary" icon={iconReset} disabled={isDefault && Object.keys(invalid).length === 0} onClick={() => void reset()}>
          Reset to defaults
        </IxButton>
      }
    >
      <div className={styles.stack}>
        <IxTypography format="body-sm" textColor="soft" className={styles.text}>
          “Recommendation for optimum performance” — not a platform limitation. Exceeding a threshold produces a warning. Values
          are saved immediately.
        </IxTypography>
        <div className={styles.fields}>
          {THRESHOLDS.map((t) => {
            const isInvalid = t.key in invalid;
            const error = isInvalid ? thresholdError(invalid[t.key]) : undefined;
            return (
              <IxNumberInput
                key={t.key}
                label={t.label}
                value={isInvalid ? invalid[t.key] : rec[t.key]}
                min={1}
                step={1}
                required
                helperText={`Default ${DEFAULT_RECOMMENDED[t.key]}. ${t.doc}`}
                invalidText={error}
                className={error ? "ix-invalid" : undefined}
                onValueChange={(e) => void change(t.key, e.detail)}
              />
            );
          })}
        </div>
      </div>
    </DashboardPanel>
  );
}

function TechnicalLimitsPanel() {
  return (
    <DashboardPanel title="Technical limits (read-only)" span="full">
      <div className={styles.stack}>
        <IxTypography format="body-sm" textColor="soft" className={styles.text}>
          Enforced technical limits for P&amp;P tenants. These limits are enforced on Capability Package based environments only.
          The API rate limits for Asset Management apply as technical rate limits.
        </IxTypography>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className="visually-hidden">Technical limits with the documented error messages and recommendations</caption>
            <thead>
              <tr>
                <th scope="col"><IxTypography format="label-sm" textColor="soft">Object type</IxTypography></th>
                <th scope="col"><IxTypography format="label-sm" textColor="soft">Limit</IxTypography></th>
                <th scope="col"><IxTypography format="label-sm" textColor="soft">Error message when exceeded</IxTypography></th>
                <th scope="col"><IxTypography format="label-sm" textColor="soft">Recommendation</IxTypography></th>
              </tr>
            </thead>
            <tbody>
              {TECHNICAL_ROWS.map((r) => (
                <tr key={r.key}>
                  <th scope="row">
                    <IxTypography format="body-sm">{r.label}</IxTypography>
                    {r.note ? (
                      <IxTypography format="body-xs" textColor="soft">
                        {r.note}
                      </IxTypography>
                    ) : null}
                  </th>
                  <td className={styles.limit}>
                    <IxTypography format="label">{TECHNICAL_LIMITS[r.key].toLocaleString()}</IxTypography>
                  </td>
                  <td>
                    <IxTypography format="body-sm" textColor={r.error ? undefined : "soft"}>
                      {r.error ?? "Not documented"}
                    </IxTypography>
                  </td>
                  <td>
                    <IxTypography format="body-sm" textColor={r.recommendation ? undefined : "soft"}>
                      {r.recommendation ?? "—"}
                    </IxTypography>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardPanel>
  );
}

function CountingNotesPanel() {
  return (
    <DashboardPanel title="How limits are counted" span="span-2">
      <ul className={styles.notes}>
        <li>
          <IxTypography format="body-sm">{GUARDRAIL_NOTES.assetTypeDepth}</IxTypography>
        </li>
        <li>
          <IxTypography format="body-sm">{GUARDRAIL_NOTES.assetHierarchyDepth}</IxTypography>
        </li>
        <li>
          <IxTypography format="body-sm">{GUARDRAIL_NOTES.attributes}</IxTypography>
        </li>
        <li>
          <IxTypography format="body-sm">
            The attribute count is an estimate, like the platform’s own calculator; slight variations are expected.
          </IxTypography>
        </li>
      </ul>
    </DashboardPanel>
  );
}

interface StorageInfo {
  supported: boolean;
  usage?: number;
  quota?: number;
  persisted?: boolean;
}

function StoragePanel() {
  const [info, setInfo] = useState<StorageInfo>({ supported: typeof navigator !== "undefined" && !!navigator.storage });
  const [busy, setBusy] = useState(false);
  const counts = useLiveQuery(
    async () => ({
      projects: await db.projects.count(),
      snapshots: await db.snapshots.count(),
      files: await db.fileBlobs.count(),
      libraries: await db.userLibraries.count(),
    }),
    [],
  );

  const refresh = useCallback(async () => {
    const storage = navigator.storage;
    if (!storage) return;
    try {
      const [estimate, persisted] = await Promise.all([
        storage.estimate ? storage.estimate() : Promise.resolve<StorageEstimate>({}),
        storage.persisted ? storage.persisted() : Promise.resolve<boolean | undefined>(undefined),
      ]);
      setInfo({ supported: true, usage: estimate.usage, quota: estimate.quota, persisted });
    } catch (e) {
      notifyError(e, "Storage information unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const request = async () => {
    if (!navigator.storage?.persist) return;
    setBusy(true);
    try {
      const granted = await navigator.storage.persist();
      setInfo((s) => ({ ...s, persisted: granted }));
      if (granted) notifySuccess("Persistent storage granted: the browser will not evict your projects to free space.");
      else
        notifyInfo(
          "The browser declined persistent storage (browsers decide based on site engagement or installation). Keep exports as backups.",
        );
    } catch (e) {
      notifyError(e, "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const share = info.usage !== undefined && info.quota ? Math.min(100, (info.usage / info.quota) * 100) : undefined;

  return (
    <DashboardPanel
      title="Local storage"
      span="span-2"
      action={
        <IxButton variant="subtle-tertiary" icon={iconRefresh} onClick={() => void refresh()}>
          Refresh
        </IxButton>
      }
    >
      <div className={styles.stack}>
        <IxTypography format="body-sm" textColor="soft" className={styles.text}>
          Projects, snapshots, file contents and libraries are stored in this browser’s IndexedDB and are available offline. They
          are not synchronised between browsers or devices.
        </IxTypography>
        {!info.supported ? (
          <IxTypography format="body-sm">This browser does not expose the Storage API; usage and persistence are unknown.</IxTypography>
        ) : (
          <>
            <div className={styles.kv}>
              <IxTypography format="label-sm" textColor="soft">Used</IxTypography>
              <IxTypography format="body">
                {formatBytes(info.usage)} of {formatBytes(info.quota)}
                {share !== undefined ? ` (${share.toFixed(share < 1 ? 2 : 1)}%)` : ""}
              </IxTypography>
            </div>
            {share !== undefined ? (
              <div
                className={styles.track}
                role="meter"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(share)}
                aria-valuetext={`${formatBytes(info.usage)} of ${formatBytes(info.quota)}`}
              >
                <div className={styles.fill} style={{ width: `${share}%` }} />
              </div>
            ) : null}
            <div className={styles.kv}>
              <IxTypography format="label-sm" textColor="soft">Persistence</IxTypography>
              <IxTypography format="body" role="status">
                {info.persisted === undefined
                  ? "Unknown"
                  : info.persisted
                    ? "Persistent — the browser will not evict this data automatically"
                    : "Best effort — the browser may evict data under storage pressure"}
              </IxTypography>
            </div>
            <div>
              <IxButton
                variant="secondary"
                icon={iconShield}
                disabled={busy || info.persisted === true || !navigator.storage?.persist}
                onClick={() => void request()}
              >
                {info.persisted ? "Persistent storage granted" : "Request persistent storage"}
              </IxButton>
            </div>
          </>
        )}
        {counts ? (
          <IxTypography format="body-sm" textColor="soft" className={styles.text}>
            Stored: {counts.projects} project{counts.projects === 1 ? "" : "s"}, {counts.snapshots} snapshot
            {counts.snapshots === 1 ? "" : "s"}, {counts.files} file content{counts.files === 1 ? "" : "s"}, {counts.libraries} user
            librar{counts.libraries === 1 ? "y" : "ies"}.
          </IxTypography>
        ) : null}
      </div>
    </DashboardPanel>
  );
}

export function SettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Guardrails & settings"
        subtitle="Modelling guardrails applied by the validator in every project, and local storage of this browser."
      />
      <DashboardGrid>
        <ProfilePanel />
        <ThresholdsPanel />
        <TechnicalLimitsPanel />
        <CountingNotesPanel />
        <StoragePanel />
      </DashboardGrid>
    </Page>
  );
}
