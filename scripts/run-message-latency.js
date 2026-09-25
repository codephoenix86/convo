import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { io as createSocketClient } from 'socket.io-client';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_SAMPLES = 100;
const DEFAULT_WARMUP_SAMPLES = 10;
const DEFAULT_IN_FLIGHT = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MESSAGE_SEND_LIMIT = 100000;
const PASSWORD = 'Latency-password1!';
const sockets = [];
let deliveryTracker;

try {
  const configuration = readConfiguration();

  console.log('Running end-to-end message delivery latency benchmark');
  console.log(`Target: ${configuration.baseUrl}`);
  console.log(
    `Plan: ${configuration.warmupSamples} warm-up + ${configuration.samples} measured, ${configuration.inFlight} in flight, 2 socket clients`,
  );

  const runId = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const [sender, recipient] = await Promise.all([
    registerUser('sender', runId, configuration),
    registerUser('recipient', runId, configuration),
  ]);
  const direct = await api(configuration, 'POST', '/conversations/direct', {
    token: sender.tokens.accessToken,
    body: { userId: recipient.user.id },
    expectedStatus: 200,
  });
  const conversationId = direct.body.data.conversation.id;
  const [senderSocket, recipientSocket] = await Promise.all([
    connectSocket(sender.tokens.accessToken, configuration),
    connectSocket(recipient.tokens.accessToken, configuration),
  ]);
  deliveryTracker = createDeliveryTracker(recipientSocket);

  console.log('Setup complete; both clients are connected and ready');

  await runDeliveryPhase({
    count: configuration.warmupSamples,
    inFlight: configuration.inFlight,
    measure: (index) =>
      measureDelivery({
        senderSocket,
        deliveryTracker,
        conversationId,
        sequence: `warmup-${index + 1}`,
        timeoutMs: configuration.timeoutMs,
      }),
  });

  console.log('Warm-up complete; collecting measured samples');

  const measurementStartedAt = performance.now();
  const latencies = await runDeliveryPhase({
    count: configuration.samples,
    inFlight: configuration.inFlight,
    measure: (index) =>
      measureDelivery({
        senderSocket,
        deliveryTracker,
        conversationId,
        sequence: `sample-${index + 1}`,
        timeoutMs: configuration.timeoutMs,
      }),
  });

  const measurementDurationMs = performance.now() - measurementStartedAt;
  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  const result = {
    target: configuration.baseUrl,
    measuredAt: new Date().toISOString(),
    node: process.version,
    transport: 'websocket',
    socketClients: 2,
    inFlight: configuration.inFlight,
    warmupSamples: configuration.warmupSamples,
    samples: configuration.samples,
    measurementDurationMs: round(measurementDurationMs),
    throughputMessagesPerSecond: round(configuration.samples / (measurementDurationMs / 1000)),
    latencyMs: {
      min: round(sortedLatencies[0]),
      p50: round(percentile(sortedLatencies, 0.5)),
      p95: round(percentile(sortedLatencies, 0.95)),
      p99: round(percentile(sortedLatencies, 0.99)),
      max: round(sortedLatencies.at(-1)),
    },
  };

  console.log('Benchmark completed successfully');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Message delivery latency benchmark failed:', error.message);
  process.exitCode = 1;
} finally {
  deliveryTracker?.close();

  for (const socket of sockets) {
    socket.close();
  }
}

function readConfiguration() {
  const baseUrl = normalizeBaseUrl(process.env.MESSAGE_LATENCY_BASE_URL ?? DEFAULT_BASE_URL);
  const samples = readInteger('MESSAGE_LATENCY_SAMPLES', DEFAULT_SAMPLES, { minimum: 1 });
  const warmupSamples = readInteger('MESSAGE_LATENCY_WARMUP_SAMPLES', DEFAULT_WARMUP_SAMPLES, {
    minimum: 0,
  });
  const inFlight = readInteger('MESSAGE_LATENCY_IN_FLIGHT', DEFAULT_IN_FLIGHT, {
    minimum: 1,
    maximum: samples,
  });
  const timeoutMs = readInteger('MESSAGE_LATENCY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, {
    minimum: 100,
    maximum: 60_000,
  });
  const totalSends = samples + warmupSamples;

  if (totalSends > DEFAULT_MESSAGE_SEND_LIMIT) {
    throw new Error(
      `Warm-up and measured samples total ${totalSends}; the default per-user message limit allows at most ${DEFAULT_MESSAGE_SEND_LIMIT} sends per minute`,
    );
  }

  return { baseUrl, samples, warmupSamples, inFlight, timeoutMs };
}

function normalizeBaseUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error('MESSAGE_LATENCY_BASE_URL must be a valid HTTP(S) URL');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('MESSAGE_LATENCY_BASE_URL must be an HTTP(S) origin without a path');
  }

  return url.origin;
}

function readInteger(name, fallback, { minimum, maximum = Number.MAX_SAFE_INTEGER }) {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? fallback : Number(rawValue);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }

  return value;
}

async function registerUser(label, runId, configuration) {
  const response = await api(configuration, 'POST', '/auth/register', {
    body: {
      email: `latency.${label}.${runId}@example.com`,
      username: `latency_${label}_${runId}`.slice(0, 32),
      password: PASSWORD,
    },
    expectedStatus: 201,
  });

  return response.body.data;
}

