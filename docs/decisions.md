# Engineering decisions and trade-offs

## 1. Modular monolith before distributed services

Express, Socket.IO, services, and repositories deploy as one process. Module boundaries keep business logic testable without introducing network calls, duplicated contracts, distributed transactions, or operational overhead. If independent scaling becomes necessary, the service boundaries provide extraction points; until measurements justify that cost, a monolith is easier to reason about and demonstrate.

## 2. PostgreSQL is the durable source of truth

Users, sessions, memberships, messages, receipt positions, and attachment metadata are relational and benefit from constraints and transactions. PostgreSQL enforces identity, membership uniqueness, cross-conversation reply safety, idempotency, stable ordering, and single-use attachment keys. Presence and typing are excluded because writing high-churn ephemeral state to durable tables adds latency and cleanup work without improving reconnect correctness.

Attachment bytes are also excluded: they belong in object storage, while PostgreSQL keeps the searchable ownership/rendering metadata. Private signed downloads cost an extra redirect but avoid making the bucket public.

## 3. Socket.IO instead of raw WebSocket

Socket.IO supplies authenticated connection middleware, rooms, acknowledgements, reconnection support, and a future multi-node adapter. The trade-off is protocol/library overhead and a Socket.IO-specific client. For a chat backend, those reliability primitives are more valuable than minimizing framing bytes; REST remains the durable recovery path when notifications are missed.

## 4. Client-generated message IDs provide idempotency

The client creates a `clientMessageId`, and PostgreSQL uniquely constrains it per sender/conversation. A retry returns the original canonical message and does not rebroadcast. This is simple and survives process restarts. It does require clients to persist/reuse the ID for the same logical send and does not attempt exactly-once delivery—an unrealistic guarantee across networks.

## 5. Redis is deferred until multi-instance deployment

Single-instance presence, typing TTLs, debounce state, and connection counts live in process memory. This makes expiration behavior explicit and keeps Milestone D runnable without another stateful dependency. The limitation is intentional: two API instances would disagree and their Socket.IO rooms would be isolated. Milestone F may add node-redis plus the Socket.IO Redis adapter, shared TTL/connection-count keys, reconnect handling, and a two-instance test. Redis will coordinate ephemeral state; it will not replace PostgreSQL as chat history.
