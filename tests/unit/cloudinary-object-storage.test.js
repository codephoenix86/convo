import { describe, expect, it, vi } from 'vitest';

import { createCloudinaryObjectStorage } from '../../src/config/cloudinary-object-storage.js';

const storageKey = 'conversations/conversation-id/users/user-id/upload.pdf';
const now = new Date('2026-09-12T12:00:00.000Z');

function createFixture() {
  const api = { resource: vi.fn() };
  const utils = {
    api_sign_request: vi.fn().mockReturnValue('upload-signature'),
    private_download_url: vi.fn().mockReturnValue('https://cloudinary.example/signed-download'),
  };
  const storage = createCloudinaryObjectStorage({
    cloudName: 'convo-cloud',
    apiKey: 'cloudinary-key',
    apiSecret: 'cloudinary-secret',
    downloadExpiresIn: 300,
    api,
    utils,
    now: () => now.getTime(),
  });

  return { api, utils, storage };
}

describe('Cloudinary object storage', () => {
  it('creates a signed multipart upload without exposing the API secret', async () => {
    const fixture = createFixture();
    const metadata = {
      'conversation-id': 'conversation-id',
      'uploader-id': 'user-id',
      'declared-size': '1024',
    };

    const upload = await fixture.storage.createUploadUrl({
      storageKey,
      mimeType: 'application/pdf',
      size: 1024,
      metadata,
    });

    const signedFields = {
      context:
        'conversation-id=conversation-id|uploader-id=user-id|declared-size=1024|mime-type=application/pdf',
      overwrite: 'false',
      public_id: storageKey,
      timestamp: '1789214400',
      type: 'authenticated',
    };
    expect(fixture.utils.api_sign_request).toHaveBeenCalledWith(signedFields, 'cloudinary-secret');
    expect(upload).toEqual({
      method: 'POST',
      url: 'https://api.cloudinary.com/v1_1/convo-cloud/raw/upload',
      headers: {},
      formFields: {
        ...signedFields,
        api_key: 'cloudinary-key',
        signature: 'upload-signature',
      },
      expiresIn: 3600,
    });
    expect(JSON.stringify(upload)).not.toContain('cloudinary-secret');
  });

  it('inspects private resource metadata and maps a missing object to null', async () => {
    const fixture = createFixture();
    fixture.api.resource
      .mockResolvedValueOnce({
        bytes: 1024,
        context: {
          custom: {
            'conversation-id': 'conversation-id',
            'uploader-id': 'user-id',
            'declared-size': '1024',
            'mime-type': 'application/pdf',
          },
        },
      })
      .mockRejectedValueOnce({ http_code: 404 });

    await expect(fixture.storage.inspectObject(storageKey)).resolves.toEqual({
      mimeType: 'application/pdf',
      size: 1024,
      metadata: {
        'conversation-id': 'conversation-id',
        'uploader-id': 'user-id',
        'declared-size': '1024',
      },
    });
    await expect(fixture.storage.inspectObject('missing.pdf')).resolves.toBeNull();
    expect(fixture.api.resource).toHaveBeenCalledWith(storageKey, {
      cloud_name: 'convo-cloud',
      api_key: 'cloudinary-key',
      api_secret: 'cloudinary-secret',
      resource_type: 'raw',
      type: 'authenticated',
    });
  });

  it('creates an expiring authenticated download URL', async () => {
    const fixture = createFixture();

    await expect(fixture.storage.createDownloadUrl(storageKey)).resolves.toEqual({
      url: 'https://cloudinary.example/signed-download',
      expiresIn: 300,
    });
    expect(fixture.utils.private_download_url).toHaveBeenCalledWith(storageKey, undefined, {
      cloud_name: 'convo-cloud',
      api_key: 'cloudinary-key',
      api_secret: 'cloudinary-secret',
      resource_type: 'raw',
      type: 'authenticated',
      timestamp: 1789214400,
      expires_at: 1789214700,
    });
  });
});
