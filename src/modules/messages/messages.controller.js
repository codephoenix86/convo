export function createMessagesController(messages) {
  return {
    async create(request, response) {
      const result = await messages.create(
        request.user.id,
        request.validated.params.id,
        request.body,
      );

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
  };
}
