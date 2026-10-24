import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { S3Client, GetBucketPolicyCommand, PutObjectCommand, GetObjectCommand, GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, ListObjectsV2Command, DeleteObjectsCommand, type LifecycleRule } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const MEDIA_TTL_SECONDS = 24 * 60 * 60;
export const MEDIA_PREFIX = 'media/';
const lifecycleId = 'fridgeai-media-24h';
export function storageConfig(env = process.env) {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) throw Object.assign(new Error('Configure Hetzner object storage on the Pi.'), { status: 503 });
  const endpoint = new URL(S3_ENDPOINT);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.your-objectstorage.com') || endpoint.username || endpoint.password) throw Object.assign(new Error('S3_ENDPOINT must be a Hetzner HTTPS endpoint.'), { status: 503 });
  return { endpoint: endpoint.origin, bucket: S3_BUCKET, region: env.S3_REGION ?? 'fsn1', credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } };
}
export type StorageConfig = ReturnType<typeof storageConfig>;
export function storageClient(config: StorageConfig) {
  return new S3Client({ ...config, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}
export function mediaLifecycleRules(existing: LifecycleRule[] = []): LifecycleRule[] {
  return [...existing.filter(rule => rule.ID !== lifecycleId), {
    ID: lifecycleId, Status: 'Enabled', Filter: { Prefix: MEDIA_PREFIX },
    Expiration: { Days: 1 }, NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  }];
}
export async function ensureMediaLifecycle(client: S3Client, bucket: string, signal?: AbortSignal) {
  let rules: LifecycleRule[] = [];
  try { rules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }), { abortSignal: signal })).Rules ?? []; }
  catch (error) { if ((error as { name?: string }).name !== 'NoSuchLifecycleConfiguration') throw error; }
  const desired = mediaLifecycleRules(rules);
  const current = rules.find(r => r.ID === lifecycleId);
  if (current?.Status !== 'Enabled' || current.Filter?.Prefix !== MEDIA_PREFIX || current.Expiration?.Days !== 1 || current.NoncurrentVersionExpiration?.NoncurrentDays !== 1 || current.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== 1) {
    await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: desired } }), { abortSignal: signal });
  }
}
export function bucketAllowsPublicReads(policy: { Statement?: Array<Record<string, unknown>> }) {
  return (policy.Statement ?? []).some(statement => {
    const principal = statement.Principal;
    const aws = principal && typeof principal === 'object' ? (principal as { AWS?: unknown }).AWS : undefined;
    const publicPrincipal = principal === '*' || aws === '*' || (Array.isArray(aws) && aws.includes('*'));
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return statement.Effect === 'Allow' && publicPrincipal && actions.some(action => ['*', 's3:*', 's3:GetObject', 's3:GetObjectVersion'].includes(String(action)));
  });
}
export async function ensureMediaPrivacy(client: S3Client, bucket: string, signal?: AbortSignal) {
  try {
    const response = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }), { abortSignal: signal });
    if (bucketAllowsPublicReads(JSON.parse(response.Policy ?? '{}'))) throw new Error('Media bucket must not allow public reads.');
  } catch (error) { if ((error as { name?: string }).name !== 'NoSuchBucketPolicy') throw error; }
}
export async function uploadMedia(path: string, signal: AbortSignal, config = storageConfig()): Promise<string> {
  const client = storageClient(config);
  try {
    await ensureMediaLifecycle(client, config.bucket, signal);
    await ensureMediaPrivacy(client, config.bucket, signal);
    const key = `${MEDIA_PREFIX}${randomUUID()}.mp4`;
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: createReadStream(path),
      ContentLength: (await stat(path)).size, ContentType: 'video/mp4', ACL: 'private',
      Metadata: { 'retention-seconds': String(MEDIA_TTL_SECONDS) },
    }), { abortSignal: signal });
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: MEDIA_TTL_SECONDS });
  } catch {
    throw Object.assign(new Error('Hetzner media upload failed. Check storage credentials, bucket access, policy and lifecycle permissions.'), { status: 502 });
  } finally { client.destroy(); }
}
export async function deleteExpiredMedia(client: S3Client, bucket: string, now = Date.now(), signal?: AbortSignal) {
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: MEDIA_PREFIX, ContinuationToken: token }), { abortSignal: signal });
    const expired = (page.Contents ?? []).filter(item => item.Key?.startsWith(MEDIA_PREFIX) && item.LastModified && item.LastModified.getTime() + MEDIA_TTL_SECONDS * 1000 <= now).map(item => ({ Key: item.Key! }));
    if (expired.length) {
      const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: expired, Quiet: true } }), { abortSignal: signal });
      if (result.Errors?.length) throw new Error('Some expired media could not be deleted.');
      deleted += expired.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}
// Listing S3 makes expiry survive Pi restarts without writing to the inventory database.
export function startMediaCleanup() {
  let pending: Promise<void> | undefined;
  const controller = new AbortController();
  const sweep = () => {
    if (pending || !process.env.S3_BUCKET || controller.signal.aborted) return;
    pending = (async () => {
      let client: S3Client | undefined;
      try {
        const config = storageConfig(); client = storageClient(config);
        await deleteExpiredMedia(client, config.bucket, Date.now(), AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      } catch { if (!controller.signal.aborted) console.error('Expired media cleanup failed; Hetzner lifecycle expiration remains the fallback.'); }
      finally { client?.destroy(); }
    })().finally(() => { pending = undefined; });
  };
  sweep();
  const timer = setInterval(sweep, 60_000); timer.unref();
  return async () => { clearInterval(timer); controller.abort(); await pending; };
}
