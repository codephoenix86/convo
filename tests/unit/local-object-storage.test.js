import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ForbiddenError, ValidationError } from '../../src/lib/errors.js';
import { createLocalObjectStorage } from '../../src/config/local-object-storage.js';

const signingSecret = 'local-storage-test-signing-secret-value';
const storageKey = 'conversations/conversation-id/users/user-id/upload.txt';
const metadata = {
  'conversation-id': 'conversation-id',
  'uploader-id': 'user-id',
  'declared-size': '5',
};
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createFixture(now = () => Date.parse('2026-09-11T12:00:00.000Z')) {
  const directory = await mkdtemp(join(tmpdir(), 'convo-storage-test-'));
  directories.push(directory);

  return {
    directory,
    storage: createLocalObjectStorage({ directory, expiresIn: 300, signingSecret, now }),
  };
}

describe('local object storage', () => {
  it('stores, inspects, and downloads an object through signed URLs', async () => {
    const { directory, storage } = await createFixture();
    const upload = await storage.createUploadUrl({
      storageKey,
      mimeType: 'text/plain',
      size: 5,
      metadata,
    });
    const uploadToken = new URL(upload.url, 'http://api.example').searchParams.get('token');

    await storage.storeUpload(uploadToken, {
      body: Buffer.from('hello'),
      mimeType: 'text/plain',
    });

    await expect(storage.inspectObject(storageKey)).resolves.toEqual({
      mimeType: 'text/plain',
      size: 5,
      metadata,
    });
    await expect(readFile(join(directory, storageKey), 'utf8')).resolves.toBe('hello');

    const download = await storage.createDownloadUrl(storageKey);
    const downloadToken = new URL(download.url, 'http://api.example').searchParams.get('token');
    await expect(storage.readDownload(downloadToken)).resolves.toEqual({
      body: Buffer.from('hello'),
      mimeType: 'text/plain',
    });
  });

  it('rejects bytes or content types that differ from the signed upload', async () => {
    const { storage } = await createFixture();
    const upload = await storage.createUploadUrl({
      storageKey,
      mimeType: 'text/plain',
      size: 5,
      metadata,
    });
    const token = new URL(upload.url, 'http://api.example').searchParams.get('token');

    await expect(
      storage.storeUpload(token, { body: Buffer.from('no'), mimeType: 'text/plain' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      storage.storeUpload(token, { body: Buffer.from('hello'), mimeType: 'image/png' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(storage.inspectObject(storageKey)).resolves.toBeNull();
  });

  it('rejects tampered and expired signed URLs', async () => {
    let currentTime = Date.parse('2026-09-11T12:00:00.000Z');
    const { storage } = await createFixture(() => currentTime);
    const download = await storage.createDownloadUrl(storageKey);
    const token = new URL(download.url, 'http://api.example').searchParams.get('token');

    await expect(storage.readDownload(`${token}tampered`)).rejects.toBeInstanceOf(ForbiddenError);
    currentTime += 301_000;
    await expect(storage.readDownload(token)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
