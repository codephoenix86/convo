# Convo Chat Backend

A production-minded real-time chat backend built as a modular monolith with Node.js, Express, PostgreSQL, and Prisma. Socket.IO and Redis are planned for the real-time milestones.

Milestone A provides the application foundation: validated configuration, PostgreSQL migrations, the User model, an Express server, health checks, structured logging, graceful shutdown, and foundation tests. Milestone B is in progress with the core chat schema and authentication cryptographic primitives; REST endpoints will follow in later commits.

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

5. Start the development server:

   ```bash
   npm run dev
   ```

6. Verify the service:

   ```bash
   curl http://localhost:3000/health
   curl http://localhost:3000/ready
   ```

The `.env.example` credentials are local placeholders only. Do not reuse them in a deployed environment.

## HTTP endpoints

| Method | Path      | Purpose                                                 |
| ------ | --------- | ------------------------------------------------------- |
| GET    | `/health` | Process liveness; does not query dependencies.          |
| GET    | `/ready`  | Readiness; returns `503` when PostgreSQL cannot answer. |

Every response includes an `x-request-id` header. A valid incoming request ID is preserved; otherwise, the server generates a UUID.

## Commands

| Command                     | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `npm run dev`               | Start with Node's watch mode.                 |
| `npm start`                 | Start the server normally.                    |
| `npm test`                  | Run all foundation tests once.                |
| `npm run test:unit`         | Run unit tests.                               |
| `npm run test:integration`  | Run HTTP, configuration, and lifecycle tests. |
| `npm run lint`              | Check JavaScript with ESLint.                 |
| `npm run format:check`      | Check formatting with Prettier.               |
| `npm run db:generate`       | Regenerate Prisma Client.                     |
| `npm run db:validate`       | Validate the Prisma schema.                   |
| `npm run db:migrate`        | Create/apply a development migration.         |
| `npm run db:migrate:deploy` | Apply committed migrations.                   |
| `npm run db:migrate:status` | Show migration status.                        |
| `npm run db:studio`         | Open Prisma Studio.                           |

## Environment variables

| Variable                         | Purpose                                       |
| -------------------------------- | --------------------------------------------- |
| `NODE_ENV`                       | `development`, `test`, or `production`.       |
| `HOST`                           | HTTP bind address.                            |
| `PORT`                           | HTTP port from 1 through 65535.               |
| `LOG_LEVEL`                      | Pino log threshold.                           |
| `DATABASE_URL`                   | PostgreSQL connection URL.                    |
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
- `SIGINT` and `SIGTERM` stop accepting requests, close the HTTP server, disconnect Prisma, and exit cleanly.
- Shutdown is forcefully terminated after ten seconds if resources cannot close.
