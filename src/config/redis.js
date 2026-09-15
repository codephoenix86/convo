import { createClient } from 'redis';

import { env } from './env.js';
import { logger } from './logger.js';

const RECONNECT_BASE_DELAY_MS = 50;
const RECONNECT_JITTER_MS = 100;

export function createRedisClient({
  clientFactory = createClient,
  log = logger,
  random = Math.random,
  url = env.REDIS_URL,
  connectTimeoutMs = env.REDIS_CONNECT_TIMEOUT_MS,
  commandTimeoutMs = env.REDIS_COMMAND_TIMEOUT_MS,
  reconnectMaxDelayMs = env.REDIS_RECONNECT_MAX_DELAY_MS,
} = {}) {
  const client = clientFactory({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: commandTimeoutMs },
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: createReconnectStrategy(reconnectMaxDelayMs, random),
    },
  });

  client.on('connect', () => {
    log.debug(
      { dependency: 'redis', event: 'redis_connecting', status: 'connecting' },
      'Redis connection opened',
    );
  });
  client.on('ready', () => {
    log.info(
      { dependency: 'redis', event: 'redis_ready', status: 'available' },
      'Dependency check completed',
    );
  });
  client.on('error', (error) => {
    log.error(
      { err: error, dependency: 'redis', event: 'redis_error', status: 'unavailable' },
      'Redis connection error',
    );
  });
  client.on('reconnecting', () => {
    log.warn(
      { dependency: 'redis', event: 'redis_reconnecting', status: 'reconnecting' },
      'Redis reconnect scheduled',
    );
  });
  client.on('end', () => {
    log.info(
      { dependency: 'redis', event: 'redis_disconnected', status: 'disconnected' },
      'Redis connection closed',
    );
  });

  return client;
}

export function connectRedisClient(client) {
  if (client.isOpen) {
    return Promise.resolve(client);
  }

  return client.connect();
}

export async function closeRedisClient(client) {
  if (client.isOpen) {
    await client.close();
  }
}

function createReconnectStrategy(maxDelayMs, random) {
  return (retries) => {
    const exponent = Math.min(retries, 16);
    const delay = RECONNECT_BASE_DELAY_MS * 2 ** exponent;
    const jitter = Math.floor(random() * RECONNECT_JITTER_MS);

    return Math.min(delay + jitter, maxDelayMs);
  };
}

export const redis = createRedisClient();
