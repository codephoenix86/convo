import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../src/lib/errors.js';
import { createConversationsService } from '../../src/modules/conversations/conversations.service.js';

const conversationId = randomUUID();
const ownerId = randomUUID();
const adminId = randomUUID();
const memberId = randomUUID();
const newUserId = randomUUID();

function accessContext(...members) {
  return { id: conversationId, type: 'GROUP', members };
}

function storedConversation() {
  return {
    id: conversationId,
    type: 'GROUP',
    name: 'Backend Team',
    imageUrl: null,
    createdById: ownerId,
    createdAt: new Date(),
    updatedAt: new Date(),
    members: [],
    messages: [],
  };
}

function createRepository(context) {
  return {
    findAccessContext: vi.fn().mockResolvedValue(context),
    addGroupMember: vi.fn().mockResolvedValue(storedConversation()),
    removeGroupMember: vi.fn().mockResolvedValue(storedConversation()),
    updateGroupMemberRole: vi.fn().mockResolvedValue(storedConversation()),
  };
}

describe('group membership service', () => {
  it('allows an admin to add a regular member', async () => {
    const repository = createRepository(accessContext({ userId: adminId, role: 'ADMIN' }));
    const service = createConversationsService(repository);

    await service.addMember(adminId, conversationId, { userId: newUserId, role: 'MEMBER' });

    expect(repository.addGroupMember).toHaveBeenCalledWith({
      conversationId,
      actorId: adminId,
      actorRoles: ['OWNER', 'ADMIN'],
      userId: newUserId,
      role: 'MEMBER',
    });
  });

  it('prevents an admin from adding another admin', async () => {
    const repository = createRepository(accessContext({ userId: adminId, role: 'ADMIN' }));
    const service = createConversationsService(repository);

    await expect(
      service.addMember(adminId, conversationId, { userId: newUserId, role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repository.addGroupMember).not.toHaveBeenCalled();
  });

  it('allows an admin to remove a member with an atomic role predicate', async () => {
    const repository = createRepository(
      accessContext({ userId: adminId, role: 'ADMIN' }, { userId: memberId, role: 'MEMBER' }),
    );
    const service = createConversationsService(repository);

    await service.removeMember(adminId, conversationId, memberId);

    expect(repository.removeGroupMember).toHaveBeenCalledWith({
      conversationId,
      actorId: adminId,
      actorRoles: ['ADMIN'],
      userId: memberId,
      targetRole: 'MEMBER',
    });
  });

  it('allows only the owner to promote or demote non-owner members', async () => {
    const repository = createRepository(
      accessContext({ userId: ownerId, role: 'OWNER' }, { userId: memberId, role: 'MEMBER' }),
    );
    const service = createConversationsService(repository);

    await service.updateMemberRole(ownerId, conversationId, memberId, 'ADMIN');

    expect(repository.updateGroupMemberRole).toHaveBeenCalledWith({
      conversationId,
      actorId: ownerId,
      actorRoles: ['OWNER'],
      userId: memberId,
      currentRole: 'MEMBER',
      role: 'ADMIN',
    });
  });
});
