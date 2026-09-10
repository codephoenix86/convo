import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from './env.js';

export function createS3ObjectStorage({ client, bucket, expiresIn, sign = getSignedUrl }) {
  return {
    async createUploadUrl({ storageKey, mimeType, size, metadata }) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        ContentType: mimeType,
        ContentLength: size,
        Metadata: metadata,
      });
      const url = await sign(client, command, {
        expiresIn,
        signableHeaders: new Set(['content-type']),
      });

      return { url, expiresIn };
    },

    async inspectObject(storageKey) {
      try {
        const object = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: storageKey,
          }),
        );

        return {
          mimeType: object.ContentType,
          size: object.ContentLength,
          metadata: object.Metadata ?? {},
        };
      } catch (error) {
        if (isObjectNotFoundError(error)) {
          return null;
        }

        throw error;
      }
    },

    async createDownloadUrl(storageKey) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
      });
      const url = await sign(client, command, { expiresIn });

      return { url, expiresIn };
    },
  };
}

function isObjectNotFoundError(error) {
  return (
    ['NotFound', 'NoSuchKey'].includes(error?.name) || error?.$metadata?.httpStatusCode === 404
  );
}

const client = new S3Client({
  region: env.OBJECT_STORAGE_REGION,
  ...(env.OBJECT_STORAGE_ENDPOINT ? { endpoint: env.OBJECT_STORAGE_ENDPOINT } : {}),
  forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  },
});

export const objectStorage = createS3ObjectStorage({
  client,
  bucket: env.OBJECT_STORAGE_BUCKET,
  expiresIn: env.OBJECT_STORAGE_PRESIGN_TTL_SECONDS,
});
