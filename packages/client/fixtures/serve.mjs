/** Starts the loopback-only Bun fixture service with an explicit scenario. */
import { SCENARIOS, createFixtureFetch } from './index.ts';
import { errorResponse } from './response.ts';

const [, , scenario, portArg = '4180', ...extra] = process.argv;
if (!Object.hasOwn(SCENARIOS, scenario ?? '') || !/^[1-9][0-9]{0,4}$/.test(portArg) || Number(portArg) > 65535 || extra.length) {
  console.error('Usage: bun --no-install packages/client/fixtures/serve.mjs SCENARIO [PORT]');
  console.error(`Scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const fixtureFetch = createFixtureFetch(scenario);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(portArg),
  idleTimeout: 30,
  fetch(request) {
    const url = new URL(request.url);
    if (url.host !== `127.0.0.1:${portArg}` || request.headers.get('Host') !== url.host) {
      return errorResponse('invalid_request');
    }
    return fixtureFetch(request);
  },
});
console.log(`Agent Hub fixture (${scenario}) at ${server.url}`);
