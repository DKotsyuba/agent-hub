/** Local Hub HTTP transport for Bun. Browser clients import the shared index. */
import { createHubClient } from './index.ts';

/** Default service socket on the Dobi host. */
export const DEFAULT_HUB_SOCKET = '/run/agent-hub-http/http.sock';

/** Uses Bun's Unix fetch option for the local Hub origin. */
export function createUnixHubClient(socket = DEFAULT_HUB_SOCKET, send: typeof fetch = globalThis.fetch.bind(globalThis)) {
  return createHubClient({
    baseUrl: 'http://localhost',
    fetch: (input, init) => send(input, { ...init, unix: socket } as RequestInit),
  });
}
