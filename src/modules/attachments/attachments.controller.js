export function createAttachmentsController(attachments) {
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
  };
}
