import { constants, createPrivateKey, createSign, type KeyObject } from 'node:crypto';

/**
 * Kalshi API-key authentication.
 *
 * Each request is signed with RSA-PSS over:
 *
 *     <timestamp_ms><HTTP_METHOD><path>
 *
 * where `path` is the request path WITHOUT the query string, and the signature
 * uses MGF1-SHA256 with a salt length equal to the digest length (32 bytes).
 *
 * Nothing in this module is ever logged. `describeKey()` is the only
 * externally visible description of the key material.
 */

export const KALSHI_ACCESS_KEY_HEADER = 'KALSHI-ACCESS-KEY';
export const KALSHI_ACCESS_SIGNATURE_HEADER = 'KALSHI-ACCESS-SIGNATURE';
export const KALSHI_ACCESS_TIMESTAMP_HEADER = 'KALSHI-ACCESS-TIMESTAMP';

const PEM_HEADER_RE = /-----BEGIN (RSA )?PRIVATE KEY-----/;

export class KalshiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KalshiAuthError';
  }
}

/**
 * Normalises the many shapes a PEM takes once it has been through an
 * environment variable.
 *
 * Accepted, in order:
 *   1. base64 of the entire PEM file (recommended for Vercel, whose env vars
 *      are single-line)
 *   2. the PEM with literal backslash-n two-character sequences
 *   3. a genuine multi-line PEM
 *
 * Surrounding quotes, CRLF line endings and stray whitespace are tolerated
 * because all three survive a round-trip through some deployment UI somewhere.
 */
export function normalizePrivateKeyPem(raw: string): string {
  if (!raw || raw.trim() === '') {
    throw new KalshiAuthError('KALSHI_PRIVATE_KEY_PEM is empty');
  }

  let value = raw.trim();

  // Strip a single layer of wrapping quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  // Form 1: base64 of the whole file.
  if (!PEM_HEADER_RE.test(value)) {
    const compact = value.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
      const decoded = Buffer.from(compact, 'base64').toString('utf8');
      if (PEM_HEADER_RE.test(decoded)) value = decoded;
    }
  }

  // Form 2: escaped newlines.
  if (value.includes('\\n')) value = value.replace(/\\r/g, '').replace(/\\n/g, '\n');

  value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  if (!PEM_HEADER_RE.test(value)) {
    throw new KalshiAuthError(
      'KALSHI_PRIVATE_KEY_PEM does not contain a PEM private key. Provide the ' +
        'PKCS#8 PEM directly, with \\n escapes, or base64-encoded.',
    );
  }

  return value.endsWith('\n') ? value : `${value}\n`;
}

export function loadPrivateKey(rawPem: string): KeyObject {
  const pem = normalizePrivateKeyPem(rawPem);
  try {
    return createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    throw new KalshiAuthError(
      `Failed to parse Kalshi private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The exact string Kalshi signs. Query strings are deliberately excluded --
 * including them produces a signature the API rejects.
 */
export function signaturePreimage(timestampMs: number | string, method: string, path: string): string {
  return `${timestampMs}${method.toUpperCase()}${stripQuery(path)}`;
}

function stripQuery(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

export interface KalshiSignature {
  key: string;
  signature: string;
  timestamp: string;
}

export class KalshiSigner {
  private readonly privateKey: KeyObject;

  constructor(
    readonly apiKeyId: string,
    privateKeyPem: string,
  ) {
    if (!apiKeyId || apiKeyId.trim() === '') {
      throw new KalshiAuthError('KALSHI_API_KEY_ID is empty');
    }
    this.privateKey = loadPrivateKey(privateKeyPem);
  }

  sign(method: string, path: string, timestampMs: number = Date.now()): KalshiSignature {
    const ts = String(timestampMs);
    const preimage = signaturePreimage(ts, method, path);

    const signer = createSign('sha256');
    signer.update(preimage, 'utf8');
    signer.end();

    const signature = signer.sign({
      key: this.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32, // equal to the SHA-256 digest length
    });

    return { key: this.apiKeyId, signature: signature.toString('base64'), timestamp: ts };
  }

  headers(method: string, path: string, timestampMs?: number): Record<string, string> {
    const { key, signature, timestamp } = this.sign(method, path, timestampMs);
    return {
      [KALSHI_ACCESS_KEY_HEADER]: key,
      [KALSHI_ACCESS_SIGNATURE_HEADER]: signature,
      [KALSHI_ACCESS_TIMESTAMP_HEADER]: timestamp,
    };
  }

  /** Safe-to-log description. Never exposes key material. */
  describeKey(): { apiKeyIdPrefix: string; keyType: string; modulusBits: number | null } {
    const details = this.privateKey.asymmetricKeyDetails;
    return {
      apiKeyIdPrefix: `${this.apiKeyId.slice(0, 8)}…`,
      keyType: this.privateKey.asymmetricKeyType ?? 'unknown',
      modulusBits: details?.modulusLength ?? null,
    };
  }
}
