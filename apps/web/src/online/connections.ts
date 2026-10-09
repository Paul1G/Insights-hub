// Tenant connection form model: validation, write-only secrets and the
// ConnectionInput sent to the backend (docs/api-contract.md, "Connections").

import type { AuthInput, AuthMode, ConnectionInput, ConnectionSummary } from "@/api/client";
import { LIMITS, PATTERNS } from "@/domain/rules";

export const AUTH_MODES: { mode: AuthMode; label: string; description: string }[] = [
  {
    mode: "client_credentials",
    label: "Service credentials (client credentials)",
    description: "OAuth 2.0 client credentials of an Insights Hub service credential.",
  },
  {
    mode: "app_credentials",
    label: "Application credentials (Token Management Service)",
    description: "Technical token of an application via the Token Management Service.",
  },
  { mode: "bearer", label: "Bearer token (pasted)", description: "A short-lived access token; it is not refreshed." },
  {
    mode: "simulator",
    label: "Simulated tenant",
    description: "Simulated tenant — not a real Insights Hub tenant. Runs in the backend, no credentials.",
  },
];

export const SIMULATOR_LABEL = "Simulated tenant — not a real Insights Hub tenant";

export const EXAMPLES = {
  apiBaseUrl: "https://gateway.eu1.mindsphere.io/api/assetmanagement/v3",
  clientCredentialsTokenUrl: "https://{tenant}.piam.eu1.mindsphere.io/oauth/token",
  appCredentialsTokenUrl: "https://gateway.eu1.mindsphere.io/api/technicaltokenmanager/v3/oauth/token",
} as const;

export function authModeLabel(mode: AuthMode): string {
  return AUTH_MODES.find((m) => m.mode === mode)?.label ?? mode;
}

export interface ConnectionForm {
  name: string;
  environment: string;
  tenant: string;
  apiBaseUrl: string;
  mode: AuthMode;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  appName: string;
  appVersion: string;
  hostTenant: string;
  userTenant: string;
  token: string;
}

export function emptyConnectionForm(): ConnectionForm {
  return {
    name: "",
    environment: "dev",
    tenant: "",
    apiBaseUrl: EXAMPLES.apiBaseUrl,
    mode: "client_credentials",
    tokenUrl: "",
    clientId: "",
    clientSecret: "",
    appName: "",
    appVersion: "",
    hostTenant: "",
    userTenant: "",
    token: "",
  };
}

/** Form for editing: secrets are never returned by the backend, so they start empty. */
export function connectionFormFrom(c: ConnectionSummary): ConnectionForm {
  return {
    ...emptyConnectionForm(),
    name: c.name,
    environment: c.environment,
    tenant: c.tenant,
    apiBaseUrl: c.apiBaseUrl ?? "",
    mode: c.authMode,
    tokenUrl: c.tokenUrl ?? "",
    appName: c.appName ?? "",
    appVersion: c.appVersion ?? "",
    hostTenant: c.hostTenant ?? "",
    userTenant: c.userTenant ?? "",
  };
}

export type ConnectionErrors = Partial<Record<keyof ConnectionForm, string>>;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** https URL with a DNS host name (the backend additionally enforces its host allowlist). */
export function validateHttpsUrl(text: string): string | undefined {
  const v = text.trim();
  if (!v) return "URL is required.";
  if (v.includes("{") || v.includes("}")) return "Replace the {placeholders} with real values.";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Not a valid URL.";
  }
  if (u.protocol !== "https:") return "Only https URLs are allowed.";
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || IPV4.test(host) || host.startsWith("[")) return "Use the Insights Hub host name, not localhost or an IP address.";
  if (u.username || u.password) return "Credentials must not be part of the URL.";
  return undefined;
}

/** Does the edited connection already have stored credentials of this mode? */
export function hasStoredSecret(existing: ConnectionSummary | undefined, mode: AuthMode): boolean {
  return !!existing && existing.authMode === mode && mode !== "simulator";
}

