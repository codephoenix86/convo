import { z } from 'zod';

const messageTextSchema = z
  .string()
  .trim()
  .max(4000, 'Message body must contain at most 4000 characters');
const messageBodySchema = messageTextSchema.min(1, 'Message body must not be empty');
const attachmentReferenceSchema = z
  .object({
    storageKey: z.string().trim().min(1).max(1024),
    width: z.number().int().min(1).max(20_000).optional(),
    height: z.number().int().min(1).max(20_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.width === undefined) !== (value.height === undefined)) {
      context.addIssue({
        code: 'custom',
        path: [value.width === undefined ? 'width' : 'height'],
        message: 'Image width and height must be provided together',
      });
    }
  });

export const conversationMessagesParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export const createMessageBodySchema = z
  .object({
    clientMessageId: z.uuid(),
    body: messageBodySchema,
    replyToId: z.uuid().nullable().optional(),
    attachments: z.array(attachmentReferenceSchema).max(4).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const storageKeys = value.attachments?.map((attachment) => attachment.storageKey) ?? [];

    if (new Set(storageKeys).size !== storageKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Attachment storage keys must be unique',
      });
    }
  });

export const sendMessageCommandSchema = createMessageBodySchema.safeExtend({
  conversationId: z.uuid(),
});

export const markConversationReadBodySchema = z
  .object({
    messageId: z.uuid(),
  })
  .strict();

export const markConversationReadCommandSchema = markConversationReadBodySchema.extend({
  conversationId: z.uuid(),
});

export const markMessageDeliveredCommandSchema = markConversationReadCommandSchema;

export const messageIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const editMessageBodySchema = z.object({ body: messageBodySchema }).strict();

export const editMessageCommandSchema = z
  .object({
    messageId: z.uuid(),
    body: messageBodySchema,
  })
  .strict();

export const deleteMessageCommandSchema = z.object({ messageId: z.uuid() }).strict();

export const messageHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();
