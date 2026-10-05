const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const backendDirectory = path.join(__dirname, '..');
let databaseDirectory;
let serverProcess;
let serverLogs = '';
let serverPort;
const databaseDirectories = [];

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
  serverPort = await getAvailablePort();
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      PORT: String(serverPort),
      DATABASE_URL: 'postgresql://pglite/test',
      TEST_DATABASE_DIR: databaseDirectory,
      FRONTEND_ORIGIN: 'https://frontend.example.test',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  const deadline = Date.now() + 30000;
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
  const requestOptions = options;
  const response = await fetch(`http://127.0.0.1:${serverPort}${route}`, {
    ...requestOptions,
    headers: { 'Content-Type': 'application/json', ...(requestOptions.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, setCookie: response.headers.get('set-cookie') };
}

after(async () => {
  await stopServer();
  await Promise.all(databaseDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test('source and deployment frontend copies remain synchronized', async () => {
  const frontendRoot = path.join(backendDirectory, '..');
  for (const fileName of ['admin.html', 'ship.html', 'track.html', 'style.css', path.join('js', 'app.js')]) {
    const source = await fs.readFile(path.join(frontendRoot, fileName));
    const deployment = await fs.readFile(path.join(frontendRoot, 'frontend-https-deploy', fileName));
    assert.deepEqual(deployment, source, `${fileName} differs from its deployment copy`);
  }
  const adminDashboard = await fs.readFile(path.join(frontendRoot, 'admin.html'), 'utf8');
  const sharedBrowserHelpers = await fs.readFile(path.join(frontendRoot, 'js', 'app.js'), 'utf8');
  assert.match(adminDashboard, /<main id="dashboard" class="container section">/);
  assert.doesNotMatch(adminDashboard, /adminLogin|adminLogout|\/auth\/(login|me|logout)|Sign In/);
  assert.doesNotMatch(sharedBrowserHelpers, /adminCsrfToken|setAdminCsrfToken|X-CSRF-Token/);
});

test('PostgreSQL shipment flow preserves history and data across backend restart', { timeout: 120000 }, async () => {
  databaseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dhl-pglite-e2e-'));
  databaseDirectories.push(databaseDirectory);
  const legacyDataFile = path.join(databaseDirectory, 'legacy-data.json');
  const legacyTrackingNumber = 'DHLG123457';
  const legacyShipment = {
    trackingNumber: legacyTrackingNumber,
    sender: 'Legacy E2E Sender',
    receiver: 'Legacy E2E Receiver',
    origin: 'Legacy Origin',
    destination: 'Legacy Destination',
    email: 'legacy@example.invalid',
    weight: '3',
    type: 'Express',
    transportMode: 'Air Freight',
    status: 'In transit',
    location: 'Legacy Current Location',
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    legacyReference: 'PRESERVED-LEGACY-FIELD',
    trackingHistory: [
      {
        id: 'legacy-event-created',
        status: 'Shipment label created',
        location: 'Legacy Origin',
        message: 'Legacy creation event',
        timestamp: '2026-01-01T08:00:00.000Z',
        eventType: 'created',
        externalEventCode: 'LEGACY-CREATE'
      },
      {
        id: 'legacy-event-moved',
        status: 'In transit',
        location: 'Legacy Current Location',
        message: 'Legacy movement event',
        timestamp: '2026-01-01T09:00:00.000Z',
        eventType: 'updated'
      }
    ],
    events: [
      { id: 'legacy-event-created' },
      { id: 'legacy-event-moved' }
    ]
  };
  await fs.writeFile(legacyDataFile, JSON.stringify([legacyShipment], null, 2));
  const migrationEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://pglite/test',
    TEST_DATABASE_DIR: databaseDirectory,
    NODE_ENV: 'test'
  };
  const migration = spawnSync(process.execPath, ['migrate-file-data.js', legacyDataFile], {
    cwd: backendDirectory,
    env: migrationEnv,
    encoding: 'utf8'
  });
  assert.equal(migration.status, 0, migration.stderr);
  assert.match(migration.stdout, /Imported shipments: 1/);
  const repeatedMigration = spawnSync(process.execPath, ['migrate-file-data.js', legacyDataFile], {
    cwd: backendDirectory,
    env: migrationEnv,
    encoding: 'utf8'
  });
  assert.equal(repeatedMigration.status, 0, repeatedMigration.stderr);
  assert.match(repeatedMigration.stdout, /Skipped existing shipments: 1/);
  await startServer();

  const health = await request('/health', { anonymous: true });
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  for (const route of ['/auth/setup/status', '/auth/me']) {
    assert.equal((await request(route)).status, 404);
  }
  assert.equal((await request('/auth/login', { method: 'POST' })).status, 404);
  assert.equal((await request('/auth/logout', { method: 'POST' })).status, 404);
  assert.equal((await request('/auth/setup', { method: 'POST' })).status, 404);
  assert.equal((await request('/shipments')).setCookie, null);

  const migratedTracking = await request(`/track/${legacyTrackingNumber}`);
  assert.equal(migratedTracking.status, 200);
  assert.equal(migratedTracking.body.trackingNumber, legacyTrackingNumber);
  assert.equal(Object.hasOwn(migratedTracking.body, 'email'), false);
  assert.equal(migratedTracking.body.origin, 'Legacy Origin');
  assert.equal(migratedTracking.body.destination, 'Legacy Destination');
  assert.equal(migratedTracking.body.status, 'In transit');
  assert.equal(migratedTracking.body.location, 'Legacy Current Location');
  assert.equal(migratedTracking.body.trackingHistory.length, 2);
  assert.equal(migratedTracking.body.transportMode, 'Air Freight');

  const created = await request('/create-shipment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: 'E2E Sender',
      receiver: 'E2E Receiver',
      origin: 'E2E Origin',
      destination: 'E2E Destination',
      email: 'e2e@example.invalid',
      weight: '2',
      type: 'Express'
    })
  });
  assert.equal(created.status, 201);
  assert.equal(Object.hasOwn(created.body.shipment, 'email'), false);
  const trackingNumber = created.body.trackingNumber;
  assert.match(trackingNumber, /^DHLG\d{12}$/);
  assert.equal(created.body.shipment.trackingNumber, trackingNumber);
  assert.equal(created.body.shipment.transportMode, 'Ocean Freight');
  assert.equal(created.body.shipment.trackingHistory.length, 1);
  assert.equal(created.body.shipment.trackingHistory[0].eventType, 'created');
  const createdAt = created.body.shipment.trackingHistory[0].timestamp;
  assert.equal((await request(`/shipments/${trackingNumber}`, { method: 'DELETE' })).status, 409);

  const publicCreatedTracking = await request(`/track/${trackingNumber}`);
  assert.equal(publicCreatedTracking.status, 200);
  assert.equal(Object.hasOwn(publicCreatedTracking.body, 'email'), false);
  assert.equal(publicCreatedTracking.body.trackingNumber, trackingNumber);
  assert.equal(publicCreatedTracking.body.origin, 'E2E Origin');
  assert.equal(publicCreatedTracking.body.destination, 'E2E Destination');
  assert.equal(publicCreatedTracking.body.status, 'Shipment Created');
  assert.equal(publicCreatedTracking.body.location, 'E2E Origin');
  assert.ok(publicCreatedTracking.body.createdAt);
  assert.ok(Array.isArray(publicCreatedTracking.body.trackingHistory));
  assert.equal(publicCreatedTracking.body.trackingHistory.length, 1);

  const shipments = await request('/shipments');
  assert.equal(shipments.status, 200);
  assert.equal(shipments.body.some((shipment) => shipment.trackingNumber === trackingNumber), true);
  const shipmentFromDashboard = shipments.body.find((shipment) => shipment.trackingNumber === trackingNumber);
  assert.ok(shipmentFromDashboard);
  assert.equal(shipmentFromDashboard.sender, 'E2E Sender');
  assert.equal(Object.hasOwn(shipmentFromDashboard, 'email'), false);
  const migratedAdminShipment = shipments.body.find((shipment) => shipment.trackingNumber === legacyTrackingNumber);
  assert.ok(migratedAdminShipment);
  assert.equal(migratedAdminShipment.location, 'Legacy Current Location');
  assert.equal(migratedAdminShipment.trackingHistory[0].status, 'Shipment label created');

  const archiveUndelivered = await request(`/shipments/${trackingNumber}`, {
    method: 'DELETE'
  });
  assert.equal(archiveUndelivered.status, 409);

  const update = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    body: JSON.stringify({
      status: 'Picked Up',
      location: 'E2E Pickup Location',
      message: 'Shipment picked up by carrier',
      eventType: 'picked_up',
      timestamp: new Date(Date.parse(createdAt) + 3000).toISOString()
    })
  });
  assert.equal(update.status, 200);
  assert.equal(Object.hasOwn(update.body.shipment, 'email'), false);
  assert.equal(update.body.shipment.status, 'Picked Up');
  assert.equal(update.body.shipment.location, 'E2E Pickup Location');
  assert.equal(update.body.shipment.trackingHistory.length, 2);
  assert.equal(update.body.shipment.trackingHistory[0].status, 'Shipment Created');
  assert.equal(update.body.shipment.trackingHistory[1].status, 'Picked Up');
  assert.equal(update.body.shipment.trackingHistory[1].location, 'E2E Pickup Location');

  const pickupTracking = await request(`/track/${trackingNumber}`);
  assert.equal(pickupTracking.status, 200);
  assert.equal(pickupTracking.body.status, 'Picked Up');
  assert.equal(pickupTracking.body.location, 'E2E Pickup Location');
  assert.equal(pickupTracking.body.trackingHistory.length, 2);

  const secondUpdate = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    body: JSON.stringify({
      status: 'In transit by sea',
      location: 'E2E Update Location',
      message: 'E2E status/location change',
      eventType: 'in_transit',
      timestamp: new Date(Date.parse(createdAt) + 2000).toISOString()
    })
  });
  assert.equal(secondUpdate.status, 200);
  assert.equal(secondUpdate.body.shipment.status, 'In transit by sea');
  assert.equal(secondUpdate.body.shipment.location, 'E2E Update Location');
  assert.equal(secondUpdate.body.shipment.trackingHistory.length, 3);
  assert.deepEqual(
    secondUpdate.body.shipment.trackingHistory.map((event) => event.status),
    ['Shipment Created', 'In transit by sea', 'Picked Up']
  );
  const secondUpdateTimes = secondUpdate.body.shipment.trackingHistory.map((event) => Date.parse(event.timestamp));
  assert.ok(secondUpdateTimes.every((timestamp, index) => index === 0 || secondUpdateTimes[index - 1] <= timestamp));

  const trackedUpdate = await request(`/track/${trackingNumber}`);
  assert.equal(trackedUpdate.status, 200);
  assert.equal(trackedUpdate.body.status, 'In transit by sea');
  assert.equal(trackedUpdate.body.location, 'E2E Update Location');
  assert.equal(trackedUpdate.body.trackingHistory.length, 3);

  const delivered = await request(`/update-status/${trackingNumber}`, {
    method: 'PUT',
    body: JSON.stringify({
      status: 'Delivered',
      location: 'E2E Destination',
      timestamp: new Date(Date.parse(createdAt) + 4000).toISOString()
    })
  });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.shipment.trackingHistory.length, 4);
  await stopServer();
  await startServer();

  const trackingAfterRestart = await request(`/track/${trackingNumber}`);
  assert.equal(trackingAfterRestart.status, 200);
  assert.equal(trackingAfterRestart.body.status, 'Delivered');
  assert.equal(trackingAfterRestart.body.trackingHistory.length, 4);
  assert.equal(trackingAfterRestart.body.trackingHistory[0].status, 'Shipment Created');
  assert.deepEqual(
    trackingAfterRestart.body.trackingHistory.map((event) => event.status),
    ['Shipment Created', 'In transit by sea', 'Picked Up', 'Delivered']
  );
  const restoredHistoryTimes = trackingAfterRestart.body.trackingHistory.map((event) => Date.parse(event.timestamp));
  assert.ok(restoredHistoryTimes.every((timestamp, index) => index === 0 || restoredHistoryTimes[index - 1] <= timestamp));

  const adminAfterRestart = await request('/shipments');
  const persistedShipment = adminAfterRestart.body.find((shipment) => shipment.trackingNumber === trackingNumber);
  assert.ok(persistedShipment);
  assert.equal(persistedShipment.status, 'Delivered');
  assert.equal(persistedShipment.location, 'E2E Destination');
  assert.equal(persistedShipment.trackingHistory.length, 4);

  const deleted = await request(`/shipments/${trackingNumber}`, {
    method: 'DELETE'
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.archived, true);
  assert.equal((await request(`/track/${trackingNumber}`)).status, 404);
  const archivedInAdmin = await request('/shipments');
  const archivedShipment = archivedInAdmin.body.find((shipment) => shipment.trackingNumber === trackingNumber);
  assert.ok(archivedShipment);
  assert.ok(archivedShipment.archivedAt);
  assert.equal(archivedShipment.status, 'Delivered');
  assert.equal(archivedShipment.location, 'E2E Destination');
  assert.equal(archivedShipment.trackingHistory.length, 4);
  assert.equal(archivedShipment.trackingHistory[0].status, 'Shipment Created');
  assert.equal((await request(`/shipments/${trackingNumber}`, {
    method: 'DELETE'
  })).status, 404);

  await stopServer();
  await startServer();
  assert.equal((await request(`/track/${trackingNumber}`)).status, 404);
  const archivedAfterRestart = await request('/shipments');
  const restoredArchivedShipment = archivedAfterRestart.body.find((shipment) => shipment.trackingNumber === trackingNumber);
  assert.ok(restoredArchivedShipment);
  assert.ok(restoredArchivedShipment.archivedAt);
  assert.equal(restoredArchivedShipment.status, 'Delivered');
  assert.equal(restoredArchivedShipment.location, 'E2E Destination');
  assert.equal(restoredArchivedShipment.trackingHistory.length, 4);
  const archivedHistoryTimes = restoredArchivedShipment.trackingHistory.map((event) => Date.parse(event.timestamp));
  assert.ok(archivedHistoryTimes.every((timestamp, index) => index === 0 || archivedHistoryTimes[index - 1] <= timestamp));

  let successfulTrackingRequests = 0;
  let trackingRateLimited = false;
  for (let attempt = 0; attempt < 130; attempt += 1) {
    const response = await request(`/track/${legacyTrackingNumber}`);
    if (response.status === 429) {
      trackingRateLimited = true;
      assert.match(response.body.message, /Too many tracking requests/);
      break;
    }
    assert.equal(response.status, 200);
    successfulTrackingRequests += 1;
  }
  assert.equal(trackingRateLimited, true);
  assert.ok(successfulTrackingRequests >= 100);

  const creationStatuses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await request('/create-shipment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'Rate Limit Sender',
        receiver: 'Rate Limit Receiver',
        origin: 'Rate Limit Origin',
        destination: 'Rate Limit Destination'
      })
    });
    creationStatuses.push(response.status);
    if (response.status === 429) assert.match(response.body.message, /Too many shipment creation requests/);
  }
  assert.equal(creationStatuses.filter((status) => status === 201).length, 10);
  assert.equal(creationStatuses[10], 429);
  await stopServer();
});

test('production startup requires database and frontend origin configuration', { timeout: 10000 }, async () => {
  for (const missingVariable of ['DATABASE_URL', 'FRONTEND_ORIGIN']) {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(await getAvailablePort()),
      DATABASE_URL: 'postgresql://test.invalid/database',
      FRONTEND_ORIGIN: 'https://frontend.example.test'
    };
    delete env[missingVariable];
    delete env.ADMIN_SETUP_TOKEN;
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
    assert.match(output, new RegExp(`${missingVariable} must be configured`));
  }
});