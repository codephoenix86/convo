import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';

const LOCAL_STORAGE_ROUTE = '/attachments/local';

export function createLocalObjectStorage({ directory, expiresIn, signingSecret, now = Date.now }) {
  const rootDirectory = resolve(directory);

  return {
    driver: 'local',

    async createUploadUrl({ storageKey, mimeType, size, metadata }) {
      const token = createToken(
        { operation: 'upload', storageKey, mimeType, size, metadata },
        expiresIn,
        signingSecret,
        now,
      );

      return {
        method: 'PUT',
        url: `${LOCAL_STORAGE_ROUTE}/upload?token=${token}`,
        headers: { 'content-type': mimeType },
        expiresIn,
      };
    },

    async inspectObject(storageKey) {
      try {
        const paths = resolveStoragePaths(rootDirectory, storageKey);
        const [fileStats, serializedMetadata] = await Promise.all([
          stat(paths.object),
          readFile(paths.metadata, 'utf8'),
        ]);
        const storedMetadata = JSON.parse(serializedMetadata);

        if (!fileStats.isFile() || !isStoredMetadata(storedMetadata)) {
          return null;
        }

        return {
          mimeType: storedMetadata.mimeType,
          size: fileStats.size,
          metadata: storedMetadata.metadata ?? {},
        };
      } catch (error) {
        if (
          error?.code === 'ENOENT' ||
          error instanceof SyntaxError ||
          error instanceof ForbiddenError
        ) {
          return null;
        }

        throw error;
      }
    },

    async createDownloadUrl(storageKey) {
      const token = createToken(
        { operation: 'download', storageKey },
        expiresIn,
        signingSecret,
        now,
      );

      return { url: `${LOCAL_STORAGE_ROUTE}/download?token=${token}`, expiresIn };
    },

    async storeUpload(token, { body, mimeType }) {
      const payload = verifyToken(token, 'upload', signingSecret, now);

      if (!Buffer.isBuffer(body) || body.length !== payload.size || mimeType !== payload.mimeType) {
        throw new ValidationError('Uploaded file does not match the initialized upload');
      }

      const paths = resolveStoragePaths(rootDirectory, payload.storageKey);
      const temporarySuffix = `.tmp-${randomUUID()}`;
      const temporaryObject = `${paths.object}${temporarySuffix}`;
      const temporaryMetadata = `${paths.metadata}${temporarySuffix}`;
      await mkdir(paths.parent, { recursive: true });

      try {
        await writeFile(temporaryObject, body, { flag: 'wx' });
        await writeFile(
          temporaryMetadata,
          JSON.stringify({ mimeType: payload.mimeType, metadata: payload.metadata }),
          { flag: 'wx' },
        );
        await rename(temporaryObject, paths.object);
        await rename(temporaryMetadata, paths.metadata);
      } catch (error) {
        await Promise.allSettled([
          rm(temporaryObject, { force: true }),
          rm(temporaryMetadata, { force: true }),
        ]);
        throw error;
      }
    },

    async readDownload(token) {
      const payload = verifyToken(token, 'download', signingSecret, now);
      const paths = resolveStoragePaths(rootDirectory, payload.storageKey);

      try {
        const [body, serializedMetadata] = await Promise.all([
          readFile(paths.object),
          readFile(paths.metadata, 'utf8'),
        ]);
        const storedMetadata = JSON.parse(serializedMetadata);

        if (!isStoredMetadata(storedMetadata)) {
          throw new NotFoundError('Stored attachment not found');
        }

        return { body, mimeType: storedMetadata.mimeType };
      } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
          throw new NotFoundError('Stored attachment not found');
        }

        throw error;
      }
    },
  };
}

function createToken(payload, expiresIn, signingSecret, now) {
  const expiresAt = Math.floor(now() / 1000) + expiresIn;
  const encodedPayload = Buffer.from(JSON.stringify({ ...payload, expiresAt })).toString(
    'base64url',
  );
  const signature = sign(encodedPayload, signingSecret);

  return `${encodedPayload}.${signature}`;
}

function verifyToken(token, operation, signingSecret, now) {
  if (typeof token !== 'string') {
    throw new ForbiddenError('Invalid or expired storage URL');
  }

  const [encodedPayload, suppliedSignature, extra] = token.split('.');
  const expectedSignature = encodedPayload ? sign(encodedPayload, signingSecret) : '';

  if (
    extra !== undefined ||
    !encodedPayload ||
    !suppliedSignature ||
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))
  ) {
    throw new ForbiddenError('Invalid or expired storage URL');
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

    if (payload.operation !== operation || payload.expiresAt <= Math.floor(now() / 1000)) {
      throw new ForbiddenError('Invalid or expired storage URL');
    }

    resolveStoragePaths('/', payload.storageKey);
    return payload;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw error;
    }

    throw new ForbiddenError('Invalid or expired storage URL');
  }
}

function sign(value, signingSecret) {
  return createHmac('sha256', signingSecret).update(value).digest('base64url');
}

function resolveStoragePaths(rootDirectory, storageKey) {
  if (
    typeof storageKey !== 'string' ||
    storageKey.length === 0 ||
    storageKey.includes('\0') ||
    storageKey.includes('\\') ||
    storageKey.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new ForbiddenError('Invalid storage key');
  }

  const objectPath = resolve(rootDirectory, storageKey);
  const relativePath = relative(rootDirectory, objectPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new ForbiddenError('Invalid storage key');
  }

  return {
    object: objectPath,
    metadata: `${objectPath}.metadata.json`,
    parent: resolve(objectPath, '..'),
  };
}

function isStoredMetadata(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.mimeType === 'string' &&
    value.metadata !== null &&
    typeof value.metadata === 'object'
  );
}
