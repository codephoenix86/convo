import { randomUUID } from 'node:crypto';

import { objectStorage } from '../../config/object-storage.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { requireConversationMember } from '../conversations/conversation-access.js';
import { conversationsRepository } from '../conversations/conversations.repository.js';
import { attachmentsRepository } from './attachments.repository.js';
import { getFileExtension, initializeUploadCommandSchema } from './attachments.validation.js';

export function createAttachmentsService({
  accessRepository,
  repository,
  storage,
  createId = randomUUID,
  now = () => new Date(),
}) {
  return {
    async initializeUpload(userId, input) {
      const command = parseInitializeUploadCommand(input);
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);

      const uploadId = createId();
      const extension = getFileExtension(command.fileName);
      const storageKey = [
        'conversations',
        command.conversationId,
        'users',
        userId,
        `${uploadId}.${extension}`,
      ].join('/');
      const signedUpload = await storage.createUploadUrl({
        storageKey,
        mimeType: command.mimeType,
        size: command.size,
        metadata: {
          'conversation-id': command.conversationId,
          'uploader-id': userId,
          'declared-size': String(command.size),
        },
      });

      return {
        storageKey,
        method: signedUpload.method,
        url: signedUpload.url,
        headers: signedUpload.headers,
        ...(signedUpload.formFields ? { formFields: signedUpload.formFields } : {}),
        expiresAt: new Date(now().getTime() + signedUpload.expiresIn * 1000),
      };
    },

    async createDownload(userId, attachmentId) {
      const context = await repository.findDownloadContext({ attachmentId, userId });

      if (!context) {
        throw new NotFoundError('Attachment not found');
      }

      return storage.createDownloadUrl(context.storageKey);
    },
  };
}

function parseInitializeUploadCommand(input) {
  const result = initializeUploadCommandSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  throw new ValidationError(
    'Attachment upload validation failed',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'attachment',
      message: issue.message,
    })),
  );
}

export const attachmentsService = createAttachmentsService({
  accessRepository: conversationsRepository,
  repository: attachmentsRepository,
  storage: objectStorage,
});
