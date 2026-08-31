import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const loggerModuleUrl = pathToFileURL(resolve('src/config/logger.js')).href;

describe('structured logger', () => {
  it('redacts credentials from structured objects', () => {
    const password = 'password-must-not-appear';
    const authorization = 'authorization-must-not-appear';
    const source = `
      const { logger } = await import('${loggerModuleUrl}');
      logger.info({
        password: '${password}',
        user: { passwordHash: '${password}' },
        req: { headers: { authorization: '${authorization}' } }
      }, 'Redaction check');
      logger.flush();
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://convo:convo@localhost:5432/convo_test',
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain(authorization);

    const entry = JSON.parse(result.stdout.trim());
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.user.passwordHash).toBe('[REDACTED]');
    expect(entry.req.headers.authorization).toBe('[REDACTED]');
  });
});
