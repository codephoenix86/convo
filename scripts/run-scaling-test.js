import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { io as createSocketClient } from 'socket.io-client';

const HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 15_000;
const EVENT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;
const MAX_CAPTURED_LOG_LENGTH = 20_000;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sockets = [];
const instances = [];

loadLocalEnvironment();

try {
  const testDatabaseUrl = requireTestDatabaseUrl();
  requireRedisUrl();
  applyMigrations(testDatabaseUrl);

  const ports = await reservePorts(2);
  const sharedEnvironment = createSharedEnvironment(testDatabaseUrl);

  instances.push(
    startInstance('A', ports[0], sharedEnvironment),
    startInstance('B', ports[1], sharedEnvironment),
  );

  await Promise.all(instances.map(waitForReadiness));
  console.log(`1/5 Started ready API instances on ports ${ports.join(' and ')}`);

  await proveCrossInstanceBehavior(instances[0].baseUrl, instances[1].baseUrl);

  closeSockets();
  const shutdowns = await Promise.all(instances.splice(0).map(stopInstance));
  assert(
    shutdowns.every(({ code, signal }) => code === 0 && signal === null),
    `An API instance did not shut down cleanly: ${JSON.stringify(shutdowns)}`,
  );
  console.log('5/5 Shut down both API instances cleanly');
  console.log('Two-instance scaling proof completed successfully.');
} catch (error) {
  printInstanceDiagnostics();
  console.error('Two-instance scaling proof failed:', error.message);
  process.exitCode = 1;
} finally {
  closeSockets();
  await Promise.all(instances.splice(0).map(forceStopInstance));
}

async function proveCrossInstanceBehavior(instanceAUrl, instanceBUrl) {
  const runId = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const [alice, bob] = await Promise.all([
    registerUser(instanceAUrl, 'alice', runId, createForwardedAddress(1)),
    registerUser(instanceBUrl, 'bob', runId, createForwardedAddress(2)),
  ]);
  const direct = await api(instanceAUrl, 'POST', '/conversations/direct', {
    token: alice.tokens.accessToken,
    body: { userId: bob.user.id },
    expectedStatus: 200,
  });
  const conversationId = direct.body.data.conversation.id;
  console.log('2/5 Created users through different instances and shared one conversation');

  const bobConnection = await connectSocket(instanceBUrl, bob.tokens.accessToken);
  const aliceOnline = waitForMatchingEvent(
    bobConnection.client,
    'presence:update',
    ({ presence }) => presence.userId === alice.user.id && presence.isOnline === true,
  );
  const aliceConnection = await connectSocket(instanceAUrl, alice.tokens.accessToken);
  await aliceOnline;
  assert(
    aliceConnection.snapshot.items.some(
      ({ userId, isOnline }) => userId === bob.user.id && isOnline === true,
    ),
    "Instance A did not read Bob's shared Redis presence state",
  );
  console.log('3/5 Observed shared presence across the two API instances');

  const clientMessageId = randomUUID();
  const receivedMessage = waitForMatchingEvent(
    bobConnection.client,
    'message:new',
    ({ message }) => message.clientMessageId === clientMessageId,
  );
  const acknowledgement = await aliceConnection.client
    .timeout(EVENT_TIMEOUT_MS)
    .emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'Cross-instance Redis adapter proof',
    });

  assertAcknowledgement(acknowledgement, 'message:send');
  const delivered = await receivedMessage;
  assert(
    delivered.message.id === acknowledgement.data.message.id,
    'Instance B received a different message than instance A acknowledged',
  );

  const history = await api(
    instanceBUrl,
    'GET',
    `/conversations/${conversationId}/messages?limit=50`,
    { token: bob.tokens.accessToken, expectedStatus: 200 },
  );
  assert(
    history.body.data.items.some(({ id }) => id === acknowledgement.data.message.id),
    'Instance B could not read the message persisted through instance A',
  );

  const bobOffline = waitForMatchingEvent(
    aliceConnection.client,
    'presence:update',
    ({ presence }) => presence.userId === bob.user.id && presence.isOnline === false,
  );
  bobConnection.client.close();
  await bobOffline;
  console.log('4/5 Delivered a persisted message and offline transition across instances');
}

async function registerUser(baseUrl, label, runId, forwardedAddress) {
  const response = await api(baseUrl, 'POST', '/auth/register', {
    body: {
      email: `${label}.${runId}@example.com`,
      username: `${label}_${runId}`.slice(0, 32),
      password: 'Scaling-password1!',
    },
    expectedStatus: 201,
    headers: { 'x-forwarded-for': forwardedAddress },
  });

  return response.body.data;
}

async function connectSocket(baseUrl, token) {
  const client = createSocketClient(baseUrl, {
    auth: { token },
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  });
  sockets.push(client);

  const connection = new Promise((resolve, reject) => {
    let connected = false;
    let ready = false;
    let snapshot;
    const timer = setTimeout(
      () => finish(new Error(`Timed out connecting to ${baseUrl}`)),
      EVENT_TIMEOUT_MS,
    );

    client.on('connect', handleConnect);
    client.on('session:ready', handleReady);
    client.on('presence:snapshot', handleSnapshot);
    client.on('connect_error', handleError);

    function handleConnect() {
      connected = true;
      finishWhenComplete();
    }

    function handleReady() {
      ready = true;
      finishWhenComplete();
    }

    function handleSnapshot(event) {
      snapshot = event;
      finishWhenComplete();
    }

    function handleError(error) {
      finish(error);
    }

    function finishWhenComplete() {
      if (connected && ready && snapshot) {
        finish(undefined, { client, snapshot });
      }
    }

    function finish(error, result) {
      clearTimeout(timer);
      client.off('connect', handleConnect);
      client.off('session:ready', handleReady);
      client.off('presence:snapshot', handleSnapshot);
      client.off('connect_error', handleError);

      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    }
  });

  client.connect();
  return connection;
}

