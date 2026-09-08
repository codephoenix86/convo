import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createRealtimeMessageEvents } from '../../src/realtime/message-events.js';
import { getConversationRoom } from '../../src/realtime/rooms.js';

const conversationId = randomUUID();

describe('realtime message events', () => {
  it('publishes the canonical message to its conversation room', async () => {
    const room = { emit: vi.fn() };
    const socketServer = { to: vi.fn().mockReturnValue(room) };
    const messageEvents = createRealtimeMessageEvents();
    const message = {
      id: randomUUID(),
      conversationId,
      senderId: randomUUID(),
      clientMessageId: randomUUID(),
      body: 'Canonical body',
      createdAt: new Date('2026-09-02T10:00:00.000Z'),
    };

    messageEvents.attach(socketServer);
    await messageEvents.messageCreated({ message });

    expect(socketServer.to).toHaveBeenCalledWith(getConversationRoom(conversationId));
    expect(room.emit).toHaveBeenCalledWith('message:new', { message });
  });

  it('fails fast before the publisher is attached to Socket.IO', async () => {
    const messageEvents = createRealtimeMessageEvents();

    await expect(messageEvents.messageCreated({ message: { conversationId } })).rejects.toThrow(
      'Realtime message events are not attached',
    );
  });

  it('cannot be attached to multiple Socket.IO servers', () => {
    const messageEvents = createRealtimeMessageEvents();

    messageEvents.attach({});

    expect(() => messageEvents.attach({})).toThrow('Realtime message events are already attached');
  });
});
