# HTTP API contract

All JSON endpoints use `Content-Type: application/json`. Protected endpoints require `Authorization: Bearer <accessToken>`. Successful bodies use `{ "data": ... }`; failures use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body validation failed",
    "requestId": "request-correlation-id",
    "details": [{ "field": "body", "message": "..." }]
  }
}
```

Every response has `x-request-id`. Expected application codes include `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), and `RATE_LIMITED` (429). Unexpected failures return a generic `INTERNAL_ERROR` without stack or database details.

## Endpoint index

| Method | Path                                         | Authentication | Contract                                                                        |
| ------ | -------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| GET    | `/health`                                    | No             | Process liveness.                                                               |
| GET    | `/ready`                                     | No             | PostgreSQL readiness; returns 503 when unavailable.                             |
| POST   | `/auth/register`                             | No             | `{ email, username, password }`; creates user, refresh session, and token pair. |
| POST   | `/auth/login`                                | No             | `{ identifier, password }`; returns user and token pair.                        |
| POST   | `/auth/refresh`                              | No             | `{ refreshToken }`; atomically rotates the refresh session.                     |
| POST   | `/auth/logout`                               | Bearer         | Revokes the access token's current session; 204.                                |
| POST   | `/auth/logout-all`                           | Bearer         | Revokes all of the user's refresh sessions; 204.                                |
| GET    | `/users/me`                                  | Bearer         | Current safe user profile.                                                      |
| PATCH  | `/users/me`                                  | Bearer         | `{ username?, avatarUrl? }`; at least one field.                                |
| GET    | `/users/search?q=&cursor=&limit=`            | Bearer         | Bounded user search; limit 1–50.                                                |
| POST   | `/conversations/direct`                      | Bearer         | `{ userId }`; creates or reuses the canonical direct conversation.              |
| POST   | `/conversations/group`                       | Bearer         | `{ name, imageUrl?, memberIds }`; caller becomes owner.                         |
| GET    | `/conversations?cursor=&limit=`              | Bearer         | Inbox page with members, last message, receipts, and unread count.              |
| PATCH  | `/conversations/:id`                         | Bearer         | Owner/admin updates `{ name?, imageUrl? }`.                                     |
| POST   | `/conversations/:id/members`                 | Bearer         | Owner/admin adds `{ userId, role? }`.                                           |
| PATCH  | `/conversations/:id/members/:userId`         | Bearer         | Owner changes `{ role }` between admin/member.                                  |
| DELETE | `/conversations/:id/members/:userId`         | Bearer         | Role-authorized removal; 204.                                                   |
| POST   | `/conversations/:id/messages`                | Bearer         | Idempotent `{ clientMessageId, body, replyToId?, attachments? }`.               |
| GET    | `/conversations/:id/messages?cursor=&limit=` | Bearer         | Newest-first stable history; limit 1–50.                                        |
| PUT    | `/conversations/:id/read`                    | Bearer         | `{ messageId }`; monotonically advances read and delivery positions.            |
| PATCH  | `/messages/:id`                              | Bearer         | Sender edits `{ body }`; returns canonical message.                             |
| DELETE | `/messages/:id`                              | Bearer         | Sender soft-deletes; returns canonical tombstone.                               |
| POST   | `/attachments/upload-init`                   | Bearer         | `{ conversationId, fileName, mimeType, size }`; returns signed PUT contract.    |
| GET    | `/attachments/:id/content`                   | Bearer         | Membership-checked 307 redirect to a signed private download.                   |

Unknown/nonmember conversation resources intentionally return 404 where possible, limiting identifier probing.

## Authentication example

```http
POST /auth/register
Content-Type: application/json

{
  "email": "alice@example.com",
  "username": "alice",
  "password": "Strong-password1!"
}
```

Registration returns status 201 with `data.user` and `data.tokens.accessToken`/`refreshToken`. Send the access token as a Bearer token. Refresh tokens are opaque, stored only as hashes, and rotated by `/auth/refresh`.

## Direct message example

```http
POST /conversations/8cc6d67e-6af6-46a4-8414-594f731b04fc/messages
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "clientMessageId": "d680d51c-70d5-4ad4-9027-72457c75424d",
  "body": "Hello"
}
```

The first write returns 201. A retry with the same user, conversation, and `clientMessageId` returns status 200 and the original canonical message without creating or broadcasting a duplicate.

History is newest first. Pass `data.nextCursor` unchanged to the next request. Cursors are opaque, conversation-bound, and encode the canonical timestamp/ID boundary.

## Attachment sequence

1. Initialize an upload:

   ```http
   POST /attachments/upload-init
   Authorization: Bearer <accessToken>
   Content-Type: application/json

   {
     "conversationId": "8cc6d67e-6af6-46a4-8414-594f731b04fc",
     "fileName": "diagram.png",
     "mimeType": "image/png",
     "size": 2048
   }
   ```

2. Resolve `data.upload.url` against the API origin if it is relative, then use the returned method and every returned header before `expiresAt`:
   - When `formFields` is absent, send the exact file bytes as the request body.
   - When `formFields` is present, create a `FormData`, append every returned field, append the file under `file`, and send that form without manually setting `Content-Type`.
3. Send a normal message with the returned key:

   ```json
   {
     "clientMessageId": "f198b024-bc17-4ae5-9b44-46a07ad3ad93",
     "body": "Architecture diagram",
     "attachments": [
       {
         "storageKey": "conversations/.../users/.../upload-id.png",
         "width": 1280,
         "height": 720
       }
     ]
   }
   ```

Cloudinary returns `method: "POST"`, empty headers, and signed `formFields`; S3/local return `method: "PUT"` and no `formFields`. The service verifies the stored object's signed owner, conversation, type, extension, and byte size before atomically creating message/attachment rows. Payloads contain a relative attachment `url`; fetch it with Bearer authentication to receive a private signed-download redirect for the selected `ATTACHMENT_STORAGE_DRIVER`.
