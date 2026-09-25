import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { io as createSocketClient } from 'socket.io-client';

const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3000',
  users: 50,
  chats: 100,
  durationMs: 5 * 60_000,
  minDelayMs: 2000,
  maxDelayMs: 3000,
  groupMinSize: 3,
  groupMaxSize: 50,
  setupConcurrency: 5,
  connectConcurrency: 50,
  requestTimeoutMs: 30_000,
  ackTimeoutMs: 10_000,
  deliveryGraceMs: 2_000,
});
const DIRECT_CHAT_PERCENT = 90;
const PASSWORD = 'Load-test-password1!';
const sockets = [];
const stopController = new AbortController();
let benchmarkActive = false;

process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

try {
  const configuration = readConfiguration(process.argv.slice(2));

  if (configuration.help) {
    printUsage();
  } else {
    await run(configuration);
  }
} catch (error) {
  console.error(`Chat load simulation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  benchmarkActive = false;

  for (const socket of sockets) {
    socket.close();
  }

  process.removeListener('SIGINT', requestStop);
  process.removeListener('SIGTERM', requestStop);
}

async function run(configuration) {
  const setupStartedAt = performance.now();
  const runId = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const setupRandom = createRandom(configuration.seed);
  const plan = createConversationPlan(configuration, setupRandom);

  console.log('Running concurrent chat load simulation');
  console.log(`Target: ${configuration.baseUrl}`);
  console.log(
    `Plan: ${configuration.users} users, ${plan.directCount} direct chats, ${plan.groupCount} group chats, ${formatDuration(configuration.durationMs)}`,
  );
  console.log('Test records are retained; use a disposable environment.');

  const users = await createUsers(configuration, runId);
  console.log(`Setup: created ${users.length} users`);

  const conversations = await createConversations(configuration, runId, users, plan.specs);
  const memberships = indexMemberships(configuration.users, conversations);
  console.log(`Setup: created ${conversations.length} conversations`);

  const clients = await connectClients(configuration, users);
  const setupDurationMs = performance.now() - setupStartedAt;
  console.log(`Setup: ${clients.length} WebSocket clients are ready`);
  console.log('Measurement started');

  const metrics = createMetrics(configuration, users, memberships);
  attachClientObservers(clients, metrics);
  benchmarkActive = true;

  const measurementStartedAt = performance.now();
  const deadline = measurementStartedAt + configuration.durationMs;

  await Promise.all(
    clients.map((socket, userIndex) =>
      runClient({
        socket,
        userIndex,
        conversations: memberships[userIndex],
        configuration,
        deadline,
        metrics,
      }),
    ),
  );

  const schedulingFinishedAt = performance.now();
  await waitForDeliveries(metrics, configuration.deliveryGraceMs);
  benchmarkActive = false;

  const result = buildResult({
    configuration,
    plan,
    setupDurationMs,
    measurementStartedAt,
    schedulingFinishedAt,
    metrics,
  });

  console.log('Measurement completed');
  console.log(JSON.stringify(result, null, 2));
}

async function createUsers(configuration, runId) {
  const tasks = Array.from({ length: configuration.users }, (_, index) => async () => {
    const label = String(index + 1).padStart(6, '0');
    const response = await api(configuration, 'POST', '/auth/register', {
      body: {
        email: `load.${runId}.${label}@example.com`,
        username: `load_${runId}_${label}`.slice(0, 32),
        password: PASSWORD,
      },
      expectedStatus: 201,
    });

    return response.data;
  });

  return runPool(tasks, configuration.setupConcurrency);
}

async function createConversations(configuration, runId, users, specs) {
  const tasks = specs.map((spec, index) => async () => {
    const ownerIndex = spec.memberIndexes[0];
    const owner = users[ownerIndex];
    let response;

    if (spec.type === 'DIRECT') {
      response = await api(configuration, 'POST', '/conversations/direct', {
        token: owner.tokens.accessToken,
        body: { userId: users[spec.memberIndexes[1]].user.id },
        expectedStatus: 200,
      });
    } else {
      response = await api(configuration, 'POST', '/conversations/group', {
        token: owner.tokens.accessToken,
        body: {
          name: `Load ${runId} group ${index + 1}`,
          memberIds: spec.memberIndexes.slice(1).map((memberIndex) => users[memberIndex].user.id),
        },
        expectedStatus: 201,
      });
    }

    return {
      id: response.data.conversation.id,
      type: spec.type,
      memberIndexes: spec.memberIndexes,
    };
  });

  return runPool(tasks, configuration.setupConcurrency);
}

function indexMemberships(userCount, conversations) {
  const memberships = Array.from({ length: userCount }, () => []);

  for (const conversation of conversations) {
    for (const memberIndex of conversation.memberIndexes) {
      memberships[memberIndex].push(conversation);
    }
  }

  const uncoveredIndex = memberships.findIndex((items) => items.length === 0);

  if (uncoveredIndex !== -1) {
    throw new Error(`User ${uncoveredIndex + 1} has no conversation in the generated plan`);
  }

  return memberships;
}

async function connectClients(configuration, users) {
  const tasks = users.map(
    (entry) => async () => connectSocket(configuration, entry.tokens.accessToken),
  );

  return runPool(tasks, configuration.connectConcurrency);
}

async function connectSocket(configuration, token) {
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
      configuration.requestTimeoutMs,
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

function createMetrics(configuration, users, memberships) {
  return {
    configuration,
    userIds: users.map((entry) => entry.user.id),
    memberships,
    attempted: 0,
    acknowledgementsSucceeded: 0,
    acknowledgementsRejected: 0,
    acknowledgementErrors: 0,
    acknowledgementLatencies: [],
    rejectionCodes: new Map(),
    acknowledgementErrorReasons: new Map(),
    records: new Map(),
    duplicateRecipientEvents: 0,
    unmatchedLoadEvents: 0,
    unexpectedDisconnects: 0,
    disconnectReasons: new Map(),
  };
}

function attachClientObservers(clients, metrics) {
  clients.forEach((socket, recipientIndex) => {
    socket.on('message:new', (event) => recordDelivery(metrics, recipientIndex, event));
    socket.on('disconnect', (reason) => {
      if (!benchmarkActive) {
        return;
      }

      metrics.unexpectedDisconnects += 1;
      increment(metrics.disconnectReasons, reason);
    });
  });
}

async function runClient({ socket, userIndex, conversations, configuration, deadline, metrics }) {
  const random = createRandom(`${configuration.seed}:client:${userIndex}`);
  let sequence = 0;

  while (!stopController.signal.aborted) {
    const remainingMs = deadline - performance.now();

    if (remainingMs <= 0) {
      return;
    }

    const waitMs = randomInteger(random, configuration.minDelayMs, configuration.maxDelayMs);

    if (waitMs >= remainingMs) {
      await interruptibleDelay(remainingMs);
      return;
    }

    if (!(await interruptibleDelay(waitMs))) {
      return;
    }

    const conversation = randomItem(random, conversations);
    sequence += 1;
    await sendMessage({
      socket,
      userIndex,
      conversation,
      sequence,
      configuration,
      metrics,
    });
  }
}

async function sendMessage({ socket, userIndex, conversation, sequence, configuration, metrics }) {
  const clientMessageId = randomUUID();
  const startedAt = performance.now();
  const expectedRecipientIndexes = conversation.memberIndexes.filter(
    (memberIndex) => memberIndex !== userIndex,
  );
  const record = {
    clientMessageId,
    senderIndex: userIndex,
    conversationId: conversation.id,
    expectedRecipientIndexes: new Set(expectedRecipientIndexes),
    recipientLatencies: new Map(),
    startedAt,
    acknowledged: false,
  };

  metrics.records.set(clientMessageId, record);
  metrics.attempted += 1;

  try {
    const acknowledgement = await socket
      .timeout(configuration.ackTimeoutMs)
      .emitWithAck('message:send', {
        conversationId: conversation.id,
        clientMessageId,
        body: `Load test user ${userIndex + 1} message ${sequence}`,
      });

    if (acknowledgement?.ok !== true) {
      metrics.acknowledgementsRejected += 1;
      increment(metrics.rejectionCodes, acknowledgement?.error?.code ?? 'UNKNOWN');
      return;
    }

    const message = acknowledgement.data?.message;

    if (
      acknowledgement.data?.created !== true ||
      message?.clientMessageId !== clientMessageId ||
      message?.conversationId !== conversation.id ||
      message?.senderId !== metrics.userIds[userIndex]
    ) {
      metrics.acknowledgementsRejected += 1;
      increment(metrics.rejectionCodes, 'INVALID_ACKNOWLEDGEMENT');
      return;
    }

    record.acknowledged = true;
    metrics.acknowledgementsSucceeded += 1;
    metrics.acknowledgementLatencies.push(performance.now() - startedAt);
  } catch (error) {
    metrics.acknowledgementErrors += 1;
    increment(metrics.acknowledgementErrorReasons, error.message ?? error.name ?? 'UNKNOWN');
  }
}

function recordDelivery(metrics, recipientIndex, event) {
  const clientMessageId = event?.message?.clientMessageId;

  if (typeof clientMessageId !== 'string') {
    return;
  }

  const record = metrics.records.get(clientMessageId);

  if (!record) {
    if (event?.message?.body?.startsWith('Load test user ')) {
      metrics.unmatchedLoadEvents += 1;
    }

    return;
  }

  if (recipientIndex === record.senderIndex) {
    return;
  }

  if (!record.expectedRecipientIndexes.has(recipientIndex)) {
    metrics.unmatchedLoadEvents += 1;
    return;
  }

  if (record.recipientLatencies.has(recipientIndex)) {
    metrics.duplicateRecipientEvents += 1;
    return;
  }

  record.recipientLatencies.set(recipientIndex, performance.now() - record.startedAt);
}

async function waitForDeliveries(metrics, graceMs) {
  const deadline = performance.now() + graceMs;

  while (performance.now() < deadline && hasMissingDeliveries(metrics)) {
    await delay(Math.min(25, deadline - performance.now()));
  }
}

function hasMissingDeliveries(metrics) {
  for (const record of metrics.records.values()) {
    if (
      record.acknowledged &&
      record.recipientLatencies.size < record.expectedRecipientIndexes.size
    ) {
      return true;
    }
  }

  return false;
}

function buildResult({
  configuration,
  plan,
  setupDurationMs,
  measurementStartedAt,
  schedulingFinishedAt,
  metrics,
}) {
  const acknowledgedRecords = [...metrics.records.values()].filter((record) => record.acknowledged);
  const firstDeliveryLatencies = [];
  const allDeliveryLatencies = [];
  let expectedRecipientEvents = 0;
  let receivedRecipientEvents = 0;
  let messagesDeliveredToEveryRecipient = 0;

  for (const record of acknowledgedRecords) {
    const latencies = [...record.recipientLatencies.values()];

    expectedRecipientEvents += record.expectedRecipientIndexes.size;
    receivedRecipientEvents += latencies.length;
    allDeliveryLatencies.push(...latencies);

    if (latencies.length > 0) {
      firstDeliveryLatencies.push(Math.min(...latencies));
    }

    if (latencies.length === record.expectedRecipientIndexes.size) {
      messagesDeliveredToEveryRecipient += 1;
    }
  }

  const measurementDurationMs = Math.min(
    configuration.durationMs,
    schedulingFinishedAt - measurementStartedAt,
  );
  const measurementDurationSeconds = measurementDurationMs / 1000;

  return {
    target: configuration.baseUrl,
    measuredAt: new Date().toISOString(),
    seed: configuration.seed,
    node: process.version,
    transport: 'websocket',
    setup: {
      durationMs: round(setupDurationMs),
      usersCreated: configuration.users,
      socketClientsReady: configuration.users,
      conversationsCreated: configuration.chats,
      directConversations: plan.directCount,
      groupConversations: plan.groupCount,
    },
    measurement: {
      configuredDurationMs: configuration.durationMs,
      actualSchedulingDurationMs: round(schedulingFinishedAt - measurementStartedAt),
      randomDelayMs: { min: configuration.minDelayMs, max: configuration.maxDelayMs },
      messagesAttempted: metrics.attempted,
      messagesAcknowledged: metrics.acknowledgementsSucceeded,
      messagesRejected: metrics.acknowledgementsRejected,
      acknowledgementErrorsOrTimeouts: metrics.acknowledgementErrors,
      attemptedMessagesPerSecond: round(safeRate(metrics.attempted, measurementDurationSeconds)),
      acknowledgedMessagesPerSecond: round(
        safeRate(metrics.acknowledgementsSucceeded, measurementDurationSeconds),
      ),
      recipientEventsPerSecond: round(
        safeRate(receivedRecipientEvents, measurementDurationSeconds),
      ),
      acknowledgementSuccessPercent: round(
        safePercent(metrics.acknowledgementsSucceeded, metrics.attempted),
      ),
      acknowledgementLatencyMs: summarize(metrics.acknowledgementLatencies),
      firstRecipientDeliveryLatencyMs: summarize(firstDeliveryLatencies),
      allRecipientDeliveryLatencyMs: summarize(allDeliveryLatencies),
      expectedRecipientEvents,
      receivedRecipientEvents,
      recipientDeliveryCompletenessPercent: round(
        safePercent(receivedRecipientEvents, expectedRecipientEvents),
      ),
      messagesDeliveredToEveryRecipient,
      duplicateRecipientEvents: metrics.duplicateRecipientEvents,
      unmatchedLoadEvents: metrics.unmatchedLoadEvents,
      unexpectedDisconnects: metrics.unexpectedDisconnects,
      rejectionCodes: Object.fromEntries(metrics.rejectionCodes),
      acknowledgementErrorReasons: Object.fromEntries(metrics.acknowledgementErrorReasons),
      disconnectReasons: Object.fromEntries(metrics.disconnectReasons),
    },
  };
}

function createConversationPlan(configuration, random) {
  const groupCount = Math.round((configuration.chats * (100 - DIRECT_CHAT_PERCENT)) / 100);
  const directCount = configuration.chats - groupCount;
  const maximumDirects = (configuration.users * (configuration.users - 1)) / 2;

  if (directCount > maximumDirects) {
    throw new Error(
      `${directCount} unique direct chats require more than ${configuration.users} users; the maximum is ${maximumDirects}`,
    );
  }

  if (groupCount > 0 && configuration.groupMinSize > configuration.users) {
    throw new Error(
      `Group minimum size ${configuration.groupMinSize} exceeds user count ${configuration.users}`,
    );
  }

  const effectiveGroupMaxSize = Math.min(configuration.groupMaxSize, configuration.users);

  const shuffledUsers = shuffle(
    random,
    Array.from({ length: configuration.users }, (_, index) => index),
  );
  const specs = [];
  const directKeys = new Set();
  let coveredUserCount = 0;

  for (let index = 0; index < directCount; index += 1) {
    let members;

    if (coveredUserCount + 1 < shuffledUsers.length) {
      members = [shuffledUsers[coveredUserCount], shuffledUsers[coveredUserCount + 1]];
      coveredUserCount += 2;
    } else if (coveredUserCount < shuffledUsers.length) {
      members = findUniquePair(random, configuration.users, directKeys, [
        shuffledUsers[coveredUserCount],
      ]);
      coveredUserCount += 1;
    } else {
      members = findUniquePair(random, configuration.users, directKeys);
    }

    const key = directKey(members);

    if (directKeys.has(key)) {
      members = findUniquePair(random, configuration.users, directKeys);
    }

    directKeys.add(directKey(members));
    specs.push({ type: 'DIRECT', memberIndexes: members });
  }

  const groupTargets = Array.from({ length: groupCount }, () =>
    randomInteger(random, configuration.groupMinSize, effectiveGroupMaxSize),
  );
  const uncoveredUsers = shuffledUsers.slice(coveredUserCount);
  let groupCapacity = groupTargets.reduce((total, size) => total + size, 0);

  while (groupCapacity < uncoveredUsers.length) {
    const growableIndexes = groupTargets
      .map((size, index) => ({ size, index }))
      .filter(({ size }) => size < effectiveGroupMaxSize)
      .map(({ index }) => index);

    if (growableIndexes.length === 0) {
      throw new Error(
        `${configuration.users} users cannot all belong to a chat with this plan; increase --chats or --group-max-size`,
      );
    }

    const groupIndex = randomItem(random, growableIndexes);
    groupTargets[groupIndex] += 1;
    groupCapacity += 1;
  }

  const groupMembers = groupTargets.map(() => []);

  for (const userIndex of uncoveredUsers) {
    const availableGroups = groupMembers
      .map((members, index) => ({ members, index }))
      .filter(({ members, index }) => members.length < groupTargets[index])
      .map(({ index }) => index);
    groupMembers[randomItem(random, availableGroups)].push(userIndex);
  }

  for (let groupIndex = 0; groupIndex < groupMembers.length; groupIndex += 1) {
    const members = groupMembers[groupIndex];

    while (members.length < groupTargets[groupIndex]) {
      const candidate = randomInteger(random, 0, configuration.users - 1);

      if (!members.includes(candidate)) {
        members.push(candidate);
      }
    }

    shuffle(random, members);
    specs.push({ type: 'GROUP', memberIndexes: members });
  }

  if (coveredUserCount < configuration.users && groupCount === 0) {
    throw new Error(
      `${configuration.users} users cannot all belong to ${directCount} direct chats; increase --chats`,
    );
  }

  return { directCount, groupCount, specs };
}

function findUniquePair(random, userCount, existingKeys, preferred = []) {
  const maximumAttempts = Math.max(100, userCount * 4);

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const first = preferred[0] ?? randomInteger(random, 0, userCount - 1);
    let second = randomInteger(random, 0, userCount - 1);

    while (second === first) {
      second = randomInteger(random, 0, userCount - 1);
    }

    const pair = [first, second];

    if (!existingKeys.has(directKey(pair))) {
      return pair;
    }
  }

  for (let first = 0; first < userCount; first += 1) {
    for (let second = first + 1; second < userCount; second += 1) {
      const pair = [preferred[0] ?? first, preferred[0] === undefined ? second : first];

      if (pair[0] !== pair[1] && !existingKeys.has(directKey(pair))) {
        return pair;
      }
    }
  }

  throw new Error('Unable to generate another unique direct conversation');
}

function directKey(memberIndexes) {
  return [...memberIndexes].sort((left, right) => left - right).join(':');
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function api(configuration, method, requestPath, { token, body, expectedStatus }) {
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
    signal: AbortSignal.timeout(configuration.requestTimeoutMs),
  });
  const responseBody = await readResponseBody(response);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${requestPath} returned ${response.status}; expected ${expectedStatus}: ${JSON.stringify(responseBody)}`,
    );
  }

  return responseBody;
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

