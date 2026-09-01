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
  };
}

function getSessionMetadata(request) {
  return {
    ipAddress: request.ip,
    userAgent: request.get('user-agent'),
  };
}
