export function getUserRoom(userId) {
  return `user:${userId}`;
}

export function getConversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}