export function validateConnectionForm(form: ConnectionForm, existing?: ConnectionSummary): ConnectionErrors {
  const e: ConnectionErrors = {};
  if (!form.name.trim()) e.name = "Name is required.";
  else if (form.name.trim().length > 100) e.name = "At most 100 characters.";
  if (!form.environment.trim()) e.environment = "Environment is required (e.g. dev, qa, prod).";
  else if (form.environment.trim().length > 40) e.environment = "At most 40 characters.";
  const tenant = form.tenant.trim();
  if (!tenant) e.tenant = "Tenant name is required.";
  else if (tenant.length > LIMITS.tenantNameMax || !PATTERNS.tenantName.test(tenant)) {
    e.tenant = `1–${LIMITS.tenantNameMax} letters, digits or _ (type ids are <tenant>.<id>).`;
  }
  if (form.mode !== "simulator") e.apiBaseUrl = validateHttpsUrl(form.apiBaseUrl);
  const stored = hasStoredSecret(existing, form.mode);
  if (form.mode === "client_credentials" || form.mode === "app_credentials") {
    e.tokenUrl = validateHttpsUrl(form.tokenUrl);
    if (!form.clientId.trim()) e.clientId = "Client ID is required.";
    if (!form.clientSecret && !stored) e.clientSecret = "Client secret is required.";
  }
  if (form.mode === "app_credentials") {
    if (!form.appName.trim()) e.appName = "App name is required.";
    if (!form.appVersion.trim()) e.appVersion = "App version is required.";
    if (!form.hostTenant.trim()) e.hostTenant = "Host tenant is required.";
    if (!form.userTenant.trim()) e.userTenant = "User tenant is required.";
  }
  if (form.mode === "bearer" && !form.token.trim() && !stored) e.token = "Token is required.";
  for (const k of Object.keys(e) as (keyof ConnectionForm)[]) if (!e[k]) delete e[k];
  return e;
}

/**
 * ConnectionInput for create/update. Secrets are only included when entered;
 * on update an empty secret keeps the stored one (write-only secrets).
 */
export function toConnectionInput(form: ConnectionForm): ConnectionInput {
  let auth: AuthInput;
  switch (form.mode) {
    case "client_credentials":
      auth = { mode: "client_credentials", tokenUrl: form.tokenUrl.trim(), clientId: form.clientId.trim() };
      if (form.clientSecret) auth.clientSecret = form.clientSecret;
      break;
    case "app_credentials":
      auth = {
        mode: "app_credentials",
        tokenUrl: form.tokenUrl.trim(),
        clientId: form.clientId.trim(),
        appName: form.appName.trim(),
        appVersion: form.appVersion.trim(),
        hostTenant: form.hostTenant.trim(),
        userTenant: form.userTenant.trim(),
      };
      if (form.clientSecret) auth.clientSecret = form.clientSecret;
      break;
    case "bearer":
      auth = { mode: "bearer" };
      if (form.token.trim()) auth.token = form.token.trim();
      break;
    case "simulator":
      auth = { mode: "simulator" };
      break;
  }
  const input: ConnectionInput = {
    name: form.name.trim(),
    environment: form.environment.trim(),
    tenant: form.tenant.trim(),
    auth,
  };
  if (form.mode !== "simulator") input.apiBaseUrl = form.apiBaseUrl.trim();
  return input;
}

const ENV_ORDER = ["prod", "production", "qa", "test", "staging", "dev", "development", "sandbox"];

/** Connections grouped by environment (well-known environments first, then alphabetical). */
export function groupByEnvironment(list: readonly ConnectionSummary[]): { environment: string; connections: ConnectionSummary[] }[] {
  const groups = new Map<string, ConnectionSummary[]>();
  for (const c of list) {
    const env = c.environment.trim() || "unspecified";
    const key = env.toLowerCase();
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }
  const rank = (env: string) => {
    const i = ENV_ORDER.indexOf(env);
    return i < 0 ? ENV_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, connections]) => ({
      environment: connections[0]!.environment.trim() || "unspecified",
      connections: [...connections].sort((x, y) => x.name.localeCompare(y.name)),
    }));
}
