const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const backendDirectory = path.join(__dirname, '..');
const setupToken = 'test-only-setup-token-1234567890';
const adminUsername = 'test-admin';
const adminPassword = 'correct-horse-battery-12';
let dataDirectory;
let serverProcess;
let serverLogs = '';
let serverPort;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      PORT: String(serverPort),
      DATA_DIR: dataDirectory,
      ADMIN_SETUP_TOKEN: setupToken,
      FRONTEND_ORIGIN: 'https://frontend.example.test',
      NODE_ENV: 'production'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Backend exited before becoming ready:\n${serverLogs}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (response.ok) return;
    } catch (_error) {
      await delay(50);
    }
  }
  throw new Error(`Backend did not become ready:\n${serverLogs}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill();
  await once(serverProcess, 'exit');
  serverProcess = null;
}

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${serverPort}${route}`, {
    ...options,
    headers: { 'X-Forwarded-Proto': 'https', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body,
    setCookie: response.headers.get('set-cookie') || ''
  };
}

after(async () => {
  await stopServer();
  if (dataDirectory) await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('admin setup, login, sessions, CSRF, rate limits, and protected shipment routes', { timeout: 30000 }, async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dhl-gold-express-auth-'));
  serverPort = await getAvailablePort();
  await startServer();

  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const preflight = await fetch(`http://127.0.0.1:${serverPort}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://frontend.example.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://frontend.example.test');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

  const setupStatus = await request('/auth/setup/status');
  assert.deepEqual(setupStatus.body, { setupRequired: true, setupEnabled: true });
  assert.equal((await request('/shipments')).status, 401);
  assert.equal((await request('/create-shipment', { method: 'POST' })).status, 401);
  assert.equal((await request('/update-status/unknown', { method: 'PUT' })).status, 401);
  assert.equal((await request('/shipments/unknown', { method: 'DELETE' })).status, 401);
  assert.equal((await request('/track/unknown')).status, 404);

  const rejectedSetup = await request('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: 'incorrect', username: adminUsername, password: adminPassword })
  });
  assert.equal(rejectedSetup.status, 403);

  const setup = await request('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken, username: adminUsername, password: adminPassword })
  });
  assert.equal(setup.status, 201);
  assert.equal(JSON.stringify(setup.body).includes('passwordHash'), false);

  const savedAdmin = JSON.parse(await fs.readFile(path.join(dataDirectory, 'admin.json'), 'utf8'));
  assert.equal(savedAdmin.username, adminUsername);
  assert.match(savedAdmin.passwordHash, /^\$2[aby]\$12\$/);
  assert.notEqual(savedAdmin.passwordHash, adminPassword);
  assert.equal((await request('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken, username: 'second-admin', password: adminPassword })
  })).status, 409);

  const invalidLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: 'incorrect-password' })
  });
  assert.equal(invalidLogin.status, 401);

  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword })
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.authenticated, true);
  assert.equal(JSON.stringify(login.body).includes('passwordHash'), false);
  assert.match(login.setCookie, /HttpOnly/i);
  assert.match(login.setCookie, /Secure/i);
  assert.match(login.setCookie, /SameSite=None/i);
  const cookie = login.setCookie.split(';')[0];
  const csrfToken = login.body.csrfToken;

  await stopServer();
  await startServer();
  const persistedSession = await request('/auth/me', { headers: { Cookie: cookie } });
  assert.equal(persistedSession.status, 200);
  assert.equal(persistedSession.body.username, adminUsername);

  const createWithoutCsrf = await request('/create-shipment', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Sender', receiver: 'Receiver', origin: 'Origin', destination: 'Destination' })
  });
  assert.equal(createWithoutCsrf.status, 403);

  const created = await request('/create-shipment', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ sender: 'Sender', receiver: 'Receiver', origin: 'Origin', destination: 'Destination' })
  });
  assert.equal(created.status, 201);
  const trackingNumber = created.body.trackingNumber;

  const shipments = await request('/shipments', { headers: { Cookie: cookie } });
  assert.equal(shipments.status, 200);
  assert.equal(shipments.body.some((shipment) => shipment.trackingNumber === trackingNumber), true);

  const update = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ status: 'In Transit', location: 'Validation checkpoint', message: 'Shipment moving' })
  });
  assert.equal(update.status, 200);
  const publicTracking = await request(`/track/${trackingNumber}`);
  assert.equal(publicTracking.status, 200);
  assert.equal(publicTracking.body.status, 'In Transit');

  const rateLimitHeaders = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.88' };
  for (let attempt = 0; attempt < 5; attempt++) {
    const failedLogin = await request('/auth/login', {
      method: 'POST',
      headers: rateLimitHeaders,
      body: JSON.stringify({ username: adminUsername, password: 'wrong-password' })
    });
    assert.equal(failedLogin.status, 401);
  }
  const throttledLogin = await request('/auth/login', {
    method: 'POST',
    headers: rateLimitHeaders,
    body: JSON.stringify({ username: adminUsername, password: 'wrong-password' })
  });
  assert.equal(throttledLogin.status, 429);

  const delivered = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ status: 'Delivered', location: 'Destination', message: 'Delivered' })
  });
  assert.equal(delivered.status, 200);

  const deleted = await request(`/shipments/${trackingNumber}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }
  });
  assert.equal(deleted.status, 200);
  assert.equal((await request(`/track/${trackingNumber}`)).status, 404);

  const logoutWithoutCsrf = await request('/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(logoutWithoutCsrf.status, 403);

  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }
  });
  assert.equal(logout.status, 200);
  assert.equal((await request('/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request('/shipments', { headers: { Cookie: cookie } })).status, 401);
});