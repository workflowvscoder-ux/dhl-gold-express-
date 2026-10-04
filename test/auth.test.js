const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const backendDirectory = path.join(__dirname, '..');
let dataDirectory;
let serverProcess;
let serverLogs = '';
let serverPort;
let adminCookie = '';
let adminCsrfToken = '';
const setupToken = crypto.randomBytes(32).toString('hex');
const testAdminPassword = crypto.randomBytes(32).toString('base64url');

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
  const { anonymous = false, ...requestOptions } = options;
  const headers = { 'X-Forwarded-Proto': 'https', ...(requestOptions.headers || {}) };
  if (adminCookie && !anonymous) headers.Cookie = adminCookie;
  const response = await fetch(`http://127.0.0.1:${serverPort}${route}`, {
    ...requestOptions,
    headers
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) adminCookie = setCookie.split(';', 1)[0];
  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body
  };
}

after(async () => {
  await stopServer();
  if (dataDirectory) await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('shipments persist across restart and management routes require admin session and CSRF', { timeout: 30000 }, async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dhl-gold-express-auth-'));
  serverPort = await getAvailablePort();
  const legacyShipment = {
    trackingNumber: 'DHLG123456',
    sender: 'Existing Sender',
    receiver: 'Existing Receiver',
    origin: 'Existing Origin',
    destination: 'Existing Destination',
    status: 'In Transit',
    location: 'Existing Checkpoint',
    date: '2025-01-01T00:00:00.000Z'
  };
  await fs.writeFile(path.join(dataDirectory, 'data.json'), JSON.stringify([legacyShipment], null, 2));
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
  const originalShipments = JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8'));
  assert.deepEqual(originalShipments, [legacyShipment]);

  assert.equal((await request('/shipments', { anonymous: true })).status, 401);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8')), [legacyShipment]);
  assert.equal((await request(`/track/${legacyShipment.trackingNumber}`, { anonymous: true })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8')), [legacyShipment]);

  const created = await request('/create-shipment', {
    anonymous: true,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Sender', receiver: 'Receiver', origin: 'Origin', destination: 'Destination' })
  });
  assert.equal(created.status, 201);
  const trackingNumber = created.body.trackingNumber;
  assert.match(trackingNumber, /^DHLG\d{6}$/);
  const storedAfterCreate = JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8'));
  assert.equal(storedAfterCreate.some((shipment) => shipment.trackingNumber === trackingNumber), true);

  assert.equal((await request(`/update-status/${trackingNumber}`, {
    anonymous: true,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'In Transit', location: 'Unauthorized checkpoint' })
  })).status, 401);

  const setup = await request('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken, username: 'testadmin', password: testAdminPassword })
  });
  assert.equal(setup.status, 201);

  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testadmin', password: testAdminPassword })
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.authenticated, true);
  adminCsrfToken = login.body.csrfToken;

  const shipments = await request('/shipments');
  assert.equal(shipments.status, 200);
  assert.equal(shipments.body.some((shipment) => shipment.trackingNumber === trackingNumber), true);

  const rejectedUpdate = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'In Transit', location: 'Validation checkpoint', message: 'Shipment moving' })
  });
  assert.equal(rejectedUpdate.status, 403);

  const update = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': adminCsrfToken },
    body: JSON.stringify({ status: 'In Transit', location: 'Validation checkpoint', message: 'Shipment moving' })
  });
  assert.equal(update.status, 200);
  assert.equal((await request('/track/unknown', { anonymous: true })).status, 404);

  const publicTracking = await request(`/track/${trackingNumber}`, { anonymous: true });
  assert.equal(publicTracking.status, 200);
  assert.equal(publicTracking.body.status, 'In Transit');

  const delivered = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': adminCsrfToken },
    body: JSON.stringify({ status: 'Delivered', location: 'Destination', message: 'Delivered' })
  });
  assert.equal(delivered.status, 200);

  await stopServer();
  adminCookie = '';
  adminCsrfToken = '';
  await startServer();

  const restartedLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testadmin', password: testAdminPassword })
  });
  assert.equal(restartedLogin.status, 200);
  adminCsrfToken = restartedLogin.body.csrfToken;

  const shipmentsAfterRestart = await request('/shipments');
  assert.equal(shipmentsAfterRestart.status, 200);
  assert.equal(shipmentsAfterRestart.body.some((shipment) => shipment.trackingNumber === trackingNumber && shipment.status === 'Delivered'), true);
  const trackingAfterRestart = await request(`/track/${trackingNumber}`, { anonymous: true });
  assert.equal(trackingAfterRestart.status, 200);
  assert.equal(trackingAfterRestart.body.status, 'Delivered');

  const anonymousDelete = await request(`/shipments/${trackingNumber}`, {
    anonymous: true,
    method: 'DELETE'
  });
  assert.equal(anonymousDelete.status, 401);

  const rejectedDelete = await request(`/shipments/${trackingNumber}`, { method: 'DELETE' });
  assert.equal(rejectedDelete.status, 403);

  const deleted = await request(`/shipments/${trackingNumber}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': adminCsrfToken }
  });
  assert.equal(deleted.status, 200);
  assert.equal((await request(`/track/${trackingNumber}`, { anonymous: true })).status, 404);
  const storedShipments = JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8'));
  assert.deepEqual(storedShipments, [legacyShipment]);
});

test('production startup requires an absolute DATA_DIR', { timeout: 10000 }, async () => {
  for (const configuredDataDir of [undefined, 'relative-data-directory']) {
    const env = { ...process.env, NODE_ENV: 'production', PORT: String(await getAvailablePort()) };
    if (configuredDataDir) env.DATA_DIR = configuredDataDir;
    else delete env.DATA_DIR;

    const child = spawn(process.execPath, ['server.js'], {
      cwd: backendDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(output, /DATA_DIR must be configured as an absolute persistent path/);
  }
});