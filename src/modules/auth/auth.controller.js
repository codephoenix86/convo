export function createAuthController(authentication) {
  return {
    async register(request, response) {
      const result = await authentication.register(request.body, getSessionMetadata(request));

      return response.set('Cache-Control', 'no-store').status(201).json({ data: result });
    },

    async login(request, response) {
      const result = await authentication.login(request.body, getSessionMetadata(request));

      return response.set('Cache-Control', 'no-store').status(200).json({ data: result });
    },

    async refresh(request, response) {
      const result = await authentication.refresh(request.body, getSessionMetadata(request));

      return response.set('Cache-Control', 'no-store').status(200).json({ data: result });
    },

    async logout(request, response) {
      await authentication.logout({
        userId: request.user.id,
        sessionId: request.user.sessionId,
      });

      return response.set('Cache-Control', 'no-store').status(204).send();
    },

    async logoutAll(request, response) {
      await authentication.logoutAll(request.user.id);

      return response.set('Cache-Control', 'no-store').status(204).send();
    },
  };
}

function getSessionMetadata(request) {
  return {
    ipAddress: request.ip,
    userAgent: request.get('user-agent'),
  };
}