async function api(
  baseUrl,
  method,
  requestPath,
  { token, body, expectedStatus, headers: extraHeaders = {} } = {},
) {
  const headers = { ...extraHeaders };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(new URL(requestPath, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
  });
  const responseBody = await readResponseBody(response);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${requestPath} returned ${response.status}; expected ${expectedStatus}: ${JSON.stringify(responseBody)}`,
    );
  }

  return { response, body: responseBody };
}

function startInstance(name, port, sharedEnvironment) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...sharedEnvironment, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const instance = {
    name,
    port,
    baseUrl: `http://${HOST}:${port}`,
    child,
    stdout: '',
    stderr: '',
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    instance.stdout = captureTail(instance.stdout, chunk);
  });
  child.stderr.on('data', (chunk) => {
    instance.stderr = captureTail(instance.stderr, chunk);
  });

  return instance;
}

async function waitForReadiness(instance) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastStatus = 'not reachable';

  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(
        `Instance ${instance.name} exited before readiness (code ${instance.child.exitCode}, signal ${instance.child.signalCode})`,
      );
    }

    try {
      const response = await fetch(new URL('/ready', instance.baseUrl), {
        signal: AbortSignal.timeout(1000),
      });
      lastStatus = `${response.status} ${await response.text()}`;

      if (response.ok) {
        return;
      }
    } catch (error) {
      lastStatus = error.message;
    }

    await delay(100);
  }

  throw new Error(
    `Instance ${instance.name} was not ready within ${STARTUP_TIMEOUT_MS}ms (${lastStatus})`,
  );
}

async function stopInstance(instance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
    return {
      name: instance.name,
      code: instance.child.exitCode,
      signal: instance.child.signalCode,
    };
  }

  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');

  const [code, signal] = await Promise.race([
    exited,
    delay(SHUTDOWN_TIMEOUT_MS).then(() => {
      instance.child.kill('SIGKILL');
      return exited;
    }),
  ]);

  return { name: instance.name, code, signal };
}

async function forceStopInstance(instance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
    return;
  }

  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');

  await Promise.race([
    exited,
    delay(SHUTDOWN_TIMEOUT_MS).then(async () => {
      instance.child.kill('SIGKILL');
      await exited;
    }),
  ]);
}

async function reservePorts(count) {
  const servers = Array.from({ length: count }, () => createServer());

  try {
    await Promise.all(
      servers.map(async (server) => {
        server.listen(0, HOST);
        await once(server, 'listening');
      }),
    );

    const ports = servers.map((server) => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : undefined;
    });
    assert(ports.every(Number.isInteger), 'Unable to reserve two local ports');

    return ports;
  } finally {
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
    );
  }
}

function createSharedEnvironment(testDatabaseUrl) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    HOST,
    TRUST_PROXY_HOPS: '1',
    LOG_LEVEL: process.env.SCALING_TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: testDatabaseUrl,
    SOCKET_IO_REDIS_CHANNEL_PREFIX: `convo:scaling:${process.pid}:${Date.now()}`,
  };
}

function applyMigrations(testDatabaseUrl) {
  const result = spawnSync(
    process.execPath,
    [path.join(projectRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw new Error(`Could not apply test database migrations: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Test database migration exited with status ${result.status ?? 'unknown'}`);
  }
}

function requireTestDatabaseUrl() {
  const value = process.env.TEST_DATABASE_URL;

  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL is required and must identify a disposable database ending in "_test".',
    );
  }

  const parsed = parseDatabaseUrl(value, 'TEST_DATABASE_URL');
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));

  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to use database "${databaseName}"; its name must end in "_test".`);
  }

  if (process.env.DATABASE_URL) {
    const development = parseDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');

    if (sameDatabase(development, parsed)) {
      throw new Error('TEST_DATABASE_URL must not point at the development database.');
    }
  }

  return value;
}

function requireRedisUrl() {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required for the two-instance scaling proof.');
  }
}

function parseDatabaseUrl(value, name) {
  try {
    const url = new URL(value);

    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname === '/'
    ) {
      throw new Error('Invalid PostgreSQL URL');
    }

    return url;
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL database URL.`);
  }
}

function sameDatabase(left, right) {
  return (
    left.hostname === right.hostname &&
    effectivePort(left) === effectivePort(right) &&
    decodeURIComponent(left.pathname) === decodeURIComponent(right.pathname)
  );
}

function effectivePort(url) {
  return url.port || '5432';
}

function waitForMatchingEvent(socket, eventName, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handleEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, EVENT_TIMEOUT_MS);

    function handleEvent(event) {
      if (!predicate(event)) {
        return;
      }

      clearTimeout(timer);
      socket.off(eventName, handleEvent);
      resolve(event);
    }

    socket.on(eventName, handleEvent);
  });
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertAcknowledgement(acknowledgement, eventName) {
  assert(
    acknowledgement?.ok === true,
    `${eventName} failed: ${JSON.stringify(acknowledgement?.error)}`,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createForwardedAddress(offset) {
  const processSegment = (process.pid % 65_535).toString(16);
  const timeSegment = (Date.now() % 65_535).toString(16);

  return `2001:db8:${processSegment}:${timeSegment}::${offset}`;
}

function captureTail(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_CAPTURED_LOG_LENGTH);
}

function closeSockets() {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
}

function printInstanceDiagnostics() {
  for (const instance of instances) {
    if (instance.stdout) {
      console.error(`Instance ${instance.name} stdout:\n${instance.stdout}`);
    }

    if (instance.stderr) {
      console.error(`Instance ${instance.name} stderr:\n${instance.stderr}`);
    }
  }
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
