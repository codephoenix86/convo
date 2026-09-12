import { z } from 'zod';

const clientOriginsSchema = z
  .string()
  .default('http://localhost:5173')
  .transform((value, context) => {
    const origins = [...new Set(value.split(',').map((origin) => origin.trim()))];

    if (origins.length === 0 || origins.some((origin) => origin.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'must contain one or more comma-separated HTTP(S) origins',
      });

      return z.NEVER;
    }

    const normalizedOrigins = [];

    for (const origin of origins) {
      try {
        const url = new URL(origin);

        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        ) {
          throw new Error('Invalid origin');
        }

        normalizedOrigins.push(url.origin);
      } catch {
        context.addIssue({
          code: 'custom',
          message: `contains an invalid origin: ${origin}`,
        });

        return z.NEVER;
      }
    }

    return normalizedOrigins;
  });

const optionalHttpUrlSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'must use HTTP(S)')
    .optional(),
);

const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1, 'must not be empty').optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().trim().min(1, 'must not be empty').default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string({ error: 'is required' })
      .trim()
      .min(1, 'is required')
      .refine(isPostgresUrl, 'must be a valid PostgreSQL URL'),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5000),
    ACCESS_TOKEN_SECRET: z
      .string({ error: 'is required' })
      .min(32, 'must contain at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    JWT_ISSUER: z.string().trim().min(1).max(100).default('convo-api'),
    JWT_AUDIENCE: z.string().trim().min(1).max(100).default('convo-client'),
    CLIENT_ORIGINS: clientOriginsSchema,
    ATTACHMENT_STORAGE_DRIVER: z.enum(['s3', 'cloudinary', 'local']).default('s3'),
    LOCAL_STORAGE_DIRECTORY: z.string().trim().min(1, 'must not be empty').default('./storage'),
    LOCAL_STORAGE_SIGNING_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32, 'must contain at least 32 characters').optional(),
    ),
    LOCAL_STORAGE_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    OBJECT_STORAGE_REGION: optionalNonEmptyStringSchema,
    OBJECT_STORAGE_BUCKET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1, 'is required').max(255).optional(),
    ),
    OBJECT_STORAGE_ENDPOINT: optionalHttpUrlSchema,
    OBJECT_STORAGE_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
    OBJECT_STORAGE_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    OBJECT_STORAGE_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    CLOUDINARY_CLOUD_NAME: optionalNonEmptyStringSchema,
    CLOUDINARY_API_KEY: optionalNonEmptyStringSchema,
    CLOUDINARY_API_SECRET: optionalNonEmptyStringSchema,
    CLOUDINARY_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  })
  .superRefine((value, context) => {
    if (value.ATTACHMENT_STORAGE_DRIVER === 's3') {
      requireFields(
        value,
        [
          'OBJECT_STORAGE_REGION',
          'OBJECT_STORAGE_BUCKET',
          'OBJECT_STORAGE_ACCESS_KEY_ID',
          'OBJECT_STORAGE_SECRET_ACCESS_KEY',
        ],
        context,
      );
    }

    if (value.ATTACHMENT_STORAGE_DRIVER === 'cloudinary') {
      requireFields(
        value,
        ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
        context,
      );
    }
  });

loadLocalEnvironment();

export const env = parseEnvironment(process.env);

function loadLocalEnvironment() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function parseEnvironment(values) {
  const result = environmentSchema.safeParse(values);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const configuration = result.data;

  if (configuration.ATTACHMENT_STORAGE_DRIVER === 'local') {
    configuration.LOCAL_STORAGE_SIGNING_SECRET ??= configuration.ACCESS_TOKEN_SECRET;
  }

  return Object.freeze(configuration);
}

function requireFields(configuration, fields, context) {
  for (const field of fields) {
    if (!configuration[field]) {
      context.addIssue({ code: 'custom', path: [field], message: 'is required' });
    }
  }
}

function isPostgresUrl(value) {
  try {
    const url = new URL(value);

    return ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}
