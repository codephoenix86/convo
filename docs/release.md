# Release acceptance

Milestone F has one local release command:

```bash
npm run test:release
```

Run it from an installed checkout with Docker available, Redis reachable through `REDIS_URL`, and `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database whose name ends in `_test`. The existing database safety checks reject the development database and any database without that suffix.

The command checks formatting, lint, the Prisma schema, all unit/integration/realtime behavior, real PostgreSQL migrations and constraints, two-instance Redis coordination, the Compose model, the Dockerfile, and the built production runtime. It leaves a local image tagged `convo-chat-backend:release-check`; it does not publish an image, deploy infrastructure, seed production, or modify the development database.

CI enforces the same boundaries in separate quality and container jobs. A local pass does not replace a successful protected-branch CI run.

## Acceptance evidence

| Capability                 | Executable evidence                                                           | Release interpretation                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Fresh setup                | `docker compose up --build --wait`, then the optional seed profile            | Compose waits for PostgreSQL, applies committed migrations, starts PostgreSQL/Redis/API, and persists local data in named volumes. |
| Auth security              | Auth, authorization, environment, logging, and token tests in `npm test`      | Invalid credentials and protected routes fail consistently; refresh rotation/revocation and redaction are covered.                 |
| Direct and group chat      | HTTP, service, database, and realtime suites                                  | Canonical direct reuse plus owner/admin/member rules are exercised at transport and persistence boundaries.                        |
| Persistence and pagination | `npm run test:database`                                                       | Real PostgreSQL constraints, transactions, stable cursors, tied timestamps, live inserts, and query plans are verified.            |
| Idempotency                | Default and database suites                                                   | REST/socket retries return one canonical message; concurrent inserts produce one row.                                              |
| Reconnect and resync       | Realtime tests and `npm run demo`                                             | Rooms are rebuilt from PostgreSQL and missed durable state is recovered through REST history.                                      |
| Read state                 | Unit, database, integration, and realtime receipt tests                       | Delivery/read positions advance monotonically and unread counts survive reloads.                                                   |
| Presence and typing        | Realtime tests and `npm run test:scaling`                                     | TTL expiry, multiple devices, authorization, debounce, and cross-instance transitions are verified.                                |
| Attachments                | Unit, HTTP, database, and realtime lifecycle tests                            | Upload metadata, signed access, ownership, MIME/size rules, single-use keys, and soft-delete behavior are covered.                 |
| Authorization              | Table-driven HTTP tests, database role cases, and socket-event tests          | A guessed identifier is insufficient to read, send, mutate, upload, or subscribe.                                                  |
| Database                   | `npm run test:database` and production-image Prisma validation                | Migrations work from committed files; constraints and important indexes are exercised.                                             |
| Tests and CI               | `npm run test:release` and `.github/workflows/ci.yml`                         | Local and hosted gates cover application, database, scaling, Compose, and production image boundaries.                             |
| Observability              | Health/readiness and lifecycle tests plus structured test logs                | Request IDs, dependency state, socket counts, failures, startup, and shutdown are observable without secret payloads.              |
| Documentation and demo     | README, architecture/data/API/socket/decision/deployment docs, `npm run demo` | A reviewer can set up, inspect, operate, and demonstrate the system without reading implementation files first.                    |

## External production gate

The repository cannot prove a live release without access to the deployment account, prompted secrets, and frontend origin. Before calling a release production-complete:

1. Sync [`render.yaml`](../render.yaml) in Render and wait for the pre-deploy migration and `/ready` health check to pass.
2. Confirm both endpoints over public HTTPS:

   ```bash
   curl --fail-with-body https://<service>.onrender.com/health
   curl --fail-with-body https://<service>.onrender.com/ready
   ```

3. Connect a production client over WSS using an allowed HTTPS origin, authenticate with `auth.token`, and observe `session:ready`.
4. Run `DEMO_BASE_URL=https://<service>.onrender.com npm run demo` only against an environment where retaining its generated records is acceptable.
5. Verify Render logs contain correlated startup, dependency, request, socket, and graceful-shutdown events without credentials.
6. Record the successful public base URL and CI run in the release notes or portfolio entry. Do not add a status badge until its target workflow has actually passed on GitHub.

The project is locally release-ready when `npm run test:release` and CI pass. It is production-proven only after the public HTTPS/WSS checks above pass. Rollback and migration compatibility procedures are documented in the [deployment runbook](deployment.md#rollback-and-redeploy).

## Honest portfolio summary

- Built a modular Node.js/Express/Socket.IO chat backend with PostgreSQL as the durable source of truth and Redis for recoverable coordination.
- Made message sends idempotent across REST and Socket.IO with client-generated IDs and a PostgreSQL uniqueness constraint.
- Used stable cursor pagination and compound indexes, verified with real PostgreSQL query plans rather than claimed throughput numbers.
- Exercised authorization, reconnect recovery, attachments, receipts, presence, two-instance delivery, Docker packaging, and CI through reproducible tests.
- Mention a live deployment only after completing the external production gate, and publish only performance numbers that can be reproduced from the documented load test.
