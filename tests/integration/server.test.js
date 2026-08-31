import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

describe('server lifecycle', () => {
  it('starts and shuts down cleanly on SIGTERM', async () => {
    const port = await reservePort();
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://convo:convo@127.0.0.1:1/convo_test',
        DATABASE_CONNECTION_TIMEOUT_MS: '100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => stdout.includes('"event":"server_started"'), 5000);

      const exitPromise = once(child, 'exit');
      child.kill('SIGTERM');

      const [exitCode, signal] = await withTimeout(exitPromise, 5000);

      expect(exitCode, stderr).toBe(0);
      expect(signal).toBeNull();
      expect(stdout).toContain('"event":"shutdown_started"');
      expect(stdout).toContain('"event":"shutdown_completed"');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 12_000);
});

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  if (!port) {
    throw new Error('Unable to reserve a test port');
  }

  return port;
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Condition was not met within ${timeoutMs}ms`));
      }
    }, 25);
  });
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}