function summarize(values) {
  if (values.length === 0) {
    return { samples: 0, min: null, p50: null, p95: null, p99: null, max: null };
  }

  const sorted = [...values].sort((left, right) => left - right);

  return {
    samples: sorted.length,
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1)),
  };
}

function percentile(sortedValues, fraction) {
  return sortedValues[Math.ceil(fraction * sortedValues.length) - 1];
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function safeRate(count, durationSeconds) {
  return durationSeconds > 0 ? count / durationSeconds : 0;
}

function safePercent(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function round(value) {
  return Number(value.toFixed(3));
}

async function interruptibleDelay(milliseconds) {
  try {
    await delay(milliseconds, undefined, { signal: stopController.signal });
    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      return false;
    }

    throw error;
  }
}

function requestStop() {
  if (!stopController.signal.aborted) {
    console.log('Stop requested; finishing in-flight sends...');
    stopController.abort();
  }
}

function createRandom(seed) {
  let state = hashSeed(seed);

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(value) {
  let hash = 2_166_136_261;

  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function randomInteger(random, minimum, maximum) {
  return Math.floor(random() * (maximum - minimum + 1)) + minimum;
}

function randomItem(random, values) {
  if (values.length === 0) {
    throw new Error('Cannot choose a random item from an empty collection');
  }

  return values[randomInteger(random, 0, values.length - 1)];
}

function shuffle(random, values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInteger(random, 0, index);
    [values[index], values[otherIndex]] = [values[otherIndex], values[index]];
  }

  return values;
}

function readConfiguration(arguments_) {
  const values = parseArguments(arguments_);

  if (values.help) {
    return { help: true };
  }

  const configuration = {
    baseUrl: normalizeBaseUrl(values['base-url'] ?? DEFAULTS.baseUrl),
    users: parseIntegerOption('users', values.users, DEFAULTS.users, 2),
    chats: parseIntegerOption('chats', values.chats, DEFAULTS.chats, 1),
    durationMs: parseDurationOption('duration', values.duration, DEFAULTS.durationMs, 1),
    minDelayMs: parseDurationOption('min-delay', values['min-delay'], DEFAULTS.minDelayMs, 1),
    maxDelayMs: parseDurationOption('max-delay', values['max-delay'], DEFAULTS.maxDelayMs, 1),
    groupMinSize: parseIntegerOption(
      'group-min-size',
      values['group-min-size'],
      DEFAULTS.groupMinSize,
      2,
      100,
    ),
    groupMaxSize: parseIntegerOption(
      'group-max-size',
      values['group-max-size'],
      DEFAULTS.groupMaxSize,
      2,
      100,
    ),
    setupConcurrency: parseIntegerOption(
      'setup-concurrency',
      values['setup-concurrency'],
      DEFAULTS.setupConcurrency,
      1,
      1_000,
    ),
    connectConcurrency: parseIntegerOption(
      'connect-concurrency',
      values['connect-concurrency'],
      DEFAULTS.connectConcurrency,
      1,
      10_000,
    ),
    requestTimeoutMs: parseDurationOption(
      'request-timeout',
      values['request-timeout'],
      DEFAULTS.requestTimeoutMs,
      100,
    ),
    ackTimeoutMs: parseDurationOption(
      'ack-timeout',
      values['ack-timeout'],
      DEFAULTS.ackTimeoutMs,
      100,
    ),
    deliveryGraceMs: parseDurationOption(
      'delivery-grace',
      values['delivery-grace'],
      DEFAULTS.deliveryGraceMs,
      0,
    ),
    seed: values.seed ?? randomUUID(),
  };

  if (configuration.minDelayMs > configuration.maxDelayMs) {
    throw new Error('--min-delay must be less than or equal to --max-delay');
  }

  if (configuration.groupMinSize > configuration.groupMaxSize) {
    throw new Error('--group-min-size must be less than or equal to --group-max-size');
  }

  return configuration;
}

function parseArguments(arguments_) {
  const supported = new Set([
    'base-url',
    'users',
    'chats',
    'duration',
    'min-delay',
    'max-delay',
    'group-min-size',
    'group-max-size',
    'setup-concurrency',
    'connect-concurrency',
    'request-timeout',
    'ack-timeout',
    'delivery-grace',
    'seed',
    'help',
  ]);
  const values = {};

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }

    const [rawName, inlineValue] = argument.slice(2).split('=', 2);

    if (!supported.has(rawName)) {
      throw new Error(`Unknown option: --${rawName}`);
    }

    if (rawName === 'help') {
      values.help = true;
      continue;
    }

    const value = inlineValue ?? arguments_[index + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option --${rawName} requires a value`);
    }

    values[rawName] = value;

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return values;
}

function normalizeBaseUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error('--base-url must be a valid HTTP(S) URL');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('--base-url must be an HTTP(S) origin without a path');
  }

  return url.origin;
}

function parseIntegerOption(name, rawValue, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = rawValue === undefined ? fallback : Number(rawValue);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}`);
  }

  return value;
}

