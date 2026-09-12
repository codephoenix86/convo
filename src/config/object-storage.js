import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { createCloudinaryObjectStorage } from './cloudinary-object-storage.js';
import { env } from './env.js';
import { createLocalObjectStorage } from './local-object-storage.js';

export { createCloudinaryObjectStorage } from './cloudinary-object-storage.js';

export function createS3ObjectStorage({ client, bucket, expiresIn, sign = getSignedUrl }) {
  return {
    driver: 's3',

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

      return {
        method: 'PUT',
        url,
        headers: { 'content-type': mimeType },
        expiresIn,
      };
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

export function createObjectStorage(configuration = env) {
  if (configuration.ATTACHMENT_STORAGE_DRIVER === 'local') {
    return createLocalObjectStorage({
      directory: configuration.LOCAL_STORAGE_DIRECTORY,
      expiresIn: configuration.LOCAL_STORAGE_URL_TTL_SECONDS,
      signingSecret: configuration.LOCAL_STORAGE_SIGNING_SECRET,
    });
  }

  if (configuration.ATTACHMENT_STORAGE_DRIVER === 'cloudinary') {
    return createCloudinaryObjectStorage({
      cloudName: configuration.CLOUDINARY_CLOUD_NAME,
      apiKey: configuration.CLOUDINARY_API_KEY,
      apiSecret: configuration.CLOUDINARY_API_SECRET,
      downloadExpiresIn: configuration.CLOUDINARY_DOWNLOAD_URL_TTL_SECONDS,
    });
  }

  const client = new S3Client({
    region: configuration.OBJECT_STORAGE_REGION,
    ...(configuration.OBJECT_STORAGE_ENDPOINT
      ? { endpoint: configuration.OBJECT_STORAGE_ENDPOINT }
      : {}),
    forcePathStyle: configuration.OBJECT_STORAGE_FORCE_PATH_STYLE,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: configuration.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: configuration.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    },
  });

  return createS3ObjectStorage({
    client,
    bucket: configuration.OBJECT_STORAGE_BUCKET,
    expiresIn: configuration.OBJECT_STORAGE_PRESIGN_TTL_SECONDS,
  });
}

export const objectStorage = createObjectStorage();
