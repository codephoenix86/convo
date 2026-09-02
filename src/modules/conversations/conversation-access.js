import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

export const GROUP_MANAGER_ROLES = Object.freeze(['OWNER', 'ADMIN']);

export function requireConversationMember(context, userId) {
  if (!context) {
    throw new NotFoundError('Conversation not found');
  }

  const membership = context.members.find((member) => member.userId === userId);

  if (!membership) {
    throw new NotFoundError('Conversation not found');
  }

  return membership;
}

export function requireGroupMember(context, userId) {
  if (context?.type !== 'GROUP') {
    throw new NotFoundError('Conversation not found');
  }

  return requireConversationMember(context, userId);
}

export function requireGroupRole(context, userId, allowedRoles) {
  const membership = requireGroupMember(context, userId);

  if (!allowedRoles.includes(membership.role)) {
    throw new ForbiddenError('Your group role does not allow this action');
  }

  return membership;
}

export function allowedRolesForAdding(role) {
  return role === 'ADMIN' ? ['OWNER'] : GROUP_MANAGER_ROLES;
}

export function requireMemberRemovalPermission(context, actorId, targetId) {
  const actor = requireGroupMember(context, actorId);
  const target = requireGroupMember(context, targetId);

  if (target.role === 'OWNER') {
    throw new ForbiddenError('The group owner cannot be removed');
  }

  if (actor.role === 'OWNER' || (actor.role === 'ADMIN' && target.role === 'MEMBER')) {
    return { actor, target };
  }

  throw new ForbiddenError('Your group role does not allow this action');
}

export function requireRoleChangePermission(context, actorId, targetId) {
  const actor = requireGroupRole(context, actorId, ['OWNER']);
  const target = requireGroupMember(context, targetId);

  if (target.role === 'OWNER') {
    throw new ForbiddenError('The group owner role cannot be changed');
  }

  return { actor, target };
}
