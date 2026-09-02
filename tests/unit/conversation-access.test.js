import { describe, expect, it } from 'vitest';

import { ForbiddenError, NotFoundError } from '../../src/lib/errors.js';
import {
  allowedRolesForAdding,
  requireConversationMember,
  requireGroupMember,
  requireGroupRole,
  requireMemberRemovalPermission,
  requireRoleChangePermission,
} from '../../src/modules/conversations/conversation-access.js';

const ownerId = 'owner';
const adminId = 'admin';
const memberId = 'member';
const context = {
  type: 'GROUP',
  members: [
    { userId: ownerId, role: 'OWNER' },
    { userId: adminId, role: 'ADMIN' },
    { userId: memberId, role: 'MEMBER' },
  ],
};

describe('centralized group access rules', () => {
  it('authorizes members of both direct and group conversations', () => {
    const directContext = { type: 'DIRECT', members: [{ userId: memberId, role: 'MEMBER' }] };

    expect(requireConversationMember(directContext, memberId)).toMatchObject({ role: 'MEMBER' });
    expect(requireConversationMember(context, memberId)).toMatchObject({ role: 'MEMBER' });
  });

  it('hides unknown, direct, and nonmember conversations', () => {
    expect(() => requireGroupMember(null, memberId)).toThrow(NotFoundError);
    expect(() => requireGroupMember({ type: 'DIRECT', members: [] }, memberId)).toThrow(
      NotFoundError,
    );
    expect(() => requireGroupMember(context, 'outsider')).toThrow(NotFoundError);
  });

  it('allows only configured roles to perform a group action', () => {
    expect(requireGroupRole(context, ownerId, ['OWNER'])).toMatchObject({ role: 'OWNER' });
    expect(() => requireGroupRole(context, memberId, ['OWNER', 'ADMIN'])).toThrow(ForbiddenError);
  });

  it('allows admins to add/remove members but not manage admins', () => {
    expect(allowedRolesForAdding('MEMBER')).toEqual(['OWNER', 'ADMIN']);
    expect(allowedRolesForAdding('ADMIN')).toEqual(['OWNER']);
    expect(requireMemberRemovalPermission(context, adminId, memberId)).toBeDefined();
    expect(() => requireMemberRemovalPermission(context, adminId, ownerId)).toThrow(ForbiddenError);
    expect(() => requireMemberRemovalPermission(context, adminId, adminId)).toThrow(ForbiddenError);
  });

  it('reserves promotions/demotions for the owner and protects the owner role', () => {
    expect(requireRoleChangePermission(context, ownerId, memberId)).toBeDefined();
    expect(() => requireRoleChangePermission(context, adminId, memberId)).toThrow(ForbiddenError);
    expect(() => requireRoleChangePermission(context, ownerId, ownerId)).toThrow(ForbiddenError);
  });
});
