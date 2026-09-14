import { randomUUID } from 'node:crypto';

import { io as createSocketClient } from 'socket.io-client';

const baseUrl = normalizeBaseUrl(process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000');
const runId = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const password = 'Demo-password1!';
const sockets = [];

try {
  console.log(`Running Convo demo against ${baseUrl}`);

  const [alice, bob, charlie] = await Promise.all([
    registerUser('alice'),
    registerUser('bob'),
    registerUser('charlie'),
  ]);
  console.log('1/7 Registered three isolated demo users');

  const direct = await api('POST', '/conversations/direct', {
    token: alice.tokens.accessToken,
    body: { userId: bob.user.id },
    expectedStatus: 200,
  });
  const directRetry = await api('POST', '/conversations/direct', {
    token: bob.tokens.accessToken,
    body: { userId: alice.user.id },
    expectedStatus: 200,
  });
  assert(
    direct.body.data.conversation.id === directRetry.body.data.conversation.id,
    'Direct-conversation retry returned a different conversation',
  );
  const conversationId = direct.body.data.conversation.id;
  console.log('2/7 Created and reused one canonical direct conversation');

  const group = await api('POST', '/conversations/group', {
    token: alice.tokens.accessToken,
    body: {
      name: `Demo group ${runId}`,
      memberIds: [bob.user.id, charlie.user.id],
    },
    expectedStatus: 201,
  });
  const forbiddenRename = await api('PATCH', `/conversations/${group.body.data.conversation.id}`, {
    token: charlie.tokens.accessToken,
    body: { name: 'Unauthorized rename' },
    expectedStatus: 403,
  });
  assert(forbiddenRename.body.error.code === 'FORBIDDEN', 'Member role boundary was not enforced');
  console.log('3/7 Created a group and verified member/admin authorization');

  const aliceSocket = await connectSocket(alice.tokens.accessToken);
  const bobSocket = await connectSocket(bob.tokens.accessToken);
  const clientMessageId = randomUUID();
  const receivedDirectMessage = waitForMatchingEvent(
    bobSocket,
    'message:new',
    (event) => event.message.clientMessageId === clientMessageId,
  );
  const sendAcknowledgement = await aliceSocket.timeout(5_000).emitWithAck('message:send', {
    conversationId,
    clientMessageId,
    body: 'Realtime demo message',
  });

  assertAcknowledgement(sendAcknowledgement, 'message:send');
  assert(sendAcknowledgement.data.created === true, 'First message send was not marked as created');
  const directMessageEvent = await receivedDirectMessage;
  assert(
    directMessageEvent.message.id === sendAcknowledgement.data.message.id,
    'Recipient event did not contain the acknowledged canonical message',
  );

  const groupClientMessageId = randomUUID();
  const receivedGroupMessage = waitForMatchingEvent(
    bobSocket,
    'message:new',
    (event) => event.message.clientMessageId === groupClientMessageId,
  );
  const groupSendAcknowledgement = await aliceSocket.timeout(5_000).emitWithAck('message:send', {
    conversationId: group.body.data.conversation.id,
    clientMessageId: groupClientMessageId,
    body: 'Realtime group demo message',
  });

  assertAcknowledgement(groupSendAcknowledgement, 'group message:send');
  const groupMessageEvent = await receivedGroupMessage;
  assert(
    groupMessageEvent.message.id === groupSendAcknowledgement.data.message.id,
    'Group recipient event did not contain the acknowledged canonical message',
  );
  console.log('4/7 Sent, acknowledged, persisted, and received direct and group realtime messages');

  const readEvent = waitForMatchingEvent(
    aliceSocket,
    'conversation:read',
    (event) => event.receipt.userId === bob.user.id,
  );
  const readAcknowledgement = await bobSocket.timeout(5_000).emitWithAck('conversation:read', {
    conversationId,
    messageId: sendAcknowledgement.data.message.id,
  });

  assertAcknowledgement(readAcknowledgement, 'conversation:read');
  await readEvent;
  console.log('5/7 Persisted and broadcast the recipient read position');

  const idempotentRetry = await api('POST', `/conversations/${conversationId}/messages`, {
    token: alice.tokens.accessToken,
    body: { clientMessageId, body: 'A retry cannot replace the canonical body' },
    expectedStatus: 200,
  });
  assert(
    idempotentRetry.body.data.message.id === sendAcknowledgement.data.message.id,
    'Cross-transport retry returned a different message',
  );
  assert(
    idempotentRetry.body.data.message.body === 'Realtime demo message',
    'Cross-transport retry replaced the canonical body',
  );
  console.log('6/7 Retried over REST without creating or changing the message');

  bobSocket.disconnect();
  const missedClientMessageId = randomUUID();
  const missedSend = await api('POST', `/conversations/${conversationId}/messages`, {
    token: alice.tokens.accessToken,
    body: { clientMessageId: missedClientMessageId, body: 'Message sent while Bob was offline' },
    expectedStatus: 201,
  });

  const reconnected = waitForEvent(bobSocket, 'connect');
  const ready = waitForEvent(bobSocket, 'session:ready');
  bobSocket.connect();
  await reconnected;
  await ready;

  const history = await api('GET', `/conversations/${conversationId}/messages?limit=50`, {
    token: bob.tokens.accessToken,
    expectedStatus: 200,
  });
  assert(
    history.body.data.items.some((message) => message.id === missedSend.body.data.message.id),
    'REST resynchronization did not recover the message sent while offline',
  );
  console.log('7/7 Reconnected, restored rooms, and recovered missed history through REST');
  console.log('Demo completed successfully.');
} catch (error) {
  console.error('Demo failed:', error.message);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) {
    socket.close();
  }
}

async function registerUser(label) {
  const response = await api('POST', '/auth/register', {
    body: {
      email: `${label}.${runId}@example.com`,
      username: `${label}_${runId}`.slice(0, 32),
      password,
    },
    expectedStatus: 201,
  });

  return response.body.data;
}

async function connectSocket(token) {
  const socket = createSocketClient(baseUrl, {
    auth: { token },
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  });
  const connected = waitForEvent(socket, 'connect');
  const ready = waitForEvent(socket, 'session:ready');

  sockets.push(socket);
  socket.connect();
  await connected;
  await ready;

  return socket;
}

async function api(method, path, { token, body, expectedStatus } = {}) {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await readResponseBody(response);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}; expected ${expectedStatus}: ${JSON.stringify(responseBody)}`,
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

function waitForEvent(socket, eventName, timeoutMs = 5_000) {
  return waitForMatchingEvent(socket, eventName, () => true, timeoutMs);
}

function waitForMatchingEvent(socket, eventName, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handleEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

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

function normalizeBaseUrl(value) {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('DEMO_BASE_URL must use HTTP or HTTPS');
  }

  return url.origin;
}
