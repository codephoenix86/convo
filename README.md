# Convo Chat Backend

A production-minded real-time chat backend built as a modular monolith with Node.js, Express, Socket.IO, PostgreSQL, and Prisma. Redis-backed horizontal scaling is planned after single-instance real-time correctness.

Milestones A–D provide the application foundation, authenticated REST and realtime chat, reconnect synchronization, read/delivery state, typing, multi-device presence, sender-owned message mutations, and private S3-compatible attachments. Redis-backed multi-instance coordination remains an optional Milestone F concern.

## Documentation

- [Architecture](docs/architecture.md)
- [Database model and delete behavior](docs/data-model.md)
- [HTTP API contract and examples](docs/api.md)
- [Socket.IO event contract](docs/socket-events.md)
- [Engineering decisions and trade-offs](docs/decisions.md)

## Requirements

- Node.js 24 LTS
- npm 11 or later
- PostgreSQL 18 or another Prisma-supported PostgreSQL release
- An S3-compatible object-storage bucket

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

3. Create a PostgreSQL database matching `DATABASE_URL` in `.env`.

4. Apply the committed migrations:

   ```bash
   npm run db:migrate:deploy
   ```

5. Optionally load idempotent demo users, conversations, and messages:

   ```bash
   npm run db:seed
   ```

   The demo accounts are `alice_demo`, `bob_demo`, and `maya_demo`; their development-only password is `Demo-password1!`.

6. Start the development server:

   ```bash
   npm run dev
   ```

7. Verify the service:

   ```bash
   curl http://localhost:3000/health
   curl http://localhost:3000/ready
   ```

The `.env.example` credentials are local placeholders only. Do not reuse them in a deployed environment.

## HTTP endpoints

| Method | Path                                 | Purpose                                                 |
| ------ | ------------------------------------ | ------------------------------------------------------- |
| GET    | `/health`                            | Process liveness; does not query dependencies.          |
| GET    | `/ready`                             | Readiness; returns `503` when PostgreSQL cannot answer. |
| POST   | `/auth/register`                     | Create a user and authenticated refresh session.        |
| POST   | `/auth/login`                        | Authenticate by email/username and create a session.    |
| POST   | `/auth/refresh`                      | Rotate a refresh token and issue a new token pair.      |
| POST   | `/auth/logout`                       | Revoke the current refresh session.                     |
| POST   | `/auth/logout-all`                   | Revoke every refresh session owned by the user.         |
| GET    | `/users/me`                          | Return the authenticated user's profile.                |
| PATCH  | `/users/me`                          | Update the authenticated user's username/avatar.        |
| GET    | `/users/search`                      | Search users with bounded cursor pagination.            |
| POST   | `/conversations/direct`              | Create or reuse a canonical direct conversation.        |
| GET    | `/conversations`                     | List conversations with last message and unread count.  |
| POST   | `/conversations/group`               | Create a group with an owner and initial members.       |
| PATCH  | `/conversations/:id`                 | Update group metadata as its owner or an admin.         |
| POST   | `/conversations/:id/members`         | Add a group member as its owner or an admin.            |
| DELETE | `/conversations/:id/members/:userId` | Remove a member when role rules allow it.               |
| PATCH  | `/conversations/:id/members/:userId` | Promote or demote a member as owner.                    |
| POST   | `/conversations/:id/messages`        | Persist an idempotent text message via REST.            |
| GET    | `/conversations/:id/messages`        | Load stable cursor-paginated message history.           |
| PUT    | `/conversations/:id/read`            | Advance the caller's read position monotonically.       |
| PATCH  | `/messages/:id`                      | Edit a sender-owned text message.                       |
| DELETE | `/messages/:id`                      | Soft-delete a sender-owned text message.                |
| POST   | `/attachments/upload-init`           | Create an authorized, short-lived signed upload.        |
| GET    | `/attachments/:id/content`           | Redirect an authorized member to a signed download.     |

Every response includes an `x-request-id` header. A valid incoming request ID is preserved; otherwise, the server generates a UUID.

## Attachment uploads

Call `POST /attachments/upload-init` with `{ conversationId, fileName, mimeType, size }`. The caller must be a current conversation member. JPEG, PNG, WebP, GIF, PDF, and plain-text files up to 10 MiB are accepted, and the extension must match the declared MIME type.

The response contains a server-generated `storageKey`, a short-lived signed `url`, `method: "PUT"`, required headers, and `expiresAt`. Upload the exact bytes directly to object storage using that method and those headers; binary data never passes through the API or PostgreSQL. Keys are scoped to the authenticated user and conversation, and the signed object metadata records both identities plus the declared size.

After the upload succeeds, include up to four references in REST or Socket.IO `message:send` as `attachments: [{ storageKey, width?, height? }]`; image dimensions must be supplied together and the message still requires a non-empty text body. Before atomically creating the message and attachment rows, the server inspects object storage and verifies the key owner, conversation, MIME type, extension, and exact byte size. A storage key can belong to only one message.

