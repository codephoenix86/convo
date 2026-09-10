export function presentMessage(message) {
  if (!message) {
    return message;
  }

  if (message.deletedAt) {
    return { ...message, body: null, ...(message.attachments ? { attachments: [] } : {}) };
  }

  if (!message.attachments) {
    return message;
  }

  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      url: `/attachments/${attachment.id}/content`,
    })),
  };
}
