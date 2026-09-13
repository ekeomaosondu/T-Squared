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
  readonly kind = 'vercel-blob-private';
  private readonly urls = new Map<string, string>();

  constructor(private readonly token: string) {}

  async put(objectPath: string, body: Buffer): Promise<StoredObject> {
    const { put } = await import('@vercel/blob');
    const result = await put(objectPath, body, {
      // PRIVATE. This is a proprietary dataset; a public archive would expose
      // the entire order-book history to anyone with the URL.
      access: 'private',
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

/**
 * S3-compatible object storage: Cloudflare R2 or AWS S3.
 *
 * R2 is the intended target for the research lake. It charges no egress, which
 * matters enormously when the workflow is repeatedly scanning Parquet from a
 * workstation with DuckDB, and its S3 API means DuckDB can read directly from
 * it without a separate download step.
 */
export class S3ArchiveStore implements ArchiveStore {
  readonly kind: string;
  private client: import('@aws-sdk/client-s3').S3Client | null = null;

  constructor(
    private readonly opts: {
      bucket: string;
      endpoint?: string;
      region?: string;
      accessKeyId: string;
      secretAccessKey: string;
      flavour?: 'r2' | 's3';
    },
  ) {
    this.kind = opts.flavour ?? (opts.endpoint?.includes('r2.cloudflarestorage.com') ? 'r2' : 's3');
  }

  private async getClient() {
    if (this.client) return this.client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.client = new S3Client({
      // R2 ignores region but the SDK requires one.
      region: this.opts.region || 'auto',
      endpoint: this.opts.endpoint || undefined,
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
      },
      // R2 does not support virtual-hosted-style addressing for all setups.
      forcePathStyle: true,
    });
    return this.client;
  }

  async put(objectPath: string, body: Buffer): Promise<StoredObject> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: objectPath,
        Body: body,
        ContentType: 'application/gzip',
        // Integrity is verified independently by re-reading and hashing, but
        // this lets the service reject a corrupted upload outright.
        ChecksumSHA256: sha256(body).toString('base64'),
      }),
    );
    return { path: objectPath, size: body.byteLength };
  }

  async get(objectPath: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: objectPath }),
    );
    if (!res.Body) throw new Error(`empty object: ${objectPath}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async exists(objectPath: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: objectPath }));
      return true;
    } catch {
      return false;
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
  storage?: 'r2' | 's3' | 'vercel_blob' | 'local';
  s3?: {
    bucket: string;
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}): StoreSelection {
  const storage = opts.storage ?? (opts.blobToken ? 'vercel_blob' : 'local');

  if (storage === 'r2' || storage === 's3') {
    const s3 = opts.s3;
    if (!s3?.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
      throw new Error(
        `ARCHIVE_STORAGE=${storage} requires ARCHIVE_BUCKET, ARCHIVE_ACCESS_KEY_ID and ` +
          'ARCHIVE_SECRET_ACCESS_KEY. Without them the archive has nowhere durable to go, ' +
          'and retention must never run against an archive that does not exist.',
      );
    }
    return { store: new S3ArchiveStore({ ...s3, flavour: storage }), durable: true };
  }

  if (storage === 'vercel_blob' || opts.blobToken) {
    if (!opts.blobToken) {
      throw new Error('ARCHIVE_STORAGE=vercel_blob requires BLOB_READ_WRITE_TOKEN');
    }
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
