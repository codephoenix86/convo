import pg from 'pg';
import { createClient } from 'redis';

const { Client } = pg;
const CONFIRMATION_FLAG = '--confirm';

if (process.argv.includes('--help')) {
  console.log('Usage: npm run db:flush -- --confirm');
  console.log('Clears PostgreSQL application tables and the configured Redis logical database.');
  process.exit(0);
}

loadLocalEnvironment();

if (!process.argv.includes(CONFIRMATION_FLAG)) {
  fail(`Refusing to delete data without ${CONFIRMATION_FLAG}.`);
}

if (process.env.NODE_ENV === 'production') {
  fail('Refusing to flush databases when NODE_ENV=production.');
}

const databaseUrl = requiredUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
const redisUrl = requiredUrl('REDIS_URL', ['redis:', 'rediss:']);
const postgres = new Client({ connectionString: databaseUrl.href });
const redis = createClient({ url: redisUrl.href });

// Keep Redis connection errors attached to the command failure instead of emitting
// an unhandled "error" event.
redis.on('error', () => {});

try {
  // Check both dependencies before deleting anything.
  await Promise.all([postgres.connect(), redis.connect()]);
  await Promise.all([postgres.query('SELECT 1'), redis.ping()]);

  await postgres.query('BEGIN');

  try {
    const tables = await listApplicationTables(postgres);

    if (tables.length > 0) {
      await postgres.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    }

    await redis.flushDb();
    await postgres.query('COMMIT');

    console.log(`Cleared ${tables.length} PostgreSQL application table(s).`);
    console.log('Cleared the Redis logical database selected by REDIS_URL.');
  } catch (error) {
    await postgres.query('ROLLBACK').catch(() => {});
    throw error;
  }
} catch (error) {
  console.error('Database flush failed:', error.message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([postgres.end(), redis.isOpen ? redis.close() : Promise.resolve()]);
}

async function listApplicationTables(client) {
  const result = await client.query(`
    SELECT format('%I.%I', schemaname, tablename) AS qualified_name
    FROM pg_tables
    WHERE schemaname = ANY (current_schemas(false))
      AND tablename <> '_prisma_migrations'
    ORDER BY schemaname, tablename
  `);

  return result.rows.map((row) => row.qualified_name);
}

function loadLocalEnvironment() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function requiredUrl(name, allowedProtocols) {
  const value = process.env[name];

  if (!value) {
    fail(`${name} is required.`);
  }

  try {
    const url = new URL(value);

    if (!allowedProtocols.includes(url.protocol) || !url.hostname) {
      throw new Error('invalid URL');
    }

    return url;
  } catch {
    fail(`${name} must be a valid ${allowedProtocols.join(' or ')} URL.`);
  }
}

function fail(message) {
  console.error(`Database flush safety check failed: ${message}`);
  process.exit(1);
}
