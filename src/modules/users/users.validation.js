import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must contain at least 3 characters')
  .max(32, 'Username must contain at most 32 characters')
  .regex(/^[a-z0-9_]+$/, 'Username may contain only lowercase letters, numbers, and underscores');

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048, 'Avatar URL must contain at most 2048 characters')
  .refine(isHttpUrl, 'Avatar URL must use HTTP or HTTPS');

export const updateProfileBodySchema = z
  .object({
    username: usernameSchema.optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one profile field is required');

export const searchUsersQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .toLowerCase()
      .min(2, 'Search query must contain at least 2 characters')
      .max(64, 'Search query must contain at most 64 characters'),
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
