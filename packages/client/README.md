# Hub v1 client

Import the browser-safe transport from `src/index.ts`.

- `createHubClient({ baseUrl?, fetch? })` defaults to the browser origin.
  `get(route, { params, query, signal })` dispatches a validated GET and
  decodes its response. `HubHttpError` preserves the machine code, status and
  retryability of HTTP errors.
- `events(topics, interval, signal)` reads one SSE stream. `watch(topics,
  interval, { event, connection }, signal)` reconnects after stream failure
  and reports readiness. On each `ready`, revalidate the current query and
  catch up using its last applied resume cursor.
- `readSse(body)` decodes a single stream. `recoverCursor(cursor, read)`
  retries a revoked continuation once from the original query edge. Apply that
  response as a new boundary. Keep the older page anchor separate from live
  resume. Assemble text exports from a single boundary and discard incomplete
  operations.
- `src/unix.ts` exports `createUnixHubClient(socket?)` and
  `DEFAULT_HUB_SOCKET` for Bun. The same validated client accepts a remote
  HTTPS origin through its default fetch implementation.
- `fixtures/index.ts` provides an explicitly chosen scenario transport.

Requests are cancellable through their individual signals. A consumer that
changes the selected query should cancel or fence the previous request before
publishing the next result.
