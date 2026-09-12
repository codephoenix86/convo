export function createAttachmentsController(attachments, storage) {
  return {
    async initializeUpload(request, response) {
      const upload = await attachments.initializeUpload(request.user.id, request.body);

      return response.status(200).json({ data: { upload } });
    },

    async download(request, response) {
      const download = await attachments.createDownload(
        request.user.id,
        request.validated.params.id,
      );

      response.set('cache-control', 'private, no-store');
      return response.redirect(307, download.url);
    },

    async uploadLocal(request, response) {
      await storage.storeUpload(request.query.token, {
        body: request.body,
        mimeType: request.get('content-type'),
      });

      return response.status(204).end();
    },

    async downloadLocal(request, response) {
      const file = await storage.readDownload(request.query.token);

      response.set({
        'cache-control': 'private, no-store',
        'content-length': String(file.body.length),
        'content-type': file.mimeType,
      });
      return response.status(200).send(file.body);
    },
  };
}
