# Engineering decisions and trade-offs

## 1. Modular monolith before distributed services

Express, Socket.IO, services, and repositories deploy as one process. Module boundaries keep business logic testable without introducing network calls, duplicated contracts, distributed transactions, or operational overhead. If independent scaling becomes necessary, the service boundaries provide extraction points; until measurements justify that cost, a monolith is easier to reason about and demonstrate.

## 2. PostgreSQL is the durable source of truth

Users, sessions, memberships, messages, receipt positions, and attachment metadata are relational and benefit from constraints and transactions. PostgreSQL enforces identity, membership uniqueness, cross-conversation reply safety, idempotency, stable ordering, and single-use attachment keys. Presence and typing are excluded because writing high-churn ephemeral state to durable tables adds latency and cleanup work without improving reconnect correctness.

Attachment bytes are also excluded: they belong in object storage, while PostgreSQL keeps the searchable ownership/rendering metadata. Private signed downloads cost an extra redirect but avoid making the bucket public.

## 3. Socket.IO instead of raw WebSocket

Socket.IO supplies authenticated connection middleware, rooms, acknowledgements, reconnection support, and a Redis-backed multi-node adapter. The trade-off is protocol/library overhead and a Socket.IO-specific client. For a chat backend, those reliability primitives are more valuable than minimizing framing bytes; REST remains the durable recovery path when notifications are missed.

## 4. Client-generated message IDs provide idempotency

The client creates a `clientMessageId`, and PostgreSQL uniquely constrains it per sender/conversation. A retry returns the original canonical message and does not rebroadcast. This is simple and survives process restarts. It does require clients to persist/reuse the ID for the same logical send and does not attempt exactly-once delivery—an unrealistic guarantee across networks.

## 5. Redis coordinates only recoverable ephemeral state

Presence heartbeats, multi-device connection counts, typing TTLs, broadcast debounce keys, and rate-limit counters live in Redis. Atomic scripts prevent two API instances from producing conflicting first-device/final-device transitions, while TTLs remove stale presence and typing state after a process crash. Socket.IO's sharded Redis adapter uses dedicated connections to carry room broadcasts across instances. Presence visibility still comes from PostgreSQL memberships. Redis loss therefore degrades readiness, disconnects sockets to prevent silently local-only delivery, and rejects state-dependent work, but cannot lose messages, memberships, receipts, or attachment metadata.

## 6. Rate limits match operation cost and identity

Authentication attempts use client-IP budgets because no verified user exists yet; authenticated searches, sends, and upload initialization use the verified user ID so reconnecting or opening another tab does not reset a budget. Message sends deliberately share one limiter across REST and Socket.IO. This prevents transport switching from bypassing protection while keeping policy outside the message service.

The production implementation uses atomic Redis fixed-window counters, so all API instances enforce one budget and Redis failure cannot silently bypass protection. An in-memory implementation remains available as an injected test double. `TRUST_PROXY_HOPS` defaults to zero and must match the exact trusted proxy chain before forwarded client addresses are accepted for IP-keyed limits.
