export function createConversationsController(conversations) {
  return {
    async createDirect(request, response) {
      const conversation = await conversations.createDirect(request.user.id, request.body.userId);

      return response.status(200).json({ data: { conversation } });
    },

    async list(request, response) {
      const result = await conversations.list(request.user.id, {
        cursor: request.validated.query.cursor,
        limit: request.validated.query.limit,
      });

      return response.status(200).json({ data: result });
    },
  };
}
