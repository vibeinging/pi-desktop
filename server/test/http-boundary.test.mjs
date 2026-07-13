import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('HTTP 浏览器入口默认拒绝未知来源，并要求显式本地令牌', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-desktop-http-boundary-'));
  process.env.PI_DB_PATH = join(home, 'local.db');
  process.env.PI_ALLOWED_ORIGINS = 'http://127.0.0.1:52731';
  process.env.PI_HTTP_TOKEN = 'test-local-browser-token';

  const [{ startHttpServer }, { closeDb }] = await Promise.all([
    import('../src/transport/http_server.js'),
    import('../src/db.js'),
  ]);
  const server = startHttpServer(0);
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    rmSync(home, { recursive: true, force: true });
  });

  const rejectedOrigin = await fetch(`${baseUrl}/api/projects`, {
    headers: { Origin: 'https://example.invalid' },
  });
  assert.equal(rejectedOrigin.status, 403);

  const missingToken = await fetch(`${baseUrl}/api/projects`, {
    headers: { Origin: 'http://127.0.0.1:52731' },
  });
  assert.equal(missingToken.status, 403);

  const allowedBrowser = await fetch(`${baseUrl}/api/projects`, {
    headers: {
      Origin: 'http://127.0.0.1:52731',
      'X-PI-Desktop-Token': 'test-local-browser-token',
    },
  });
  assert.equal(allowedBrowser.status, 200);
  assert.equal(allowedBrowser.headers.get('access-control-allow-origin'), 'http://127.0.0.1:52731');

  const localProcess = await fetch(`${baseUrl}/api/projects`);
  assert.equal(localProcess.status, 200);
  assert.equal(localProcess.headers.get('access-control-allow-origin'), null);
});
