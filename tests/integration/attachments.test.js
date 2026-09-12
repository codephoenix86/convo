import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const userId = randomUUID();
const conversationId = randomUUID();
const accessClaims = { userId, sessionId: randomUUID(), tokenId: randomUUID() };
const upload = {
  storageKey: `conversations/${conversationId}/users/${userId}/${randomUUID()}.png`,
  method: 'PUT',
  url: 'https://storage.example.com/signed-upload',
  headers: { 'content-type': 'image/png' },
  expiresAt: new Date('2026-09-10T14:05:00.000Z'),
};

function createAuthenticatedApp(attachments) {
  return createApp({
    attachments,
    accessTokenVerifier: vi.fn().mockResolvedValue(accessClaims),
  });
}

describe('POST /attachments/upload-init', () => {
  it('returns a signed upload contract for validated metadata', async () => {
    const attachments = { initializeUpload: vi.fn().mockResolvedValue(upload) };

    const response = await request(createAuthenticatedApp(attachments))
      .post('/attachments/upload-init')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        conversationId,
        fileName: '  photo.PNG  ',
        mimeType: 'image/png',
        size: 2048,
      })
      .expect(200);

    expect(attachments.initializeUpload).toHaveBeenCalledWith(userId, {
      conversationId,
      fileName: 'photo.PNG',
      mimeType: 'image/png',
      size: 2048,
    });
    expect(response.body.data.upload).toMatchObject({
      storageKey: upload.storageKey,
      method: 'PUT',
      url: upload.url,
      expiresAt: upload.expiresAt.toISOString(),
    });
  });

  it('rejects invalid metadata and unknown fields before service logic', async () => {
    const attachments = { initializeUpload: vi.fn() };
    const app = createAuthenticatedApp(attachments);

    await request(app)
      .post('/attachments/upload-init')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        conversationId,
        fileName: 'payload.exe',
        mimeType: 'application/octet-stream',
        size: 100,
      })
      .expect(400);
    await request(app)
      .post('/attachments/upload-init')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        conversationId,
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 100,
        userId,
      })
      .expect(400);

    expect(attachments.initializeUpload).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const attachments = { initializeUpload: vi.fn() };

    await request(createApp({ attachments }))
      .post('/attachments/upload-init')
      .send({ conversationId, fileName: 'photo.png', mimeType: 'image/png', size: 100 })
      .expect(401);

    expect(attachments.initializeUpload).not.toHaveBeenCalled();
  });
});

describe('GET /attachments/:id/content', () => {
  it('redirects an authorized download without exposing storage credentials', async () => {
    const attachmentId = randomUUID();
    const attachments = {
      initializeUpload: vi.fn(),
      createDownload: vi.fn().mockResolvedValue({
        url: 'https://storage.example.com/signed-download',
        expiresIn: 300,
      }),
    };

    const response = await request(createAuthenticatedApp(attachments))
      .get(`/attachments/${attachmentId}/content`)
      .set('authorization', 'Bearer valid-access-token')
      .expect(307);

    expect(attachments.createDownload).toHaveBeenCalledWith(userId, attachmentId);
    expect(response.headers.location).toBe('https://storage.example.com/signed-download');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects malformed IDs and unauthenticated downloads before service logic', async () => {
    const attachments = { initializeUpload: vi.fn(), createDownload: vi.fn() };

    await request(createAuthenticatedApp(attachments))
      .get('/attachments/not-a-uuid/content')
      .set('authorization', 'Bearer valid-access-token')
      .expect(400);
    await request(createApp({ attachments }))
      .get(`/attachments/${randomUUID()}/content`)
      .expect(401);

    expect(attachments.createDownload).not.toHaveBeenCalled();
  });
});

describe('local attachment transport', () => {
  it('accepts signed upload bytes and serves signed downloads without authentication', async () => {
    const attachmentStorage = {
      driver: 'local',
      storeUpload: vi.fn().mockResolvedValue(undefined),
      readDownload: vi.fn().mockResolvedValue({
        body: Buffer.from('hello'),
        mimeType: 'text/plain',
      }),
    };
    const app = createApp({
      attachments: { initializeUpload: vi.fn(), createDownload: vi.fn() },
      attachmentStorage,
    });

    await request(app)
      .put('/attachments/local/upload?token=signed-upload-token')
      .set('content-type', 'text/plain')
      .send('hello')
      .expect(204);

    expect(attachmentStorage.storeUpload).toHaveBeenCalledWith('signed-upload-token', {
      body: Buffer.from('hello'),
      mimeType: 'text/plain',
    });

    const response = await request(app)
      .get('/attachments/local/download?token=signed-download-token')
      .expect(200)
      .expect('content-type', /^text\/plain/u);

    expect(attachmentStorage.readDownload).toHaveBeenCalledWith('signed-download-token');
    expect(response.text).toBe('hello');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});