async function connectSocket(token, configuration) {
  const socket = createSocketClient(configuration.baseUrl, {
    auth: { token },
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  });
  sockets.push(socket);

  await new Promise((resolve, reject) => {
    let connected = false;
    let ready = false;
    const timer = setTimeout(
      () => finish(new Error(`Timed out connecting to ${configuration.baseUrl}`)),
      configuration.timeoutMs,
    );

    socket.on('connect', handleConnect);
    socket.on('session:ready', handleReady);
    socket.on('connect_error', handleError);
    socket.on('disconnect', handleDisconnect);
    socket.connect();

    function handleConnect() {
      connected = true;
      finishWhenReady();
    }

    function handleReady() {
      ready = true;
      finishWhenReady();
    }

    function finishWhenReady() {
      if (connected && ready) {
        finish();
      }
    }

    function handleError(error) {
      finish(error);
    }

    function handleDisconnect(reason) {
      finish(new Error(`Socket disconnected before session readiness: ${reason}`));
    }

    function finish(error) {
      clearTimeout(timer);
      socket.off('connect', handleConnect);
      socket.off('session:ready', handleReady);
      socket.off('connect_error', handleError);
      socket.off('disconnect', handleDisconnect);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    }
  });

  return socket;
}

async function measureDelivery({
  senderSocket,
  deliveryTracker,
  conversationId,
  sequence,
  timeoutMs,
}) {
  const clientMessageId = randomUUID();
  const delivery = deliveryTracker.waitFor(clientMessageId, timeoutMs);
  const startedAt = performance.now();

  try {
    const [acknowledgement, received] = await Promise.all([
      senderSocket.timeout(timeoutMs).emitWithAck('message:send', {
        conversationId,
        clientMessageId,
        body: `Latency benchmark ${sequence}`,
      }),
      delivery.promise,
    ]);

    assertSuccessfulDelivery({ acknowledgement, received, clientMessageId });

    return received.receivedAt - startedAt;
  } finally {
    delivery.cancel();
  }
}

async function runDeliveryPhase({ count, inFlight, measure }) {
  const results = new Array(count);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < count) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await measure(index);
    }
  }

  const workerCount = Math.min(count, inFlight);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

function createDeliveryTracker(socket) {
  const pending = new Map();

  socket.on('message:new', handleMessage);

  return {
    waitFor(clientMessageId, timeoutMs) {
      if (pending.has(clientMessageId)) {
        throw new Error(`Delivery ${clientMessageId} is already being tracked`);
      }

      let timer;
      const promise = new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            settle(
              clientMessageId,
              new Error(`Timed out waiting for message:new (${clientMessageId})`),
            ),
          timeoutMs,
        );
        pending.set(clientMessageId, { resolve, reject, timer });
      });

      return {
        promise,
        cancel: () => settle(clientMessageId, new Error(`Cancelled delivery ${clientMessageId}`)),
      };
    },

    close() {
      socket.off('message:new', handleMessage);

      for (const clientMessageId of pending.keys()) {
        settle(clientMessageId, new Error(`Stopped tracking delivery ${clientMessageId}`));
      }
    },
  };

  function handleMessage(event) {
    const clientMessageId = event?.message?.clientMessageId;

    if (!pending.has(clientMessageId)) {
      return;
    }

    settle(clientMessageId, undefined, { event, receivedAt: performance.now() });
  }

  function settle(clientMessageId, error, value) {
    const delivery = pending.get(clientMessageId);

    if (!delivery) {
      return;
    }

    pending.delete(clientMessageId);
    clearTimeout(delivery.timer);

    if (error) {
      delivery.reject(error);
      return;
    }

    delivery.resolve(value);
  }
}

function assertSuccessfulDelivery({ acknowledgement, received, clientMessageId }) {
  if (acknowledgement?.ok !== true) {
    throw new Error(`message:send was rejected: ${JSON.stringify(acknowledgement?.error)}`);
  }

  if (acknowledgement.data.created !== true) {
    throw new Error(`Message ${clientMessageId} was not created`);
  }

  const acknowledgedMessage = acknowledgement.data.message;
  const receivedMessage = received.event.message;

  if (
    acknowledgedMessage.clientMessageId !== clientMessageId ||
    receivedMessage.clientMessageId !== clientMessageId ||
    receivedMessage.id !== acknowledgedMessage.id
  ) {
    throw new Error(`Acknowledgement and recipient event did not match for ${clientMessageId}`);
  }
}

async function api(configuration, method, requestPath, { token, body, expectedStatus } = {}) {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(new URL(requestPath, configuration.baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(configuration.timeoutMs),
  });
  const responseBody = await readResponseBody(response);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${requestPath} returned ${response.status}; expected ${expectedStatus}: ${JSON.stringify(responseBody)}`,
    );
  }

  return { response, body: responseBody };
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

function percentile(sortedValues, fraction) {
  return sortedValues[Math.ceil(fraction * sortedValues.length) - 1];
}

function round(value) {
  return Number(value.toFixed(3));
}
