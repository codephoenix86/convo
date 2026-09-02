import { z } from 'zod';

export const conversationMessagesParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export const createMessageBodySchema = z
  .object({
    clientMessageId: z.uuid(),
    body: z
      .string()
      .trim()
      .min(1, 'Message body must not be empty')
      .max(4000, 'Message body must contain at most 4000 characters'),
    replyToId: z.uuid().nullable().optional(),
  })
  .strict();

export const messageHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();
