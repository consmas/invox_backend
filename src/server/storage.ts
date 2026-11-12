import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ApiError } from './errors';

/**
 * Private document storage. `s3` (DigitalOcean Spaces, AWS S3 or any S3-compatible store) is shared by every
 * backend instance and survives redeploys; `local` is a directory and is only safe for a single instance with
 * a persistent volume. Production refuses to store documents until one of them is configured (F13).
 */
type Driver = {
  put(key: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<void>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  remove(key: string): Promise<void>;
};
const KEY = /^[a-f0-9-]{36}$/;
function checked(key: string) { if (!KEY.test(key)) throw new ApiError(404, 'Document not found'); return key; }

function localDriver(): Driver {
  if (process.env.NODE_ENV === 'production' && !process.env.DOCUMENT_STORAGE_PATH) throw new ApiError(503, 'Persistent private document storage is not configured');
  const root = process.env.DOCUMENT_STORAGE_PATH || resolve(process.cwd(), '.local-documents');
  return {
    async put(key, bytes) { await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(resolve(root, checked(key)), bytes, { mode: 0o600, flag: 'wx' }); },
    async stream(key) { const file = resolve(root, checked(key)); await stat(file); return Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>; },
    async remove(key) { await unlink(resolve(root, checked(key))).catch(() => undefined); },
  };
}
let client: S3Client | undefined;
function s3Driver(): Driver {
  const bucket = process.env.S3_BUCKET;
  if (!bucket || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) throw new ApiError(503, 'Document object storage is not configured');
  client ??= new S3Client({
    region: process.env.S3_REGION || 'us-east-1', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    // S3-compatible stores such as DigitalOcean Spaces do not all accept the SDK's default flexible checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  });
  const prefix = (process.env.S3_PREFIX ?? 'documents/').replace(/^\/+/, '');
  return {
    async put(key, bytes, contentType, sha256) {
      // Objects are private (no public ACL grant); the content hash is also kept in the database record.
      await client!.send(new PutObjectCommand({ Bucket: bucket, Key: prefix + checked(key), Body: bytes, ContentType: contentType, ACL: 'private', Metadata: { sha256 } }));
    },
    async stream(key) {
      const result = await client!.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + checked(key) }));
      if (!result.Body) throw new ApiError(404, 'Document not found');
      return result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    },
    async remove(key) { await client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + checked(key) })).catch(() => undefined); },
  };
}
export function documentStorage(): Driver {
  return process.env.DOCUMENT_STORAGE_DRIVER === 's3' ? s3Driver() : localDriver();
}
