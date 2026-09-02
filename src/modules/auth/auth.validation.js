import { z } from 'zod';

import { usernameSchema } from '../users/users.validation.js';

const normalizedEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must contain at most 254 characters')
  .pipe(z.email('Email must be valid'));

const registrationPasswordSchema = z
  .string()
  .min(12, 'Password must contain at least 12 characters')
  .max(128, 'Password must contain at most 128 characters')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number')
  .regex(/[^A-Za-z0-9]/, 'Password must include a special character');

export const registerBodySchema = z
  .object({
    email: normalizedEmailSchema,
    username: usernameSchema,
    password: registrationPasswordSchema,
  })
  .strict();

export const loginBodySchema = z
  .object({
    identifier: z.string().trim().toLowerCase().min(3).max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export const refreshBodySchema = z
  .object({
    refreshToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'Refresh token must be a valid opaque token'),
  })
  .strict();
