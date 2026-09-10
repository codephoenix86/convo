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
      url: 'https://storage.example.com/signed-upload',
      expiresIn: 300,
    });
  });
});
