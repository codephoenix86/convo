# Socket.IO event contract

Connect with `auth: { token: accessToken }`. The server authenticates before connection and derives the user from the token; clients never submit a trusted `userId`. Wait for `session:ready` before emitting application events.

Every client command should include an acknowledgement callback. Success uses `{ ok: true, data: ... }`; failure uses `{ ok: false, error: { code, message, details? } }`. Validation and authorization run for each event even after room restoration.

## Client-to-server commands

| Event               | Payload                                                               | Success `data`         | Authorization and follow-up                                                                               |
| ------------------- | --------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `message:send`      | `{ conversationId, clientMessageId, body, replyToId?, attachments? }` | `{ message, created }` | Current member. Persists once; a new row broadcasts `message:new`.                                        |
| `message:edit`      | `{ messageId, body }`                                                 | `{ message }`          | Current member and original sender. A changed row broadcasts `message:edited`.                            |
| `message:delete`    | `{ messageId }`                                                       | `{ message }`          | Current member and original sender. Soft deletion broadcasts `message:deleted`; retry is not rebroadcast. |
| `message:delivered` | `{ conversationId, messageId }`                                       | `{ receipt }`          | Current member. Monotonic advancement broadcasts `message:delivered`.                                     |
| `conversation:read` | `{ conversationId, messageId }`                                       | `{ receipt }`          | Current member. Advances read and delivery; a new position broadcasts `conversation:read`.                |
| `typing:start`      | `{ conversationId }`                                                  | `{ typing }`           | Current member. Rate-limited/debounced; broadcasts `typing:start` and expires after five seconds.         |
| `typing:stop`       | `{ conversationId }`                                                  | `{ typing }`           | Current member. Clears that socket's state and broadcasts `typing:stop` when no device remains typing.    |

`attachments` contains up to four `{ storageKey, width?, height? }` references created by the signed-upload REST flow. Image dimensions must be paired. The server revalidates the uploaded object before persistence.

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

Presence is notification-only: no client-originated `presence:update` handler exists. Multi-device counts prevent one tab from making a still-connected user appear offline.

## Reconnect contract

On reconnect, update `socket.auth.token` first if the access token changed. The server reauthenticates and reloads conversation IDs from PostgreSQL; clients cannot request room names. Since events are not replayed, `syncRequired: true` means the client should fetch the conversation list and relevant newest history pages, merge messages by server `id`, reconcile optimistic sends with `clientMessageId`, and use server timestamps for ordering.
