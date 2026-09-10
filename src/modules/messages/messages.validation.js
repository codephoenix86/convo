import { z } from 'zod';

const messageBodySchema = z
  .string()
  .trim()
  .min(1, 'Message body must not be empty')
  .max(4000, 'Message body must contain at most 4000 characters');

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
  })
  .strict();

export const sendMessageCommandSchema = createMessageBodySchema.extend({
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
