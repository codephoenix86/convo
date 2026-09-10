import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import { createAttachmentsService } from '../../src/modules/attachments/attachments.service.js';
import { MAX_ATTACHMENT_BYTES } from '../../src/modules/attachments/attachments.validation.js';

const userId = randomUUID();
const conversationId = randomUUID();
const uploadId = randomUUID();
const now = new Date('2026-09-10T14:00:00.000Z');

function createFixture() {
  const accessRepository = {
    findAccessContext: vi.fn().mockResolvedValue({
      id: conversationId,
      members: [{ userId, role: 'MEMBER' }],
    }),
  };
  const storage = {
    createUploadUrl: vi.fn().mockResolvedValue({
      url: 'https://storage.example.com/signed-upload',
      expiresIn: 300,
    }),
  };
  const service = createAttachmentsService({
    accessRepository,
    storage,
    createId: () => uploadId,
    now: () => now,
  });

  return { accessRepository, storage, service };
}

describe('attachments service', () => {
  it('authorizes membership and signs a user-scoped upload', async () => {
    const fixture = createFixture();

    const upload = await fixture.service.initializeUpload(userId, {
      conversationId,
      fileName: '  Architecture.PDF  ',
      mimeType: 'application/pdf',
      size: 1024,
    });

    const storageKey = `conversations/${conversationId}/users/${userId}/${uploadId}.pdf`;
    expect(fixture.accessRepository.findAccessContext).toHaveBeenCalledWith(conversationId, [
      userId,
    ]);
    expect(fixture.storage.createUploadUrl).toHaveBeenCalledWith({
      storageKey,
      mimeType: 'application/pdf',
      size: 1024,
      metadata: {
        'conversation-id': conversationId,
        'uploader-id': userId,
        'declared-size': '1024',
      },
    });
    expect(upload).toEqual({
      storageKey,
      method: 'PUT',
      url: 'https://storage.example.com/signed-upload',
      headers: { 'content-type': 'application/pdf' },
      expiresAt: new Date('2026-09-10T14:05:00.000Z'),
    });
  });

  it('hides conversations from nonmembers before signing', async () => {
    const fixture = createFixture();
    fixture.accessRepository.findAccessContext.mockResolvedValue(null);

    await expect(
      fixture.service.initializeUpload(userId, {
        conversationId,
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 1024,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it.each([
    [{ fileName: 'photo.exe', mimeType: 'image/png', size: 1024 }, 'fileName'],
    [{ fileName: 'photo.png', mimeType: 'application/zip', size: 1024 }, 'mimeType'],
    [{ fileName: 'photo.png', mimeType: 'image/png', size: 0 }, 'size'],
    [{ fileName: 'photo.png', mimeType: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 }, 'size'],
  ])('rejects unsupported or unsafe metadata before authorization', async (metadata, field) => {
    const fixture = createFixture();

    await expect(
      fixture.service.initializeUpload(userId, { conversationId, ...metadata }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: ValidationError.name,
        details: expect.arrayContaining([expect.objectContaining({ field })]),
      }),
    );
    expect(fixture.accessRepository.findAccessContext).not.toHaveBeenCalled();
    expect(fixture.storage.createUploadUrl).not.toHaveBeenCalled();
  });
});
