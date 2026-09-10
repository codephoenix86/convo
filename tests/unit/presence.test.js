import { describe, expect, it, vi } from 'vitest';

import { getConversationRoom, getUserRoom } from '../../src/realtime/rooms.js';
import { createPresenceCoordinator } from '../../src/realtime/presence.js';

const firstUserId = '8ea637a5-67c5-481f-8073-e0a9264fc306';
const secondUserId = '60c0ba6c-4752-4897-9f25-55a50e9b6da5';
const hiddenUserId = 'e353c8ab-ab4b-4c25-9ce7-270de287c4ce';
const conversationId = '06aa708c-4dc8-4bb1-a994-8d6d906900da';
const hiddenConversationId = '293a7acd-6d93-4a38-a18a-dad599903e23';

describe('presence coordinator', () => {
  it('publishes online for the first device and offline after the last device', () => {
    let currentTime = Date.parse('2026-09-10T10:00:00.000Z');
    const { coordinator } = createFixture({ now: () => currentTime });
    const firstSocket = createSocket('socket-1', firstUserId, [conversationId]);
    const secondSocket = createSocket('socket-2', firstUserId, [conversationId]);

    expect(coordinator.connectSocket(firstSocket)).toEqual({
      activeConnections: 1,
      activeUsers: 1,
      userConnections: 1,
    });
    expect(firstSocket.outbound.emit).toHaveBeenCalledWith('presence:update', {
      presence: {
        userId: firstUserId,
        isOnline: true,
        changedAt: '2026-09-10T10:00:00.000Z',
      },
    });

    expect(coordinator.connectSocket(secondSocket)).toEqual({
      activeConnections: 2,
      activeUsers: 1,
      userConnections: 2,
    });
    expect(secondSocket.outbound.emit).not.toHaveBeenCalled();

    expect(coordinator.disconnectSocket(firstSocket)).toEqual({
      activeConnections: 1,
      activeUsers: 1,
      userConnections: 1,
    });
    expect(firstSocket.outbound.emit).toHaveBeenCalledOnce();

    currentTime += 5_000;
    expect(coordinator.disconnectSocket(secondSocket)).toEqual({
      activeConnections: 0,
      activeUsers: 0,
      userConnections: 0,
    });
    expect(secondSocket.outbound.emit).toHaveBeenCalledWith('presence:update', {
      presence: {
        userId: firstUserId,
        isOnline: false,
        changedAt: '2026-09-10T10:00:05.000Z',
      },
    });
  });

  it('returns a deduplicated snapshot limited to shared conversation rooms', () => {
    const { coordinator, namespace } = createFixture();
    const requester = createSocket('requester', firstUserId, [conversationId]);
    const visibleFirstDevice = createSocket('visible-1', secondUserId, [conversationId]);
    const visibleSecondDevice = createSocket('visible-2', secondUserId, [conversationId]);
    const hiddenSocket = createSocket('hidden', hiddenUserId, [hiddenConversationId]);
    const sockets = [requester, visibleFirstDevice, visibleSecondDevice, hiddenSocket];

    for (const socket of sockets) {
      namespace.sockets.set(socket.id, socket);
      coordinator.connectSocket(socket);
    }
    namespace.adapter.rooms.set(
      getConversationRoom(conversationId),
      new Set(['requester', 'visible-1', 'visible-2']),
    );
    namespace.adapter.rooms.set(getConversationRoom(hiddenConversationId), new Set(['hidden']));

    const items = coordinator.sendSnapshot(requester);

    expect(items).toEqual([expect.objectContaining({ userId: secondUserId, isOnline: true })]);
    expect(requester.emit).toHaveBeenCalledWith('presence:snapshot', { items });
  });

  it('fails fast before being attached and cannot attach twice', () => {
    const coordinator = createPresenceCoordinator();
    const socket = createSocket('socket-1', firstUserId, []);

    expect(() => coordinator.connectSocket(socket)).toThrow('Presence coordinator is not attached');

    coordinator.attach({});
    expect(() => coordinator.attach({})).toThrow('Presence coordinator is already attached');
  });
});

function createFixture(options) {
  const namespace = {
    adapter: { rooms: new Map() },
    sockets: new Map(),
  };
  const io = { of: vi.fn().mockReturnValue(namespace) };
  const coordinator = createPresenceCoordinator(options);

  coordinator.attach(io);

  return { coordinator, namespace };
}

function createSocket(id, userId, conversationIds) {
  const outbound = { emit: vi.fn() };

  return {
    id,
    data: { user: { id: userId } },
    rooms: new Set([id, getUserRoom(userId), ...conversationIds.map(getConversationRoom)]),
    to: vi.fn().mockReturnValue(outbound),
    emit: vi.fn(),
    outbound,
  };
}
