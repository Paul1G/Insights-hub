// adapter/simulator/store persists one simulated tenant under
// <dataDir>/simulator/<connectionId>/:
//   state.json      — tenant state (atomic write: temp file + rename)
//   files/<id>.bin  — uploaded file contents (atomic write)
//
// State writes are coalesced: many mutations in quick succession (e.g. a
// deployment creating hundreds of assets) produce few writes, each of the
// latest snapshot. flush() waits until everything is on disk.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../../log.js';

import type { BlobStore } from './handler-util.js';
import type { SimStateFile } from './model.js';
import { notFound } from './sim-error.js';

const SAVE_DELAY_MS = 50;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function writeAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export class TenantStore implements BlobStore {
  readonly dir: string;
  private readonly logger: Logger;
  private snapshot: (() => SimStateFile) | undefined;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private saving: Promise<void> | undefined;

  constructor(baseDir: string, connectionId: string, logger: Logger) {
    if (!SAFE_ID.test(connectionId))
      throw new Error('simulator: invalid connection id');
    this.dir = join(baseDir, connectionId);
    this.logger = logger;
  }

  /** Reads state.json, or persists and returns `seed()` for a new tenant. */
  loadOrSeed(seed: () => SimStateFile): SimStateFile {
    mkdirSync(join(this.dir, 'files'), { recursive: true });
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.dir, 'state.json'), 'utf8'),
      ) as SimStateFile;
      if (parsed.version !== 1)
        throw new Error(
          `unsupported simulator state version ${String(parsed.version)}`,
        );
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const state = seed();
    this.scheduleSave(() => state);
    return state;
  }

  scheduleSave(snapshot: () => SimStateFile): void {
    this.snapshot = snapshot;
    this.dirty = true;
    if (this.timer || this.saving) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startSaving();
    }, SAVE_DELAY_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.startSaving();
    }
    while (this.saving) await this.saving;
  }

  private startSaving(): void {
    if (this.saving) return;
    this.saving = (async () => {
      try {
        while (this.dirty && this.snapshot) {
          this.dirty = false;
          const data = JSON.stringify(this.snapshot());
          await mkdir(this.dir, { recursive: true });
          await writeAtomic(join(this.dir, 'state.json'), data);
        }
      } catch (err) {
        this.logger.error(
          { err, dir: this.dir },
          'simulator: failed to persist tenant state',
        );
      } finally {
        this.saving = undefined;
      }
    })();
  }

  private blobPath(fileId: string): string {
    if (!SAFE_ID.test(fileId)) throw new Error('simulator: invalid file id');
    return join(this.dir, 'files', `${fileId.toLowerCase()}.bin`);
  }

  async write(fileId: string, data: Uint8Array): Promise<void> {
    await mkdir(join(this.dir, 'files'), { recursive: true });
    await writeAtomic(this.blobPath(fileId), data);
  }

  async read(fileId: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.blobPath(fileId)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw notFound(`File ${fileId} content not found`);
      throw err;
    }
  }

  async remove(fileId: string): Promise<void> {
    await rm(this.blobPath(fileId), { force: true });
  }

  /** Stops pending writes and deletes everything on disk. */
  async destroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    while (this.saving) await this.saving;
    await rm(this.dir, { recursive: true, force: true });
  }
}