Message, history, inbox, acknowledgement, and realtime payloads return attachment metadata with an authorized relative `url`. Requesting that URL rechecks current conversation membership and redirects to a new short-lived signed download. Soft-deleted messages expose no attachments and their download routes return `404`.

Keep the bucket private and configure its CORS policy to allow `PUT` with `Content-Type` from the browser origins listed in `CLIENT_ORIGINS`.

## Socket.IO connections

Socket clients authenticate during the connection handshake by providing the access token as `auth.token`. Invalid or missing tokens are rejected before the socket can run application handlers. Each authenticated connection joins a private `user:<userId>` room and server-derived `conversation:<conversationId>` rooms loaded from PostgreSQL. Clients cannot select their own rooms; successful conversation and membership writes synchronize room access for every connected device.

An authenticated client sends `message:send` with `{ conversationId, clientMessageId, body, replyToId? }` and an acknowledgement callback. Success acknowledgements use `{ ok: true, data: { message, created } }`; rejected events use `{ ok: false, error: { code, message, details? } }`. A newly persisted message is broadcast as `message:new` with `{ message }`. Authorization is checked again for every send even though the socket initially joined authorized rooms.

Senders edit and soft-delete their text messages with `message:edit` using `{ messageId, body }` and `message:delete` using `{ messageId }`, or through the matching REST routes. Successful socket acknowledgements contain `{ message }`, while the conversation receives `message:edited` or `message:deleted`. Membership and sender ownership are rechecked for every mutation. Deleted messages remain as tombstones with `body: null`; repeated deletes and edits that do not change the normalized body return the canonical message without another broadcast.

Clients acknowledge receipt with `message:delivered` and advance their read position with `conversation:read`; both accept `{ conversationId, messageId }` and require an acknowledgement callback. Successful responses and room broadcasts contain the canonical member receipt in `{ receipt }`. Delivery and read positions advance monotonically using server message order, duplicate or older updates are not rebroadcast, and a read update also advances delivery because a read message has necessarily been delivered.

Typing indicators use `typing:start` and `typing:stop` with `{ conversationId }` plus an acknowledgement callback. The server derives the user from the authenticated socket, rechecks conversation membership, and broadcasts `{ typing: { conversationId, userId, isTyping, expiresAt } }`. Repeated starts refresh a five-second expiry while broadcasts are debounced; bursts are rate limited, disconnects clear that socket's state, and a user remains typing while any of their connected devices is still active. Typing state is intentionally ephemeral and is never written to PostgreSQL.

Presence is server-generated; clients do not emit presence claims. After `session:ready`, each socket receives `presence:snapshot` containing online users visible through its authorized conversation rooms. The first active device for a user broadcasts `presence:update` with `{ presence: { userId, isOnline: true, changedAt } }`; only the final device disconnect broadcasts the corresponding offline update. Presence is process-local and ephemeral until the optional Redis scaling milestone.

### Reconnect and resynchronization

After every initial connection or reconnect, the server authenticates the current `auth.token`, reloads conversation memberships from PostgreSQL, joins only those rooms, and then emits `session:ready` with `{ connectionId, serverTime, syncRequired: true }`. Clients should update `socket.auth.token` before reconnecting when they refresh an access token and should not send application events until `session:ready` arrives. A rejected reconnect must obtain a valid token before explicitly connecting again.

Socket events are live notifications, not a durable replay log. Whenever `session:ready` reports `syncRequired: true`, fetch `GET /conversations` from its first page, then fetch the newest page of `GET /conversations/:id/messages` for conversations that may have changed. Continue through older pages until reaching a locally known message when needed. Merge by the canonical message `id`, use `clientMessageId` to reconcile optimistic sends, and treat server IDs and timestamps as authoritative. This recovers messages missed while offline without assuming every socket event was delivered.

## Commands

| Command                     | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `npm run dev`               | Start with Node's watch mode.                          |
| `npm start`                 | Start the server normally.                             |
| `npm test`                  | Run unit, HTTP, and realtime tests once.               |
| `npm run test:unit`         | Run unit tests.                                        |
| `npm run test:integration`  | Run HTTP, configuration, and lifecycle contract tests. |
| `npm run test:acceptance`   | Run the realtime messaging lifecycle acceptance flow.  |
| `npm run test:database`     | Migrate and test against an isolated PostgreSQL DB.    |
| `npm run lint`              | Check JavaScript with ESLint.                          |
| `npm run format:check`      | Check formatting with Prettier.                        |
| `npm run db:generate`       | Regenerate Prisma Client.                              |
| `npm run db:validate`       | Validate the Prisma schema.                            |
| `npm run db:migrate`        | Create/apply a development migration.                  |
| `npm run db:migrate:deploy` | Apply committed migrations.                            |
| `npm run db:migrate:status` | Show migration status.                                 |
| `npm run db:seed`           | Idempotently load realistic development data.          |
| `npm run db:studio`         | Open Prisma Studio.                                    |

