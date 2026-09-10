import { db } from '../../config/db.js';

export function createAttachmentsRepository(database = db) {
  return {
    findDownloadContext({ attachmentId, userId }) {
      return database.attachment.findFirst({
        where: {
          id: attachmentId,
          message: {
            deletedAt: null,
            conversation: { members: { some: { userId } } },
          },
        },
        select: {
          id: true,
          storageKey: true,
          mimeType: true,
        },
      });
    },
  };
}

export const attachmentsRepository = createAttachmentsRepository();
