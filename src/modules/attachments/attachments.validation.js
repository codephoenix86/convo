import { z } from 'zod';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_EXTENSIONS = Object.freeze({
  'application/pdf': Object.freeze(['pdf']),
  'image/gif': Object.freeze(['gif']),
  'image/jpeg': Object.freeze(['jpeg', 'jpg']),
  'image/png': Object.freeze(['png']),
  'image/webp': Object.freeze(['webp']),
  'text/plain': Object.freeze(['txt']),
});

const allowedMimeTypes = Object.keys(ALLOWED_ATTACHMENT_EXTENSIONS);
const fileNameSchema = z
  .string()
  .trim()
  .min(1, 'File name must not be empty')
  .max(255, 'File name must contain at most 255 characters')
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);

        return codePoint > 31 && codePoint !== 127;
      }),
    'File name must not contain control characters',
  );

export const initializeUploadBodySchema = z
  .object({
    conversationId: z.uuid(),
    fileName: fileNameSchema,
    mimeType: z.enum(allowedMimeTypes, {
      error: `MIME type must be one of: ${allowedMimeTypes.join(', ')}`,
    }),
    size: z
      .number()
      .int('File size must be an integer')
      .min(1, 'File must not be empty')
      .max(MAX_ATTACHMENT_BYTES, `File size must not exceed ${MAX_ATTACHMENT_BYTES} bytes`),
  })
  .strict()
  .superRefine((value, context) => {
    const extension = getFileExtension(value.fileName);

    if (!extension || !ALLOWED_ATTACHMENT_EXTENSIONS[value.mimeType].includes(extension)) {
      context.addIssue({
        code: 'custom',
        path: ['fileName'],
        message: `File extension does not match MIME type ${value.mimeType}`,
      });
    }
  });

export const initializeUploadCommandSchema = initializeUploadBodySchema;

export const attachmentIdParamsSchema = z.object({ id: z.uuid() }).strict();

export function getFileExtension(fileName) {
  const separatorIndex = fileName.lastIndexOf('.');

  if (separatorIndex <= 0 || separatorIndex === fileName.length - 1) {
    return null;
  }

  return fileName.slice(separatorIndex + 1).toLowerCase();
}
