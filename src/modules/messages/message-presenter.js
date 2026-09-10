export function presentMessage(message) {
  if (!message?.deletedAt) {
    return message;
  }

  return { ...message, body: null };
}
