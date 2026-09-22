# Socket.IO event contract

Connect with `auth: { token: accessToken }`. The server authenticates before connection and derives the user from the token; clients never submit a trusted `userId`. Wait for `session:ready` before emitting application events.

Room broadcasts use Socket.IO's sharded Redis adapter and reach clients connected to other API instances. If the adapter is unavailable, namespace connection fails with `CONNECTION_UNAVAILABLE`; connected clients are disconnected when adapter availability is lost so delivery never silently falls back to one instance. Reconnect with normal Socket.IO backoff and perform the `session:ready` resynchronization below after service recovers.

Every client command should include an acknowledgement callback. Success uses `{ ok: true, data: ... }`; failure uses `{ ok: false, error: { code, message, details? } }`. Validation and authorization run for each event even after room restoration.

## Client-to-server commands

| Event               | Payload                                                               | Success `data`         | Authorization and follow-up                                                                               |
| ------------------- | --------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `message:send`      | `{ conversationId, clientMessageId, body, replyToId?, attachments? }` | `{ message, created }` | Current member. Persists once; a new row broadcasts `message:new`; shares the REST per-user send limit.   |
| `message:edit`      | `{ messageId, body }`                                                 | `{ message }`          | Current member and original sender. A changed row broadcasts `message:edited`.                            |
| `message:delete`    | `{ messageId }`                                                       | `{ message }`          | Current member and original sender. Soft deletion broadcasts `message:deleted`; retry is not rebroadcast. |
| `message:delivered` | `{ conversationId, messageId }`                                       | `{ receipt }`          | Current member. Monotonic advancement broadcasts `message:delivered`.                                     |
| `conversation:read` | `{ conversationId, messageId }`                                       | `{ receipt }`          | Current member. Advances read and delivery; a new position broadcasts `conversation:read`.                |
| `typing:start`      | `{ conversationId }`                                                  | `{ typing }`           | Current member. Rate-limited/debounced; broadcasts `typing:start` and expires after five seconds.         |
| `typing:stop`       | `{ conversationId }`                                                  | `{ typing }`           | Current member. Clears that socket's state and broadcasts `typing:stop` when no device remains typing.    |

`attachments` contains up to four `{ storageKey, width?, height? }` references created by the signed-upload REST flow. Image dimensions must be paired. The server revalidates the uploaded object before persistence.

`message:send` defaults to 120 attempts per minute for each authenticated user across all sockets, REST requests, and API instances. Atomic Redis counters prevent bypassing the budget by changing transport or instance. `typing:start` and `typing:stop` share a separate 12-events-per-two-seconds budget for each socket. A rejected command acknowledges `{ ok: false, error: { code: "RATE_LIMITED", message } }` and performs no domain-service work.

## Server-to-client events

| Event               | Payload                                                                    | Meaning                                                                                  |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session:ready`     | `{ connectionId, serverTime, syncRequired: true }`                         | Authentication and persisted room restoration completed; perform REST resynchronization. |
| `presence:snapshot` | `{ items: presence[] }`                                                    | Currently online users visible through shared authorized conversations.                  |
| `presence:update`   | `{ presence: { userId, isOnline, changedAt } }`                            | Server-derived first-device online or final-device offline transition.                   |
| `message:new`       | `{ message }`                                                              | Canonical newly persisted message, including attachment metadata when present.           |
| `message:edited`    | `{ message }`                                                              | Canonical sender-authorized edit.                                                        |
| `message:deleted`   | `{ message }`                                                              | Canonical tombstone; `body` is null and attachments are empty.                           |
| `message:delivered` | `{ receipt }`                                                              | A member's canonical delivered position advanced.                                        |
| `conversation:read` | `{ receipt }`                                                              | A member's canonical read position advanced.                                             |
| `typing:start`      | `{ typing: { conversationId, userId, isTyping: true, expiresAt } }`        | Authorized ephemeral typing state.                                                       |
| `typing:stop`       | `{ typing: { conversationId, userId, isTyping: false, expiresAt: null } }` | Typing stopped, expired, or disconnected.                                                |

Presence is notification-only: no client-originated `presence:update` handler exists. Redis-backed multi-device counts prevent one tab or API instance from making a still-connected user appear offline, and heartbeat TTLs clear state left by crashed processes.

## Reconnect contract

On reconnect, update `socket.auth.token` first if the access token changed. The server reauthenticates and reloads conversation IDs from PostgreSQL; clients cannot request room names. Since events are not replayed, `syncRequired: true` means the client should fetch the conversation list and relevant newest history pages, merge messages by server `id`, reconcile optimistic sends with `clientMessageId`, and use server timestamps for ordering.
