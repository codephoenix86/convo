import { db } from '../src/config/db.js';
import { hashPassword } from '../src/modules/auth/password.js';

const DEMO_PASSWORD = 'Demo-password1!';
const ids = Object.freeze({
  alice: '10000000-0000-4000-8000-000000000001',
  bob: '10000000-0000-4000-8000-000000000002',
  maya: '10000000-0000-4000-8000-000000000003',
  group: '20000000-0000-4000-8000-000000000001',
  directMessages: [
    '30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
  ],
  groupMessages: ['40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002'],
});

const timestamps = Object.freeze({
  direct: [
    new Date('2026-09-01T09:00:00.000Z'),
    new Date('2026-09-01T09:02:00.000Z'),
    new Date('2026-09-01T09:05:00.000Z'),
  ],
  group: [new Date('2026-09-01T10:00:00.000Z'), new Date('2026-09-01T10:04:00.000Z')],
});

try {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const result = await db.$transaction(async (transaction) => {
    const alice = await upsertUser(transaction, {
      id: ids.alice,
      email: 'alice@example.com',
      username: 'alice_demo',
      passwordHash,
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=Alice',
    });
    const bob = await upsertUser(transaction, {
      id: ids.bob,
      email: 'bob@example.com',
      username: 'bob_demo',
      passwordHash,
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=Bob',
    });
    const maya = await upsertUser(transaction, {
      id: ids.maya,
      email: 'maya@example.com',
      username: 'maya_demo',
      passwordHash,
      avatarUrl: 'https://api.dicebear.com/9.x/initials/svg?seed=Maya',
    });

    const directKey = [alice.id, bob.id].sort().join(':');
    const direct = await transaction.conversation.upsert({
      where: { directKey },
      update: {},
      create: {
        type: 'DIRECT',
        directKey,
        createdById: alice.id,
      },
    });
    const group = await transaction.conversation.upsert({
      where: { id: ids.group },
      update: {
        name: 'Backend Builders',
        imageUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=BackendBuilders',
      },
      create: {
        id: ids.group,
        type: 'GROUP',
        name: 'Backend Builders',
        imageUrl: 'https://api.dicebear.com/9.x/shapes/svg?seed=BackendBuilders',
        createdById: alice.id,
      },
    });

    await Promise.all([
      upsertMembership(transaction, direct.id, alice.id, 'MEMBER'),
      upsertMembership(transaction, direct.id, bob.id, 'MEMBER'),
      upsertMembership(transaction, group.id, alice.id, 'OWNER'),
      upsertMembership(transaction, group.id, bob.id, 'ADMIN'),
      upsertMembership(transaction, group.id, maya.id, 'MEMBER'),
    ]);

    const directMessages = [];
    directMessages.push(
      await upsertMessage(transaction, {
        id: ids.directMessages[0],
        conversationId: direct.id,
        senderId: alice.id,
        clientMessageId: ids.directMessages[0],
        body: 'Hey Bob, ready to test the conversation API?',
        createdAt: timestamps.direct[0],
      }),
    );
    directMessages.push(
      await upsertMessage(transaction, {
        id: ids.directMessages[1],
        conversationId: direct.id,
        senderId: bob.id,
        clientMessageId: ids.directMessages[1],
        body: 'Ready. The persisted history looks good.',
        replyToId: directMessages[0].id,
        createdAt: timestamps.direct[1],
      }),
    );
    directMessages.push(
      await upsertMessage(transaction, {
        id: ids.directMessages[2],
        conversationId: direct.id,
        senderId: alice.id,
        clientMessageId: ids.directMessages[2],
        body: 'Great—I will verify pagination next.',
        createdAt: timestamps.direct[2],
      }),
    );

    const groupMessages = [];
    groupMessages.push(
      await upsertMessage(transaction, {
        id: ids.groupMessages[0],
        conversationId: group.id,
        senderId: alice.id,
        clientMessageId: ids.groupMessages[0],
        body: 'Welcome to the Backend Builders group.',
        createdAt: timestamps.group[0],
      }),
    );
    groupMessages.push(
      await upsertMessage(transaction, {
        id: ids.groupMessages[1],
        conversationId: group.id,
        senderId: maya.id,
        clientMessageId: ids.groupMessages[1],
        body: 'Thanks! I am reviewing the REST core now.',
        replyToId: groupMessages[0].id,
        createdAt: timestamps.group[1],
      }),
    );

    await Promise.all([
      transaction.conversation.update({
        where: { id: direct.id },
        data: { updatedAt: timestamps.direct.at(-1) },
      }),
      transaction.conversation.update({
        where: { id: group.id },
        data: { updatedAt: timestamps.group.at(-1) },
      }),
      transaction.conversationMember.update({
        where: { conversationId_userId: { conversationId: direct.id, userId: bob.id } },
        data: {
          lastReadMessageId: directMessages[0].id,
          lastReadAt: directMessages[0].createdAt,
        },
      }),
      transaction.conversationMember.update({
        where: { conversationId_userId: { conversationId: group.id, userId: maya.id } },
        data: {
          lastReadMessageId: groupMessages[0].id,
          lastReadAt: groupMessages[0].createdAt,
        },
      }),
    ]);

    return { users: [alice, bob, maya], conversations: [direct, group] };
  });

  console.log(
    `Seeded ${result.users.length} demo users and ${result.conversations.length} conversations.`,
  );
  console.log(`Demo password for alice_demo, bob_demo, and maya_demo: ${DEMO_PASSWORD}`);
} catch (error) {
  console.error('Database seed failed.', error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}

function upsertUser(transaction, user) {
  return transaction.user.upsert({
    where: { email: user.email },
    update: {
      username: user.username,
      passwordHash: user.passwordHash,
      avatarUrl: user.avatarUrl,
    },
    create: user,
  });
}

function upsertMembership(transaction, conversationId, userId, role) {
  return transaction.conversationMember.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    update: { role },
    create: { conversationId, userId, role },
  });
}

function upsertMessage(transaction, message) {
  const { senderId, conversationId, clientMessageId } = message;

  return transaction.message.upsert({
    where: {
      senderId_conversationId_clientMessageId: {
        senderId,
        conversationId,
        clientMessageId,
      },
    },
    update: {
      body: message.body,
      type: 'TEXT',
      replyToId: message.replyToId ?? null,
    },
    create: {
      ...message,
      type: 'TEXT',
      replyToId: message.replyToId ?? null,
    },
  });
}
