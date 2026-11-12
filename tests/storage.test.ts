// Document storage against a real S3-compatible endpoint (DigitalOcean Spaces in production).
// Runs only when S3_TEST_ENDPOINT is set, e.g. a local s3rver/MinIO or a disposable Spaces bucket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { S3Client, HeadObjectCommand, GetObjectAclCommand } from '@aws-sdk/client-s3';

const endpoint = process.env.S3_TEST_ENDPOINT;
test('S3/Spaces driver stores privately, streams back intact and removes objects', { skip: !endpoint && 'S3_TEST_ENDPOINT not set' }, async () => {
  Object.assign(process.env, {
    DOCUMENT_STORAGE_DRIVER: 'spaces', S3_ENDPOINT: endpoint, S3_BUCKET: process.env.S3_TEST_BUCKET ?? 'invox-docs-test',
    S3_REGION: process.env.S3_TEST_REGION ?? 'us-east-1', S3_ACCESS_KEY_ID: process.env.S3_TEST_KEY ?? 'S3RVER', S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET ?? 'S3RVER',
    S3_FORCE_PATH_STYLE: process.env.S3_TEST_PATH_STYLE ?? 'true', S3_PREFIX: 'storage-test/',
  });
  const { documentStorage } = await import('../src/server/storage');
  const storage = documentStorage();
  const key = randomUUID();
  const bytes = new TextEncoder().encode('%PDF-1.4\nspaces storage test');
  const sha = createHash('sha256').update(bytes).digest('hex');
  await storage.put(key, bytes, 'application/pdf', sha);
  const stream = await storage.stream(key);
  const back = Buffer.from(await new Response(stream).arrayBuffer());
  assert.equal(createHash('sha256').update(back).digest('hex'), sha);
  const client = new S3Client({ region: process.env.S3_REGION, endpoint, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const head = await client.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `storage-test/${key}` }));
  assert.equal(head.ContentType, 'application/pdf');
  assert.equal(head.Metadata?.sha256, sha);
  // No public grant on the object (s3rver may not implement ACL reads; Spaces and AWS do).
  const acl = await client.send(new GetObjectAclCommand({ Bucket: process.env.S3_BUCKET, Key: `storage-test/${key}` })).catch(() => null);
  if (acl) assert.ok(!acl.Grants?.some(g => g.Grantee?.URI?.includes('AllUsers')), 'object must not be public');
  await assert.rejects(storage.stream('../../etc/passwd'));
  await storage.remove(key);
  await assert.rejects(storage.stream(key));
});
