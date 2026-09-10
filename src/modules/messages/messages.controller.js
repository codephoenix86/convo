export function createMessagesController(messages) {
  return {
    async create(request, response) {
      const result = await messages.send(request.user.id, {
        ...request.body,
        conversationId: request.validated.params.id,
      });

      return response
        .status(result.created ? 201 : 200)
        .json({ data: { message: result.message } });
    },

    async listHistory(request, response) {
      const result = await messages.listHistory(request.user.id, request.validated.params.id, {
        cursor: request.validated.query.cursor,
        limit: request.validated.query.limit,
      });

      return response.status(200).json({ data: result });
    },

    async markRead(request, response) {
      const readState = await messages.markRead(request.user.id, {
        conversationId: request.validated.params.id,
        messageId: request.body.messageId,
      });

      return response.status(200).json({ data: { readState } });
    },

    async edit(request, response) {
      const message = await messages.edit(request.user.id, {
        messageId: request.validated.params.id,
        body: request.body.body,
      });

      return response.status(200).json({ data: { message } });
    },

    async delete(request, response) {
      const message = await messages.delete(request.user.id, {
        messageId: request.validated.params.id,
      });

      return response.status(200).json({ data: { message } });
    },
  };
}
