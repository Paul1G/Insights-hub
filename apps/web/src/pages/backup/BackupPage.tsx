// Backup a tenant: read it (types, optionally assets and file contents) into
// a new local project with baselines and a mapping for the source connection,
// so a later redeploy of the backup to the same tenant is idempotent.

import { useState } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxCard, IxCardContent, IxCheckbox, IxMessageBar, IxSpinner, IxTypography } from "@siemens/ix-react";
import { iconBackup, iconProject } from "@siemens/ix-icons/icons";
import { promptDialog } from "@/components/dialogs";
import { errorMessage, notifyError, notifySuccess } from "@/components/notify";
import { Page, Section } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { mappingId } from "@/deploy/mapping";
import { saveMapping } from "@/deploy/store";
import { createApiTransport } from "@/deploy/transport";
import type { ConnectionSummary } from "@/api/client";
import { saveProject } from "@/storage/repository";
import { MemoryBlobStore, persistBlobs, snapshotToProject, type SnapshotConversion } from "@/tenant/convert";
import { readTenant, type ReadProgress, type TenantSnapshot } from "@/tenant/read";
import { ConnectionPicker } from "../project/deploy/components/ConnectionPicker";
import { useConnections } from "../project/deploy/components/useConnections";
import { Tiles } from "../project/deploy/components/chips";
import styles from "../project/deploy/components/deploy.module.css";

type State =
  | { status: "idle" }
  | { status: "running"; message: string; counts?: ReadProgress["counts"] }
  | { status: "error"; message: string }
  | { status: "done"; snapshot: TenantSnapshot; conversion: SnapshotConversion; blobs: MemoryBlobStore; connection: ConnectionSummary; contents: boolean };

