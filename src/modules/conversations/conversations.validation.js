import { z } from 'zod';

export const createDirectConversationBodySchema = z
  .object({
    userId: z.uuid(),
  })
  .strict();

export const listConversationsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
