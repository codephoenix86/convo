# Convo Chat Backend

A production-minded real-time chat backend built as a modular monolith with Node.js, Express, PostgreSQL, and Prisma. Socket.IO and Redis are planned for the real-time milestones.

Milestones A and B provide the application foundation and REST core: validated configuration, migrations, health checks, structured logging, authentication and session rotation, users, direct/group conversations, role-based membership, persisted messages, and cursor-paginated history.

## Requirements

- Node.js 24 LTS
- npm 11 or later
- PostgreSQL 18 or another Prisma-supported PostgreSQL release

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

Every response includes an `x-request-id` header. A valid incoming request ID is preserved; otherwise, the server generates a UUID.

## Commands

| Command                     | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `npm run dev`               | Start with Node's watch mode.                          |
| `npm start`                 | Start the server normally.                             |
| `npm test`                  | Run fast unit and HTTP contract tests once.            |
| `npm run test:unit`         | Run unit tests.                                        |
| `npm run test:integration`  | Run HTTP, configuration, and lifecycle contract tests. |
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

| Variable                         | Purpose                                       |
| -------------------------------- | --------------------------------------------- |
| `NODE_ENV`                       | `development`, `test`, or `production`.       |
| `HOST`                           | HTTP bind address.                            |
| `PORT`                           | HTTP port from 1 through 65535.               |
| `LOG_LEVEL`                      | Pino log threshold.                           |
| `DATABASE_URL`                   | PostgreSQL connection URL.                    |
| `TEST_DATABASE_URL`              | Disposable PostgreSQL database used by tests. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Database connection timeout from 100–30000ms. |
| `ACCESS_TOKEN_SECRET`            | Secret of at least 32 characters for JWTs.    |
| `ACCESS_TOKEN_TTL_SECONDS`       | Access-token lifetime from 60–3600 seconds.   |
| `REFRESH_TOKEN_TTL_DAYS`         | Refresh-session lifetime from 1–90 days.      |
| `JWT_ISSUER`                     | Expected access-token issuer.                 |
| `JWT_AUDIENCE`                   | Expected access-token audience.               |

## Operational behavior

- Logs are newline-delimited JSON suitable for collection by a deployment platform.
- Authorization, cookies, tokens, and common credential fields are redacted from structured objects.
- Request bodies are not logged.
- Passwords use salted Argon2id hashes; opaque refresh tokens are stored only as SHA-256 hashes.
- Access JWTs are signed with HS256 and restricted to the configured issuer, audience, and lifetime.
- Refresh tokens rotate atomically; current/all-session logout revokes server-side refresh state.
- Direct-conversation identity is a canonical sorted participant key, so retries reuse one row.
- Conversation lists use stable cursors and bounded queries for participants, latest messages, and unread counts.
- Group creation writes the conversation, owner, and initial members atomically; only owners/admins may edit metadata.
- Group role rules are centralized: admins manage members, while only owners manage admins and roles.
- REST and future Socket.IO sends share one message service for authorization and idempotent persistence.
- Message history is ordered by server timestamps plus IDs and uses conversation-bound cursors.
- Database integration tests exercise real uniqueness, transactions, authorization, idempotency, and pagination.
- `SIGINT` and `SIGTERM` stop accepting requests, close the HTTP server, disconnect Prisma, and exit cleanly.
- Shutdown is forcefully terminated after ten seconds if resources cannot close.