export function BackupPage() {
  const navigate = useNavigate();
  const conns = useConnections();
  const [connectionId, setConnectionId] = useState<string>();
  const [includeAssets, setIncludeAssets] = useState(true);
  const [includeContents, setIncludeContents] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const connection = conns.connections.find((c) => c.id === connectionId);

  async function run() {
    if (!connection) return;
    setState({ status: "running", message: "Reading the tenant…" });
    try {
      const transport = createApiTransport(connection.id);
      const snapshot = await readTenant(transport, {
        tenant: connection.tenant,
        includeAssets,
        includeFiles: true,
        onProgress: (p) => setState({ status: "running", message: p.message, counts: p.counts }),
      });
      const blobs = new MemoryBlobStore();
      const at = new Date();
      const conversion = await snapshotToProject(snapshot, {
        name: `Backup of ${connection.tenant} (${connection.name}) ${at.toLocaleString()}`,
        description: `Backup of tenant ${connection.tenant} taken ${at.toISOString()}.`,
        connectionId: connection.id,
        includeFileContents: includeContents,
        transport,
        blobs,
        onProgress: (message, done, total) => setState({ status: "running", message: `${message} (${done + 1} of ${total})` }),
      });
      setState({ status: "done", snapshot, conversion, blobs, connection, contents: includeContents });
    } catch (e) {
      setState({ status: "error", message: errorMessage(e) });
    }
  }

  async function save() {
    if (state.status !== "done") return;
    const name = await promptDialog({
      title: "Save backup as project",
      label: "Project name",
      initial: state.conversion.project.name,
      confirmLabel: "Save project",
      validate: (v) => (v.trim() ? undefined : "Enter a name."),
    });
    if (!name) return;
    setSaving(true);
    try {
      const project = structuredClone(state.conversion.project);
      project.name = name.trim();
      await persistBlobs(project, state.blobs);
      await saveProject(project);
      await saveMapping({ ...state.conversion.mapping, id: mappingId(project.id, state.connection.id), projectId: project.id });
      notifySuccess(`Backup saved as “${project.name}”.`);
      navigate(`/p/${project.id}`);
    } catch (e) {
      notifyError(e, "The backup could not be saved");
    } finally {
      setSaving(false);
    }
  }

  const busy = state.status === "running";
  const p = state.status === "done" ? state.conversion.project : undefined;
  const downloaded = p ? p.files.filter((f) => f.blobId).length : 0;

  return (
    <Page>
      {/* PageHeader renders the route's single <h1>. */}
      <PageHeader title="Backup tenant" subtitle="Read a tenant's asset model into a new local project — with baselines and a deployment mapping for the source." />

      <Section title="Source">
        <IxCard variant="outline" className={styles.card} passive>
          <IxCardContent>
            <div className={styles.cardBody}>
              <div className={styles.formGrid}>
                <ConnectionPicker
                  label="Connection"
                  state={conns}
                  value={connectionId}
                  disabled={busy}
                  onChange={(c) => {
                    setConnectionId(c?.id);
                    setState({ status: "idle" });
                  }}
                />
                <div className={styles.stack}>
                  <IxCheckbox label="Include assets (the whole hierarchy with values and locations)" checked={includeAssets} disabled={busy} onCheckedChange={(e) => setIncludeAssets(e.detail)} />
                  <IxCheckbox label="Include file contents" checked={includeContents} disabled={busy} onCheckedChange={(e) => setIncludeContents(e.detail)} />
                  {includeContents ? (
                    <IxMessageBar type="warning" persistent>
                      Warning — every file is downloaded (up to 5 MB each) and stored in this browser. Large tenants can need a lot of time and local storage.
                    </IxMessageBar>
                  ) : (
                    <IxTypography format="body-xs" textColor="soft">
                      Without contents, file metadata and assignments are kept; the files cannot be deployed elsewhere until their contents are uploaded locally.
                    </IxTypography>
                  )}
                </div>
              </div>
              <div className={styles.row}>
                <IxButton icon={iconBackup} disabled={!connection || busy} loading={busy} onClick={() => void run()}>
                  Start backup
                </IxButton>
                {state.status === "running" ? (
                  <span className={styles.row}>
                    <IxSpinner size="small" />
                    <IxTypography format="body-sm">
                      {state.message}
                      {state.counts ? ` — ${state.counts.aspectTypes} aspect types, ${state.counts.assetTypes} asset types, ${state.counts.assets} assets, ${state.counts.files} files so far` : ""}
                    </IxTypography>
                  </span>
                ) : null}
              </div>
              {state.status === "error" ? (
                <IxMessageBar type="alarm" persistent>
                  Error — the backup failed: {state.message}
                </IxMessageBar>
              ) : null}
            </div>
          </IxCardContent>
        </IxCard>
      </Section>

      {state.status === "done" && p ? (
        <Section
          title="Result"
          actions={
            <IxButton icon={iconProject} loading={saving} onClick={() => void save()}>
              Save as project
            </IxButton>
          }
        >
          {state.snapshot.partialFailures.length ? (
            <IxMessageBar type="warning" persistent>
              Warning — {state.snapshot.partialFailures.length} page(s) could not be read after retries; the backup is incomplete. Run the backup again to get a complete copy.
            </IxMessageBar>
          ) : null}
          <Tiles
            label="Backup contents"
            items={[
              { label: "Aspect types", value: p.aspectTypes.length },
              { label: "Asset types", value: p.assetTypes.length },
              { label: "Assets", value: Math.max(0, p.assets.length - 1) },
              { label: "Files", value: p.files.length },
              { label: "File contents", value: state.contents ? downloaded : "not included" },
              { label: "Core / shared types referenced", value: state.snapshot.assetTypes.core.length + state.snapshot.assetTypes.external.length },
            ]}
          />
          <IxTypography format="body-sm" textColor="soft">
            Read from {state.connection.name} (tenant {state.snapshot.tenant}) at {new Date(state.snapshot.readAt).toLocaleString()}. Saving creates a new project with baselines and records the mapping for this connection, so deploying the backup back to this tenant only changes what you edit.
          </IxTypography>
          {state.conversion.warnings.length ? (
            <section className={styles.stack} aria-label="Warnings">
              <h3 className={`typography-h5 ${styles.heading}`}>Warnings ({state.conversion.warnings.length})</h3>
              <ul className={styles.list}>
                {state.conversion.warnings.slice(0, 100).map((w) => (
                  <li key={w} className={styles.listItem}>
                    <IxTypography format="body-sm" className={styles.text}>
                      {w}
                    </IxTypography>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </Section>
      ) : null}
    </Page>
  );
}
