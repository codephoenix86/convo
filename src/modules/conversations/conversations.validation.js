import { z } from 'zod';

export const createDirectConversationBodySchema = z
  .object({
    userId: z.uuid(),
  })
  .strict();

const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Group name must not be empty')
  .max(100, 'Group name must contain at most 100 characters');

const groupImageUrlSchema = z
  .string()
  .trim()
  .max(2048, 'Group image URL must contain at most 2048 characters')
  .refine(isHttpUrl, 'Group image URL must use HTTP or HTTPS');

export const createGroupConversationBodySchema = z
  .object({
    name: groupNameSchema,
    imageUrl: groupImageUrlSchema.nullable().optional(),
    memberIds: z
      .array(z.uuid())
      .min(1, 'A group requires at least one other member')
      .max(99, 'A group may contain at most 100 members including its owner')
      .refine((ids) => new Set(ids).size === ids.length, 'Group members must be unique'),
  })
  .strict();

export const conversationIdParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export const updateGroupConversationBodySchema = z
  .object({
    name: groupNameSchema.optional(),
    imageUrl: groupImageUrlSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one group field is required');

export const listConversationsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
