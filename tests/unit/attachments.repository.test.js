import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createAttachmentsRepository } from '../../src/modules/attachments/attachments.repository.js';

describe('attachments repository', () => {
  it('loads a nondeleted attachment only through current conversation membership', async () => {
    const attachmentId = randomUUID();
    const userId = randomUUID();
    const attachment = {
      id: attachmentId,
      storageKey: 'private/file.png',
      mimeType: 'image/png',
    };
    const database = {
      attachment: { findFirst: vi.fn().mockResolvedValue(attachment) },
    };
    const repository = createAttachmentsRepository(database);

    await expect(repository.findDownloadContext({ attachmentId, userId })).resolves.toBe(
      attachment,
    );
    expect(database.attachment.findFirst).toHaveBeenCalledWith({
      where: {
        id: attachmentId,
        message: {
          deletedAt: null,
          conversation: { members: { some: { userId } } },
        },
      },
      select: { id: true, storageKey: true, mimeType: true },
    });
  });
});
