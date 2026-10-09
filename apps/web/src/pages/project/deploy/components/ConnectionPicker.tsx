// Connection selection for deploy / copy / backup: lists the user's
// connections (api.connections.list), shows tenant, environment and
// authentication mode, and explains clearly when the backend is unreachable.

import { useNavigate } from "react-router";
import {
  IxButton,
  IxChip,
  IxEmptyState,
  IxKeyValue,
  IxKeyValueList,
  IxMessageBar,
  IxSelect,
  IxSelectItem,
  IxSpinner,
  IxTypography,
} from "@siemens/ix-react";
import { iconCloud, iconRefresh } from "@siemens/ix-icons/icons";
import type { ConnectionSummary } from "@/api/client";
import { AUTH_MODE_LABELS } from "./labels";
import type { ConnectionsState } from "./useConnections";
import styles from "./deploy.module.css";




export function ConnectionDetails({ connection }: { connection: ConnectionSummary }) {
  return (
    <div className={styles.tightStack}>
      {connection.authMode === "simulator" ? (
        <div className={styles.row}>
          <IxChip variant="info" outline>
            Simulator — not a real tenant
          </IxChip>
        </div>
      ) : null}
      {/* ix-key-value-list renders plain divs; declare list semantics so the
          label → value pairs are announced as one list. */}
      <IxKeyValueList role="list">
        <IxKeyValue role="listitem" label="Tenant" value={connection.tenant} labelPosition="left" />
        <IxKeyValue role="listitem" label="Environment" value={connection.environment || "—"} labelPosition="left" />
        <IxKeyValue role="listitem" label="Authentication" value={AUTH_MODE_LABELS[connection.authMode]} labelPosition="left" />
        {connection.apiBaseUrl ? <IxKeyValue role="listitem" label="API base URL" value={connection.apiBaseUrl} labelPosition="left" /> : null}
        {connection.lastTest ? (
          <IxKeyValue
            role="listitem"
            label="Last connection test"
            value={`${connection.lastTest.ok ? "Succeeded" : "Failed"} · ${new Date(connection.lastTest.at).toLocaleString()}${connection.lastTest.message ? ` · ${connection.lastTest.message}` : ""}`}
            labelPosition="left"
          />
        ) : null}
      </IxKeyValueList>
    </div>
  );
}

export function ConnectionPicker({
  label,
  state,
  value,
  onChange,
  excludeId,
  helperText,
  disabled,
}: {
  label: string;
  state: ConnectionsState;
  value: string | undefined;
  onChange: (connection: ConnectionSummary | undefined) => void;
  excludeId?: string;
  helperText?: string;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const options = state.connections.filter((c) => c.id !== excludeId);
  const selected = options.find((c) => c.id === value);

  if (state.loading && state.connections.length === 0) {
    return (
      <div className={styles.row}>
        <IxSpinner size="small" />
        <IxTypography format="body">Loading tenant connections…</IxTypography>
      </div>
    );
  }
  if (state.offline || state.error) {
    return (
      <div className={styles.stack}>
        <IxMessageBar type="warning" persistent>
          {state.offline
            ? "Warning — the Asset Model Studio backend is not reachable (offline?). Tenant connections, deployments, backups and copies need it; your local projects stay available."
            : `Warning — the connections could not be loaded: ${state.error ?? "unknown error"}`}
        </IxMessageBar>
        <div className={styles.row}>
          <IxButton variant="secondary" icon={iconRefresh} onClick={() => void state.reload()}>
            Try again
          </IxButton>
        </div>
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <IxEmptyState
        layout="compact"
        icon={iconCloud}
        header="No tenant connections"
        subHeader="Add a connection to an Insights Hub tenant (or the built-in simulator) first."
        action="Manage connections"
        onActionClick={() => navigate("/tenants")}
      />
    );
  }
  return (
    <div className={styles.stack}>
      <IxSelect
        label={label}
        value={selected?.id ?? ""}
        helperText={helperText}
        disabled={disabled}
        i18nPlaceholder="Select a connection"
        onValueChange={(e) => {
          const id = Array.isArray(e.detail) ? e.detail[0] : e.detail;
          onChange(options.find((c) => c.id === id));
        }}
      >
        {options.map((c) => (
          <IxSelectItem key={c.id} value={c.id} label={`${c.name} · ${c.environment || "no environment"} · ${c.tenant}`} />
        ))}
      </IxSelect>
      {selected ? <ConnectionDetails connection={selected} /> : null}
    </div>
  );
}
