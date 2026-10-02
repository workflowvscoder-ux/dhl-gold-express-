const assert = require('node:assert/strict');
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
      ADMIN_SETUP_TOKEN: '',
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
    body
  };
}

after(async () => {
  await stopServer();
  if (dataDirectory) await fs.rm(dataDirectory, { recursive: true, force: true });
});

test('shipment management routes work without login or CSRF and tracking stays public', { timeout: 30000 }, async () => {
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
  assert.deepEqual(setupStatus.body, { setupRequired: true, setupEnabled: false });
  const originalShipments = JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8'));
  assert.deepEqual(originalShipments, [legacyShipment]);

  const initialList = await request('/shipments');
  assert.equal(initialList.status, 200);
  assert.equal(initialList.body[0].trackingNumber, legacyShipment.trackingNumber);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8')), [legacyShipment]);
  assert.equal((await request(`/track/${legacyShipment.trackingNumber}`)).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8')), [legacyShipment]);

  const created = await request('/create-shipment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'Sender', receiver: 'Receiver', origin: 'Origin', destination: 'Destination' })
  });
  assert.equal(created.status, 201);
  const trackingNumber = created.body.trackingNumber;
  assert.match(trackingNumber, /^DHLG\d{6}$/);

  const shipments = await request('/shipments');
  assert.equal(shipments.status, 200);
  assert.equal(shipments.body.some((shipment) => shipment.trackingNumber === trackingNumber), true);

  const update = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'In Transit', location: 'Validation checkpoint', message: 'Shipment moving' })
  });
  assert.equal(update.status, 200);
  assert.equal((await request('/track/unknown')).status, 404);

  const publicTracking = await request(`/track/${trackingNumber}`);
  assert.equal(publicTracking.status, 200);
  assert.equal(publicTracking.body.status, 'In Transit');

  const delivered = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Delivered', location: 'Destination', message: 'Delivered' })
  });
  assert.equal(delivered.status, 200);

  const deleted = await request(`/shipments/${trackingNumber}`, {
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
  assert.equal((await request(`/track/${trackingNumber}`)).status, 404);
  const storedShipments = JSON.parse(await fs.readFile(path.join(dataDirectory, 'data.json'), 'utf8'));
  assert.deepEqual(storedShipments, [legacyShipment]);
});