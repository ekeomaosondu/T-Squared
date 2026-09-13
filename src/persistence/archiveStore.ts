import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/src/logging/logger';

/**
 * Object storage for immutable raw archives.
 *
 * Deliberately an interface. Vercel Blob is the default target, but the
 * recorder's core must not depend on it -- the same archives have to work when
 * ingestion runs on a VM, and a local backend makes the verification path
 * testable without network access.
 */

export interface StoredObject {
  path: string;
  size: number;
  /** Provider URL, when the backend exposes one. */
  url?: string;
}

export interface ArchiveStore {
  readonly kind: string;
  put(objectPath: string, body: Buffer): Promise<StoredObject>;
  /** Reads the object back, for checksum verification. */
  get(objectPath: string): Promise<Buffer>;
  exists(objectPath: string): Promise<boolean>;
}

/**
 * Local filesystem backend.
 *
 * Used for development and tests. NOT durable on Vercel, where a function's
 * filesystem does not survive the invocation -- the archive worker refuses to
 * use it there.
 */
export class LocalArchiveStore implements ArchiveStore {
  readonly kind = 'local';

  constructor(private readonly root: string) {}

  private resolve(objectPath: string): string {
    const full = path.join(this.root, objectPath);
    // Object paths are constructed internally, but a traversal would write
    // outside the archive root, so reject it explicitly.
    if (!full.startsWith(path.resolve(this.root))) {
      throw new Error(`archive path escapes root: ${objectPath}`);
    }
    return full;
  }

  async put(objectPath: string, body: Buffer): Promise<StoredObject> {
    const full = this.resolve(objectPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    return { path: objectPath, size: body.byteLength, url: `file://${full}` };
  }

  async get(objectPath: string): Promise<Buffer> {
    return readFile(this.resolve(objectPath));
  }

  async exists(objectPath: string): Promise<boolean> {
    try {
      await stat(this.resolve(objectPath));
      return true;
    } catch {
      return false;
    }
  }
}

/** Vercel Blob backend. Loaded lazily so the daemon needs no Vercel packages. */
export class VercelBlobStore implements ArchiveStore {
  readonly kind = 'vercel-blob';
  private readonly urls = new Map<string, string>();

  constructor(private readonly token: string) {}

  async put(objectPath: string, body: Buffer): Promise<StoredObject> {
    const { put } = await import('@vercel/blob');
    const result = await put(objectPath, body, {
      access: 'public',
      token: this.token,
      contentType: 'application/gzip',
      // Archives are immutable and content-addressed by path; a random suffix
      // would make the manifest path unreproducible.
      addRandomSuffix: false,
    });
    this.urls.set(objectPath, result.url);
    return { path: objectPath, size: body.byteLength, url: result.url };
  }

  async get(objectPath: string): Promise<Buffer> {
    const url = this.urls.get(objectPath) ?? (await this.lookupUrl(objectPath));
    if (!url) throw new Error(`archive object not found: ${objectPath}`);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to read archive ${objectPath}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async exists(objectPath: string): Promise<boolean> {
    return (await this.lookupUrl(objectPath)) !== null;
  }

  private async lookupUrl(objectPath: string): Promise<string | null> {
    const { head } = await import('@vercel/blob');
    try {
      const meta = await head(objectPath, { token: this.token });
      if (meta?.url) this.urls.set(objectPath, meta.url);
      return meta?.url ?? null;
    } catch {
      return null;
    }
  }
}

export interface StoreSelection {
  store: ArchiveStore;
  /** False when the backend cannot be trusted to outlive the process. */
  durable: boolean;
}

/**
 * Chooses a backend.
 *
 * On Vercel a local directory is NOT durable, so falling back to it there would
 * quietly produce archives that vanish -- and the retention job would then drop
 * partitions believing they were safe. That combination must be impossible.
 */
export function selectArchiveStore(opts: {
  blobToken: string;
  mode: 'daemon' | 'vercel_rolling';
  localRoot?: string;
}): StoreSelection {
  if (opts.blobToken) {
    return { store: new VercelBlobStore(opts.blobToken), durable: true };
  }

  if (opts.mode === 'vercel_rolling') {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is required in vercel_rolling mode: a function filesystem ' +
        'is not durable, so a local archive would be lost and retention could then drop ' +
        'partitions that were never really archived.',
    );
  }

  const root = opts.localRoot ?? path.join(process.cwd(), '.archive');
  logger.warn(
    { event: 'archive_store_local', root },
    'no BLOB_READ_WRITE_TOKEN; archiving to the local filesystem',
  );
  return { store: new LocalArchiveStore(root), durable: true };
}

export function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}
