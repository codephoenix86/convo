import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../generated/prisma/client.ts';
import { env } from './env.js';

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
});

export const db = new PrismaClient({ adapter });
