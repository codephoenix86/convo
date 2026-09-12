import { v2 as cloudinary } from 'cloudinary';

const RESOURCE_TYPE = 'raw';
const DELIVERY_TYPE = 'authenticated';
const UPLOAD_SIGNATURE_TTL_SECONDS = 3600;

export function createCloudinaryObjectStorage({
  cloudName,
  apiKey,
  apiSecret,
  downloadExpiresIn,
  api = cloudinary.api,
  utils = cloudinary.utils,
  now = Date.now,
}) {
  const clientOptions = {
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  };

  return {
    driver: 'cloudinary',

    async createUploadUrl({ storageKey, mimeType, metadata }) {
      const timestamp = Math.floor(now() / 1000);
      const context = serializeContext({ ...metadata, 'mime-type': mimeType });
      const signedFields = {
        context,
        overwrite: 'false',
        public_id: storageKey,
        timestamp: String(timestamp),
        type: DELIVERY_TYPE,
      };

      return {
        method: 'POST',
        url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${RESOURCE_TYPE}/upload`,
        headers: {},
        formFields: {
          ...signedFields,
          api_key: apiKey,
          signature: utils.api_sign_request(signedFields, apiSecret),
        },
        expiresIn: UPLOAD_SIGNATURE_TTL_SECONDS,
      };
    },

    async inspectObject(storageKey) {
      try {
        const resource = await api.resource(storageKey, {
          ...clientOptions,
          resource_type: RESOURCE_TYPE,
          type: DELIVERY_TYPE,
        });
        const metadata = resource.context?.custom ?? {};

        return {
          mimeType: metadata['mime-type'],
          size: resource.bytes,
          metadata: withoutKey(metadata, 'mime-type'),
        };
      } catch (error) {
        if (isObjectNotFoundError(error)) {
          return null;
        }

        throw error;
      }
    },

    async createDownloadUrl(storageKey) {
      const timestamp = Math.floor(now() / 1000);
      const expiresAt = timestamp + downloadExpiresIn;
      const url = utils.private_download_url(storageKey, undefined, {
        ...clientOptions,
        resource_type: RESOURCE_TYPE,
        type: DELIVERY_TYPE,
        timestamp,
        expires_at: expiresAt,
      });

      return { url, expiresIn: downloadExpiresIn };
    },
  };
}

function serializeContext(metadata) {
  return Object.entries(metadata)
    .map(([key, value]) => `${escapeContextValue(key)}=${escapeContextValue(value)}`)
    .join('|');
}

function escapeContextValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('=', '\\=').replaceAll('|', '\\|');
}

function withoutKey(object, excludedKey) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => key !== excludedKey));
}

function isObjectNotFoundError(error) {
  return error?.http_code === 404 || error?.error?.http_code === 404;
}
