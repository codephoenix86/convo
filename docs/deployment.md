# Production deployment

The repository includes a Render Blueprint in [`render.yaml`](../render.yaml). It provisions one Docker web service, private managed PostgreSQL 18, and a private managed Key Value instance. Render Key Value is Valkey-compatible with Redis clients, so it provides the shared rate-limit, presence, typing, and Socket.IO Pub/Sub state required by the application. Cloudinary stores attachment bytes outside the disposable web-service filesystem.

The Blueprint deliberately starts with one API instance. Redis-backed coordination is already enabled, but Socket.IO permits HTTP long-polling by default and Render does not provide session affinity between instances. Follow [Horizontal scaling](#horizontal-scaling) before increasing `numInstances`.

## Prerequisites

- A Render account connected to the repository.
- A Cloudinary product environment for private attachment storage.
- An HTTPS frontend origin. Localhost is not an appropriate production `CLIENT_ORIGINS` value.
- A paid Render web-service plan. Render pre-deploy commands are unavailable on free web services, and migrations must finish before new application instances start.

The resource sizes and `oregon` region in `render.yaml` are an initial low-traffic baseline, not a capacity guarantee. Change every resource to the same supported region before the first deployment when Oregon is unsuitable. Review current Render pricing before creating the Blueprint.

## First deployment

1. In the Render Dashboard, create a new Blueprint from this repository. Review the proposed web, PostgreSQL, and Key Value resources before applying it.
2. Supply the prompted secret values:
   - `CLIENT_ORIGINS`: exact comma-separated HTTPS origins, with no paths or trailing slashes.
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`: credentials from one Cloudinary product environment.
3. Keep the generated `ACCESS_TOKEN_SECRET` secret. Do not copy development values into Render.
4. Apply the Blueprint and wait for the pre-deploy command and service health check to succeed.
5. Record the assigned `https://<service>.onrender.com` URL in the frontend configuration. Render terminates TLS for both HTTPS and WebSocket connections. Do not set `PORT`; Render supplies it and the application already binds `0.0.0.0`.

PostgreSQL and Key Value have empty IP allowlists, so only Render services on their private network can connect. `DATABASE_URL` and `REDIS_URL` are populated from their internal connection strings rather than copied credentials.

`TRUST_PROXY_HOPS=1` trusts the single Render proxy hop when deriving client IPs for registration and login limits. Re-evaluate that exact hop count before placing another CDN or proxy in front of Render; trusting the wrong chain can merge users into one rate-limit bucket or accept a spoofed forwarded address.

## Release and migration safety

Every deploy builds the immutable runtime image, then runs `npm run db:migrate:deploy` once as Render's pre-deploy command. The production image intentionally contains the pinned Prisma CLI, schema, and committed migrations for this purpose. A failed migration prevents the new release from starting. Seeding is never part of deployment.

Old instances can serve traffic while a pre-deploy command runs and until the replacement is healthy. Database changes must therefore use expand-and-contract releases:

1. Add backward-compatible tables or nullable columns and deploy code that tolerates both schemas.
2. Backfill data separately when needed.
3. Remove old fields only in a later release after no running version uses them.

Do not edit an already-applied migration. Create and test a new migration against a disposable database with `npm run test:database`, then let the pre-deploy command apply that committed migration.

Automatic deployment waits for GitHub checks to pass because the Blueprint uses `autoDeployTrigger: checksPass`. Treat a healthy CI run as necessary but not sufficient: review migrations and environment changes before merging.

## Verification and monitoring

After deployment, substitute the assigned URL and check both endpoints:

```bash
curl --fail-with-body https://<service>.onrender.com/health
curl --fail-with-body https://<service>.onrender.com/ready
```

`/health` proves that the HTTP process is alive. Render monitors `/ready`, which returns success only while PostgreSQL, the Redis command client, and both Socket.IO adapter clients are ready. A failing readiness check should keep a new deployment out of service.

Run the executable demo against a disposable production project only, because it creates and retains records:

```bash
DEMO_BASE_URL=https://<service>.onrender.com npm run demo
```

Production clients connect Socket.IO to the same HTTPS origin. Render upgrades the connection to WSS automatically. Authenticate with `auth.token`, wait for `session:ready`, and retain the documented REST resynchronization path after reconnects.

Inspect Render's structured logs for `server_started`, dependency readiness/unavailability, migration failures, shutdown, and request IDs. Never log or paste database URLs, Redis URLs, JWTs, refresh tokens, or Cloudinary secrets. Configure external uptime alerts against `/ready`; keep `/health` for diagnosing whether an incident is process-level or dependency-level.

## Horizontal scaling

Before raising `numInstances` above one, configure every deployed Socket.IO client with `transports: ['websocket']` and verify that no client depends on HTTP long-polling. Render distributes connections without sticky sessions, while Socket.IO long-polling requires all requests in a session to reach the same process. WebSocket-only clients keep one connection pinned naturally.

After that client release is established, increase `numInstances` in `render.yaml`, apply the Blueprint, and rerun the cross-instance behavior checks. The Redis adapter distributes room events, and PostgreSQL and Redis hold shared state. Watch database connection counts, Key Value memory, error rates, and `/ready` during the scale-out. Scale resource plans before their connection or memory limits become the bottleneck.

## Secrets and configuration changes

- Rotate `ACCESS_TOKEN_SECRET` only with a planned forced sign-in; existing access tokens become invalid immediately.
- Rotating Cloudinary credentials affects new uploads and signed downloads. Update all three Cloudinary values together and verify an upload before retiring the old credentials.
- Changing `CLIENT_ORIGINS` affects browser REST requests and Socket.IO handshakes. Use exact trusted origins; never use `*` in production.
- Keep PostgreSQL and Key Value private. If temporary external access is unavoidable, add only the operator's exact IP and remove it immediately afterward.
- Use a unique `SOCKET_IO_REDIS_CHANNEL_PREFIX` if multiple application environments ever share one Key Value instance.

## Rollback and redeploy

For an application-only regression, open the web service's **Deploys** page, select the previous successful deploy, and choose **Rollback**. Confirm `/ready`, authentication, an authorized REST request, and a WSS reconnect after the rollback. A rollback does not reverse PostgreSQL migrations or environment-variable changes.

Only roll application code back across a migration when the old code remains compatible with the current database. If it is not compatible, keep the current release out of traffic and ship a forward fix; restoring a database backup is a separate, destructive recovery operation that requires an explicit incident decision. Never run `prisma migrate reset` in production.

Because a later commit can auto-deploy again, revert or fix the bad commit before resuming normal releases. To redeploy an unchanged good revision, use **Manual Deploy → Deploy latest commit** in Render, then repeat the verification checks above.

## Provider references

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render web services and ports](https://render.com/docs/web-services)
- [Render health checks](https://render.com/docs/health-checks)
- [Render WebSocket support](https://render.com/docs/websocket)
- [Render Key Value](https://render.com/docs/key-value)
- [Render pre-deploy commands](https://render.com/docs/deploys#pre-deploy-command)
- [Render rollbacks](https://render.com/docs/rollbacks)