function parseDurationOption(name, rawValue, fallback, minimum) {
  if (rawValue === undefined) {
    return fallback;
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(rawValue);

  if (!match) {
    throw new Error(`--${name} must be a duration such as 500ms, 30s, 5m, or 1h`);
  }

  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const value = Number(match[1]) * multipliers[match[2]];

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be at least ${minimum}ms and resolve to whole milliseconds`);
  }

  return value;
}

function formatDuration(milliseconds) {
  if (milliseconds % 60_000 === 0) {
    return `${milliseconds / 60_000}m`;
  }

  if (milliseconds % 1_000 === 0) {
    return `${milliseconds / 1_000}s`;
  }

  return `${milliseconds}ms`;
}

function printUsage() {
  console.log(`Usage:
  node scripts/run-chat-load.js [options]

Options:
  --base-url URL             API origin (default: ${DEFAULTS.baseUrl})
  --users N                  Number of users and socket clients (default: ${DEFAULTS.users})
  --chats N                  Number of conversations (default: ${DEFAULTS.chats})
  --duration TIME            Measurement duration (default: 5m)
  --min-delay TIME           Minimum delay per client send (default: 1s)
  --max-delay TIME           Maximum delay per client send (default: 30s)
  --group-min-size N         Minimum group membership (default: ${DEFAULTS.groupMinSize})
  --group-max-size N         Maximum group membership (default: ${DEFAULTS.groupMaxSize})
  --setup-concurrency N      Concurrent REST setup calls (default: ${DEFAULTS.setupConcurrency})
  --connect-concurrency N    Concurrent socket connections (default: ${DEFAULTS.connectConcurrency})
  --request-timeout TIME     REST/connect timeout (default: 30s)
  --ack-timeout TIME         message:send ACK timeout (default: 10s)
  --delivery-grace TIME      Final recipient-event grace period (default: 2s)
  --seed VALUE               Reproducible chat plan and client choices
  --help                     Show this help

Durations accept ms, s, m, or h. The chat mix is 90% direct and 10% group.

Example:
  node scripts/run-chat-load.js --users 100 --chats 200 --duration 5m`);
}
