import { z } from 'zod';

import { objectStorage } from '../../config/object-storage.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  getFileExtension,
  MAX_ATTACHMENT_BYTES,
} from '../attachments/attachments.validation.js';
import { requireConversationMember } from '../conversations/conversation-access.js';
import { conversationsRepository } from '../conversations/conversations.repository.js';
import { presentMessage } from './message-presenter.js';
import { messagesRepository } from './messages.repository.js';
import {
  deleteMessageCommandSchema,
  editMessageCommandSchema,
  markConversationReadCommandSchema,
  markMessageDeliveredCommandSchema,
  sendMessageCommandSchema,
} from './messages.validation.js';

const messageHistoryCursorSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();
const noOpMessageEvents = Object.freeze({
  async messageCreated() {},
  async messageDelivered() {},
  async conversationRead() {},
  async messageEdited() {},
  async messageDeleted() {},
});

export function createMessagesService({
  repository,
  accessRepository,
  storage = objectStorage,
  messageEvents = noOpMessageEvents,
}) {
  return {
    async send(userId, input) {
      const command = parseSendMessageCommand(input);
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);

      const attachments = await validateUploadedAttachments({
        storage,
        userId,
        conversationId: command.conversationId,
        references: command.attachments ?? [],
      });

      const createInput = {
        conversationId: command.conversationId,
        senderId: userId,
        clientMessageId: command.clientMessageId,
        body: command.body,
        replyToId: command.replyToId ?? null,
      };

      if (attachments.length) {
        createInput.attachments = attachments;
      }

      const result = await repository.create(createInput);
      const message = presentMessage(result.message);
      const presentedResult = message === result.message ? result : { ...result, message };

      if (result.created) {
        await messageEvents.messageCreated({ message });
      }

      return presentedResult;
    },

    async listHistory(userId, conversationId, { cursor: encodedCursor, limit }) {
      const context = await accessRepository.findAccessContext(conversationId, [userId]);
      requireConversationMember(context, userId);
      const parsedCursor = encodedCursor
        ? decodeCursor(encodedCursor, messageHistoryCursorSchema)
        : undefined;

      if (parsedCursor && parsedCursor.conversationId !== conversationId) {
        throw new ValidationError('Invalid pagination cursor', [
          { field: 'cursor', message: 'Cursor is invalid or does not match this request' },
        ]);
      }

      const cursor = parsedCursor
        ? { id: parsedCursor.id, createdAt: new Date(parsedCursor.createdAt) }
        : undefined;
      const rows = await repository.listHistory({ conversationId, userId, cursor, limit });
      const hasNextPage = rows.length > limit;
      const messages = (hasNextPage ? rows.slice(0, limit) : rows).map(presentMessage);
      const lastMessage = messages.at(-1);

      return {
        items: messages,
        nextCursor:
          hasNextPage && lastMessage
            ? encodeCursor({
                id: lastMessage.id,
                conversationId,
                createdAt: lastMessage.createdAt.toISOString(),
              })
            : null,
      };
    },

    async markRead(userId, input) {
      const command = parseCommand(markConversationReadCommandSchema, input, 'Read state');
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);
      const result = await repository.advanceReadPosition({
        conversationId: command.conversationId,
        userId,
        messageId: command.messageId,
      });

      if (result.advanced) {
        await messageEvents.conversationRead({ receipt: result.receipt });
      }

      return result.receipt;
    },

    async markDelivered(userId, input) {
      const command = parseCommand(markMessageDeliveredCommandSchema, input, 'Delivery receipt');
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);
      const result = await repository.advanceDeliveredPosition({
        conversationId: command.conversationId,
        userId,
        messageId: command.messageId,
      });

      if (result.advanced) {
        await messageEvents.messageDelivered({ receipt: result.receipt });
      }

      return result.receipt;
    },

    async edit(userId, input) {
      const command = parseCommand(editMessageCommandSchema, input, 'Message');
      const context = await repository.findMutationContext({
        messageId: command.messageId,
        userId,
      });
      requireSenderMutation(context, userId);

      if (context.deletedAt) {
        throw new ConflictError('Deleted messages cannot be edited');
      }

      if (context.type !== 'TEXT') {
        throw new ConflictError('This message type cannot be edited');
      }

      if (context.body === command.body) {
        return presentMessage(context);
      }

      const message = presentMessage(
        await repository.edit({
          conversationId: context.conversationId,
          messageId: command.messageId,
          userId,
          body: command.body,
        }),
      );

      await messageEvents.messageEdited({ message });

      return message;
    },

    async delete(userId, input) {
      const command = parseCommand(deleteMessageCommandSchema, input, 'Message');
      const context = await repository.findMutationContext({
        messageId: command.messageId,
        userId,
      });
      requireSenderMutation(context, userId);

      if (context.deletedAt) {
        return presentMessage(context);
      }

      if (context.type !== 'TEXT') {
        throw new ConflictError('This message type cannot be deleted');
      }

      const message = presentMessage(
        await repository.softDelete({
          conversationId: context.conversationId,
          messageId: command.messageId,
          userId,
        }),
      );

      await messageEvents.messageDeleted({ message });

      return message;
    },
  };
}

function requireSenderMutation(message, userId) {
  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.senderId !== userId) {
    throw new ForbiddenError('Only the message sender can modify it');
  }
}

async function validateUploadedAttachments({ storage, userId, conversationId, references }) {
  return Promise.all(
    references.map(async (reference, index) => {
      const field = `attachments.${index}.storageKey`;
      const expectedPrefix = `conversations/${conversationId}/users/${userId}/`;

      if (!reference.storageKey.startsWith(expectedPrefix)) {
        throw new NotFoundError('Uploaded attachment not found');
      }

      const object = await storage.inspectObject(reference.storageKey);

      if (
        !object ||
        object.metadata['conversation-id'] !== conversationId ||
        object.metadata['uploader-id'] !== userId ||
        object.metadata['declared-size'] !== String(object.size)
      ) {
        throw new NotFoundError('Uploaded attachment not found');
      }

      const extension = getFileExtension(reference.storageKey);
      const allowedExtensions = ALLOWED_ATTACHMENT_EXTENSIONS[object.mimeType];

      if (
        !Number.isInteger(object.size) ||
        object.size < 1 ||
        object.size > MAX_ATTACHMENT_BYTES ||
        !allowedExtensions?.includes(extension)
      ) {
        throw new ValidationError('Attachment validation failed', [
          { field, message: 'Uploaded object metadata is invalid or unsupported' },
        ]);
      }

      if (reference.width !== undefined && !object.mimeType.startsWith('image/')) {
        throw new ValidationError('Attachment validation failed', [
          {
            field: `attachments.${index}.width`,
            message: 'Dimensions are supported only for image attachments',
          },
        ]);
      }

      return {
        storageKey: reference.storageKey,
        mimeType: object.mimeType,
        size: object.size,
        width: reference.width ?? null,
        height: reference.height ?? null,
      };
    }),
  );
}

function parseSendMessageCommand(input) {
  return parseCommand(sendMessageCommandSchema, input, 'Message');
}

function parseCommand(schema, input, subject) {
  const result = schema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  throw new ValidationError(
    `${subject} validation failed`,
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'message',
      message: issue.message,
    })),
  );
}

export const messagesService = createMessagesService({
  repository: messagesRepository,
  accessRepository: conversationsRepository,
});
