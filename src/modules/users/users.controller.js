export function createUsersController(users) {
  return {
    async getProfile(request, response) {
      const user = await users.getProfile(request.user.id);

      return response.status(200).json({ data: { user } });
    },

    async updateProfile(request, response) {
      const user = await users.updateProfile(request.user.id, request.body);

      return response.status(200).json({ data: { user } });
    },

    async search(request, response) {
      const result = await users.search({
        requestingUserId: request.user.id,
        query: request.validated.query.q,
        cursor: request.validated.query.cursor,
        limit: request.validated.query.limit,
      });

      return response.status(200).json({ data: result });
    },
  };
}
