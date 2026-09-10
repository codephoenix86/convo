export function createAttachmentsController(attachments) {
  return {
    async initializeUpload(request, response) {
      const upload = await attachments.initializeUpload(request.user.id, request.body);

      return response.status(200).json({ data: { upload } });
    },
  };
}