Database-backed tests are intentionally separate from the fast default suite. Create a disposable database whose name ends in `_test`, set `TEST_DATABASE_URL` in `.env`, and run `npm run test:database`. The safety wrapper refuses to use the same database as `DATABASE_URL`, applies committed migrations, and clears only that isolated database between cases.

## Environment variables

| Variable                             | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `NODE_ENV`                           | `development`, `test`, or `production`.       |
| `HOST`                               | HTTP bind address.                            |
| `PORT`                               | HTTP port from 1 through 65535.               |
| `LOG_LEVEL`                          | Pino log threshold.                           |
| `DATABASE_URL`                       | PostgreSQL connection URL.                    |
| `TEST_DATABASE_URL`                  | Disposable PostgreSQL database used by tests. |
| `DATABASE_CONNECTION_TIMEOUT_MS`     | Database connection timeout from 100–30000ms. |
| `ACCESS_TOKEN_SECRET`                | Secret of at least 32 characters for JWTs.    |
| `ACCESS_TOKEN_TTL_SECONDS`           | Access-token lifetime from 60–3600 seconds.   |
| `REFRESH_TOKEN_TTL_DAYS`             | Refresh-session lifetime from 1–90 days.      |
| `JWT_ISSUER`                         | Expected access-token issuer.                 |
| `JWT_AUDIENCE`                       | Expected access-token audience.               |
| `CLIENT_ORIGINS`                     | Comma-separated browser origin allowlist.     |
| `OBJECT_STORAGE_REGION`              | S3-compatible bucket region.                  |
| `OBJECT_STORAGE_BUCKET`              | Private attachment bucket name.               |
| `OBJECT_STORAGE_ENDPOINT`            | Optional HTTP(S) endpoint for R2/MinIO/etc.   |
| `OBJECT_STORAGE_ACCESS_KEY_ID`       | Object-storage access-key identifier.         |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY`   | Object-storage secret access key.             |
| `OBJECT_STORAGE_FORCE_PATH_STYLE`    | Use path-style bucket addressing.             |
| `OBJECT_STORAGE_PRESIGN_TTL_SECONDS` | Signed-upload lifetime from 60–900 seconds.   |

## Operational behavior

- Logs are newline-delimited JSON suitable for collection by a deployment platform.
- Authorization, cookies, tokens, and common credential fields are redacted from structured objects.
- Request bodies are not logged.
- Passwords use salted Argon2id hashes; opaque refresh tokens are stored only as SHA-256 hashes.
- Access JWTs are signed with HS256 and restricted to the configured issuer, audience, and lifetime.
- Helmet applies standard HTTP security headers, and REST CORS grants browser access only to origins in `CLIENT_ORIGINS` without enabling credentialed cookies.
- Refresh tokens rotate atomically; current/all-session logout revokes server-side refresh state.
- Direct-conversation identity is a canonical sorted participant key, so retries reuse one row.
- Conversation lists use stable cursors and bounded queries for participants, latest messages, and unread counts.
- Read positions use canonical message timestamps and IDs, never move backward, and are returned with conversation members for resynchronization.
- Delivery receipts are durable per-member positions; read and delivery updates are authorized per event and broadcast only after persisted advancement.
- Typing indicators are authorized, burst-limited, broadcast-coalesced, multi-device aware, and automatically expire after five seconds.
- Presence snapshots and updates are derived from authenticated sockets and shared authorized rooms; multi-device connection counts prevent false offline transitions.
- Group creation writes the conversation, owner, and initial members atomically; only owners/admins may edit metadata.
- Group role rules are centralized: admins manage members, while only owners manage admins and roles.
- REST and Socket.IO sends share one message service for authorization and idempotent persistence.
- REST and Socket.IO message mutations share sender-ownership rules, atomically update PostgreSQL, and redact soft-deleted bodies from responses and broadcasts.
- Attachment upload initialization validates membership, MIME type, extension, and a 10 MiB size limit before issuing a user-scoped, short-lived S3-compatible upload URL.
- Uploaded-object ownership and metadata are revalidated before attachment rows are atomically associated with a message; private downloads recheck membership and soft-delete state.
- Message history is ordered by server timestamps plus IDs and uses conversation-bound cursors.
- Database integration tests exercise real uniqueness, transactions, authorization, idempotency, and pagination.
- Express and Socket.IO share one HTTP server; cross-origin socket handshakes use the configured allowlist.
- Socket handshakes require a valid access token, and connection logs expose safe total/per-user counts without logging credentials.
- Conversation room access is rebuilt from persisted memberships and updated after successful direct/group membership writes.
- Message sends use one transport-independent service for validation, authorization, idempotent persistence, and `message:new` publication; retries are not rebroadcast.
- Every connection emits `session:ready` after authentication and room restoration so clients can resynchronize missed durable state through REST.
- `SIGINT` and `SIGTERM` close Socket.IO and the HTTP server, disconnect Prisma, and exit cleanly.
- Shutdown is forcefully terminated after ten seconds if resources cannot close.
