import { describe, expect, it, vi } from 'vitest';

import { createS3ObjectStorage } from '../../src/config/object-storage.js';

describe('S3-compatible object storage', () => {
  it('signs a bounded PUT command without uploading bytes through the API', async () => {
    const client = { name: 'fixture-client' };
    const sign = vi.fn().mockResolvedValue('https://storage.example.com/signed-upload');
    const storage = createS3ObjectStorage({
      client,
      bucket: 'convo-attachments',
      expiresIn: 300,
      sign,
    });
    const metadata = {
      'conversation-id': 'conversation-id',
      'uploader-id': 'user-id',
      'declared-size': '1024',
    };

    const result = await storage.createUploadUrl({
      storageKey: 'conversations/conversation-id/users/user-id/upload.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      metadata,
    });

    expect(sign).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        input: {
          Bucket: 'convo-attachments',
          Key: 'conversations/conversation-id/users/user-id/upload.pdf',
          ContentType: 'application/pdf',
          ContentLength: 1024,
          Metadata: metadata,
        },
      }),
      {
        expiresIn: 300,
        signableHeaders: new Set(['content-type']),
      },
    );
    expect(result).toEqual({
      method: 'PUT',
      url: 'https://storage.example.com/signed-upload',
      headers: { 'content-type': 'application/pdf' },
      expiresIn: 300,
    });
  });

  it('inspects uploaded metadata and maps a missing object to null', async () => {
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          ContentType: 'image/png',
          ContentLength: 2048,
          Metadata: { 'uploader-id': 'user-id' },
        })
        .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } }),
    };
    const storage = createS3ObjectStorage({
      client,
      bucket: 'convo-attachments',
      expiresIn: 300,
      sign: vi.fn(),
    });

    await expect(storage.inspectObject('uploaded.png')).resolves.toEqual({
      mimeType: 'image/png',
      size: 2048,
      metadata: { 'uploader-id': 'user-id' },
    });
    await expect(storage.inspectObject('missing.png')).resolves.toBeNull();
    expect(client.send.mock.calls[0][0]).toMatchObject({
      input: { Bucket: 'convo-attachments', Key: 'uploaded.png' },
    });
  });

  it('signs private downloads without fetching object bytes through the API', async () => {
    const client = { name: 'fixture-client' };
    const sign = vi.fn().mockResolvedValue('https://storage.example.com/signed-download');
    const storage = createS3ObjectStorage({
      client,
      bucket: 'convo-attachments',
      expiresIn: 300,
      sign,
    });

    await expect(storage.createDownloadUrl('private/file.pdf')).resolves.toEqual({
      url: 'https://storage.example.com/signed-download',
      expiresIn: 300,
    });
    expect(sign).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        input: { Bucket: 'convo-attachments', Key: 'private/file.pdf' },
      }),
      { expiresIn: 300 },
    );
  });
});
