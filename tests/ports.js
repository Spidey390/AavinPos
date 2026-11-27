import { createServer } from 'node:http';
import { once } from 'node:events';

// Vite treats port 0 as its default port; reserve an OS-selected port instead.
export async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
