/** Validates the explicit remote Hub origin or an isolated IPv4 fixture origin. */
export function hubServer(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('Expected a Hub HTTPS origin or an explicit 127.0.0.1 fixture origin.');
  }
  return url;
}
