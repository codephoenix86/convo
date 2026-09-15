# Quality, performance, and test evidence

Milestone E turns the backend's security and correctness claims into executable checks. The default suite is fast and isolated; PostgreSQL-specific guarantees live in the separately guarded database suite.

## Verification commands

| Command                    | Scope                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| `npm run lint`             | JavaScript static analysis.                                            |
| `npm run format:check`     | Repository formatting.                                                 |
| `npm run test:unit`        | Services, utilities, storage adapters, tokens, and ephemeral state.    |
| `npm run test:integration` | HTTP contracts, middleware ordering, authorization, and rate limits.   |
| `npm test`                 | Unit, integration, and Socket.IO suites.                               |
| `npm run test:acceptance`  | One complete realtime messaging lifecycle.                             |
| `npm run test:database`    | Migrations plus PostgreSQL constraints, transactions, and query plans. |

Database tests require `TEST_DATABASE_URL` to identify a disposable database whose name ends in `_test`. The runner rejects the normal `DATABASE_URL`, deploys committed migrations, and clears only the isolated test database between cases.

## Continuous integration

GitHub Actions runs the complete release gate on pull requests, pushes to `main`, and manual dispatches. The quality job installs exactly `package-lock.json`, checks formatting and lint, validates the Prisma schema, runs the default test suite, then deploys all migrations into an isolated PostgreSQL 18 service before running database-backed constraints, transactions, authorization, pagination, and query-plan tests. A Redis service supplies the validated runtime dependency configuration and remains available for later shared-state and adapter tests.

The container job runs only after application and database checks pass. It validates the Compose model and Dockerfile, builds the production target, and verifies that the image runs as a non-root user, loads the native Argon2 dependency, and excludes Vitest. BuildKit caches image layers, while `setup-node` caches npm's download cache by lockfile; neither job caches `node_modules` or build output.

Workflow permissions are read-only, checkout credentials are not persisted, third-party actions are pinned to immutable commit SHAs, concurrent runs for the same ref are cancelled, and every job has a bounded timeout. A CI badge should be added to the README only after this workflow has completed successfully on GitHub.

## Authorization coverage

- A table-driven integration test covers all 19 protected REST routes. Requests without a Bearer token return `401 UNAUTHORIZED` before token verification or domain-service work.
- Database-backed cases exercise direct/group conversations as owner, admin, member, sender, non-sender, removed member, and outsider. Role transitions and membership mutations are verified against persisted state.
- Unknown or inaccessible conversation resources return `404` where practical to limit identifier probing; known resources that a member cannot mutate return `403`.
- Every sensitive Socket.IO command revalidates membership or sender ownership. Tests also cover room removal, forged user IDs, reconnect room restoration, and server-derived multi-device presence.

## Idempotency and concurrency

Message identity is scoped by `(senderId, conversationId, clientMessageId)` and enforced by PostgreSQL. The database suite sends eight concurrent requests with one key and verifies exactly one `201`, seven `200` responses, one stored row, and one canonical ID/body. The same client ID remains valid for a different sender or conversation.

REST and Socket.IO use the same message service and rate-limit budget. A retry through either transport returns the canonical row and does not produce a second `message:new` broadcast.

## Pagination and index evidence

The database suite inserts 1,200 messages with an identical timestamp, reads them in 24 pages of 50, and inserts a newer live message after page one. It verifies the original snapshot is returned exactly once, in order, without gaps or duplicates. The `(createdAt, id)` cursor boundary makes tied timestamps deterministic and prevents the later insert from shifting older pages.

The suite also runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against representative queries and asserts these critical indexes appear in the executed plans:

| Index                                        | Supports                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| `messages_history_idx`                       | Conversation history ordered by `created_at DESC, id DESC`.    |
| `messages_sender_conversation_client_id_key` | Idempotent lookup by sender, conversation, and client message. |

These checks prove the intended PostgreSQL access paths are usable on a realistic test fixture. They deliberately avoid publishing machine-specific latency claims as universal benchmarks.

## Rate-limit policy

| Operation                        | Key                | Default budget |
| -------------------------------- | ------------------ | -------------- |
| `POST /auth/register`            | Client IP          | 5 per 15 min   |
| `POST /auth/login`               | Client IP          | 10 per 15 min  |
| `GET /users/search`              | Authenticated user | 60 per min     |
| REST/Socket.IO message send      | Authenticated user | 120 per min    |
| `POST /attachments/upload-init`  | Authenticated user | 20 per min     |
| `typing:start` and `typing:stop` | Socket connection  | 12 per 2 sec   |

Limited HTTP responses use `429 RATE_LIMITED` and expose `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`. Socket commands return the same error code in their acknowledgement envelope. Message sends share one per-user budget across REST and Socket.IO so changing transports cannot bypass it.

The fixed-window counters are bounded and process-local, matching the current single-instance architecture. A multi-instance deployment must move rate-limit state to a shared store alongside the optional Redis scaling work.

Express trusts no proxy by default. Set `TRUST_PROXY_HOPS` to the exact number of trusted reverse-proxy hops so IP-keyed auth limits use the real client address. Over-trusting this value can let callers spoof forwarded addresses.

## Manual demo

With a migrated API running, execute `npm run demo`. The script creates uniquely named users and demonstrates direct-conversation reuse, group-role rejection, direct/group realtime sends and acknowledgements, read receipts, cross-transport idempotency, reconnect room restoration, and REST history recovery. See the root README for configuration and expected output.
