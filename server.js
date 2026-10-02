const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { rateLimit } = require('express-rate-limit');

const app = express();

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SESSION_DIR = path.join(DATA_DIR, 'admin-sessions');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session-secret');
const SESSION_COOKIE_NAME = 'dhl_gold_express.sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const allowedOrigins = new Set((process.env.FRONTEND_ORIGIN || 'http://localhost:5500,http://127.0.0.1:5500')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));

app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token']
}));
app.use(express.json({ limit: '10kb' }));

function ensureFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([], null, 2));
}

ensureFile(DATA_FILE);

function getOrCreateSessionSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    return fs.readFileSync(SESSION_SECRET_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const secret = crypto.randomBytes(64).toString('hex');
  try {
    fs.writeFileSync(SESSION_SECRET_FILE, secret, { flag: 'wx', mode: 0o600 });
    return secret;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(SESSION_SECRET_FILE, 'utf8');
  }
}

const sessionSecret = getOrCreateSessionSecret();
const secureCookies = process.env.NODE_ENV === 'production';
const sessionCookieOptions = {
  httpOnly: true,
  secure: secureCookies,
  sameSite: secureCookies ? 'none' : 'lax',
  maxAge: SESSION_TTL_MS,
  path: '/'
};

app.use(session({
  name: SESSION_COOKIE_NAME,
  secret: sessionSecret,
  store: new FileStore({
    path: SESSION_DIR,
    secret: sessionSecret,
    ttl: SESSION_TTL_MS / 1000,
    reapInterval: 60 * 60,
    logFn() {}
  }),
  resave: false,
  saveUninitialized: false,
  cookie: sessionCookieOptions
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in 15 minutes.' }
});
const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many setup attempts. Please try again later.' }
});

function readAdminAccount() {
  if (!fs.existsSync(ADMIN_FILE)) return null;
  return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
}

function isSetupTokenConfigured() {
  const token = process.env.ADMIN_SETUP_TOKEN;
  return typeof token === 'string'
    && Buffer.byteLength(token, 'utf8') >= 32
    && new Set(token).size >= 16
    && !token.toLowerCase().startsWith('replace-with-');
}

function constantTimeEqual(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function requireAdmin(req, res, next) {
  if (!req.session.adminUsername) {
    return res.status(401).json({ message: 'Administrator login is required.' });
  }
  next();
}

function requireCsrf(req, res, next) {
  if (!constantTimeEqual(req.get('x-csrf-token'), req.session.csrfToken)) {
    return res.status(403).json({ message: 'A valid CSRF token is required.' });
  }
  next();
}

function regenerateAdminSession(req, username) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.adminUsername = username;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save((saveError) => {
        if (saveError) return reject(saveError);
        resolve(req.session.csrfToken);
      });
    });
  });
}

function readData() {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateTracking() {
  return `DHLG${Math.floor(100000 + Math.random() * 900000)}`;
}

function isDelivered(status) {
  return String(status || '').trim().toLowerCase() === 'delivered';
}

function normaliseDate(value, fieldName = 'timestamp') {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid ISO date/time`);
  return date.toISOString();
}

function createEvent({ status, location, message, timestamp, vessel, voyage, vesselName, voyageNumber, eventType }) {
  if (!status || !String(status).trim()) throw new Error('status is required');
  if (!location || !String(location).trim()) throw new Error('location is required');

  vessel = vessel ?? vesselName;
  voyage = voyage ?? voyageNumber;

  return {
    id: crypto.randomUUID(),
    status: String(status).trim(),
    location: String(location).trim(),
    message: message ? String(message).trim() : null,
    timestamp: normaliseDate(timestamp),
    vessel: vessel ? String(vessel).trim() : null,
    voyage: voyage ? String(voyage).trim() : null,
    vesselName: vessel ? String(vessel).trim() : null,
    voyageNumber: voyage ? String(voyage).trim() : null,
    eventType: eventType ? String(eventType).trim() : 'updated'
  };
}

function normaliseEvent(event) {
  return {
    id: event.id || crypto.randomUUID(),
    status: String(event.status || event.title || 'Shipment update').trim(),
    location: String(event.location || event.place || 'Location not provided').trim(),
    message: event.message || event.description || event.details || null,
    timestamp: normaliseDate(event.timestamp || event.date || event.updatedAt || event.createdAt),
    vessel: event.vessel ?? event.vesselName ?? null,
    voyage: event.voyage ?? event.voyageNumber ?? null,
    vesselName: event.vessel ?? event.vesselName ?? null,
    voyageNumber: event.voyage ?? event.voyageNumber ?? null,
    eventType: event.eventType || 'updated'
  };
}

// Legacy records are migrated once and then written back so refreshes and restarts retain the history.
function normaliseShipment(shipment) {
  const events = Array.isArray(shipment.trackingHistory)
    ? shipment.trackingHistory
    : Array.isArray(shipment.events)
      ? shipment.events
      : [];

  const history = events.length ? events : [createEvent({
    status: shipment.status || 'Shipment created',
    location: shipment.location || shipment.origin || 'Origin facility',
    message: 'Tracking record migrated from the previous shipment format.',
    timestamp: shipment.date || shipment.createdAt,
    eventType: 'created'
  })];

  const chronologicalHistory = history.map(normaliseEvent)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const latest = chronologicalHistory[chronologicalHistory.length - 1];
  return {
    ...shipment,
    status: latest.status,
    location: latest.location,
    date: latest.timestamp,
    trackingHistory: chronologicalHistory,
    events: chronologicalHistory
  };
}

function readShipments() {
  const data = readData();
  const normalised = data.map(normaliseShipment);
  if (JSON.stringify(data) !== JSON.stringify(normalised)) writeData(normalised);
  return normalised;
}

app.get('/auth/setup/status', (_req, res) => {
  const setupRequired = !readAdminAccount();
  res.json({
    setupRequired,
    setupEnabled: setupRequired && isSetupTokenConfigured()
  });
});

app.post('/auth/setup', setupLimiter, async (req, res) => {
  if (readAdminAccount()) {
    return res.status(409).json({ message: 'Administrator setup has already been completed.' });
  }

  const { setupToken, username, password } = req.body;
  if (!isSetupTokenConfigured()
    || !constantTimeEqual(setupToken, process.env.ADMIN_SETUP_TOKEN)) {
    return res.status(403).json({ message: 'The initial setup token is invalid or not configured with at least 32 bytes.' });
  }

  const cleanUsername = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(cleanUsername)) {
    return res.status(400).json({ message: 'Username must be 3-32 characters using letters, numbers, dot, underscore, or hyphen.' });
  }
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ message: 'Password must be at least 12 characters and no more than 72 UTF-8 bytes.' });
  }

  try {
    const account = {
      username: cleanUsername.toLowerCase(),
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(account, null, 2), { flag: 'wx', mode: 0o600 });
    return res.status(201).json({ message: 'Administrator created. You can now log in.' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return res.status(409).json({ message: 'Administrator setup has already been completed.' });
    }
    return res.status(500).json({ message: 'Unable to create the administrator account.' });
  }
});

app.post('/auth/login', loginLimiter, async (req, res) => {
  const account = readAdminAccount();
  if (!account) {
    return res.status(503).json({ message: 'Initial administrator setup is required.' });
  }

  const username = String(req.body.username || '').trim().toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  let passwordMatches = false;
  if (Buffer.byteLength(password, 'utf8') <= 72) {
    try {
      passwordMatches = await bcrypt.compare(password, account.passwordHash);
    } catch (_error) {
      return res.status(500).json({ message: 'Unable to verify administrator credentials.' });
    }
  }
  const validPassword = username === account.username && passwordMatches;
  if (!validPassword) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  try {
    const csrfToken = await regenerateAdminSession(req, account.username);
    return res.json({ authenticated: true, username: account.username, csrfToken });
  } catch (_error) {
    return res.status(500).json({ message: 'Unable to create a login session.' });
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session.adminUsername) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, username: req.session.adminUsername, csrfToken: req.session.csrfToken });
});

app.post('/auth/logout', requireAdmin, requireCsrf, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE_NAME, { ...sessionCookieOptions, maxAge: undefined });
    res.json({ message: 'Logged out successfully.' });
  });
});

app.post('/create-shipment', requireAdmin, requireCsrf, (req, res) => {
  const data = readShipments();
  const { sender, receiver, origin, destination, email, weight, type, status, location, message, timestamp,
    vessel, voyage, vesselName, voyageNumber } = req.body;
  if (!sender || !receiver || !origin || !destination) {
    return res.status(400).json({ message: 'Missing required shipment fields' });
  }

  try {
    const initialEvent = createEvent({
      status: status || 'Shipment label created',
      location: location || origin,
      message: message || 'Shipment registered and awaiting origin processing.',
      timestamp,
      vessel,
      voyage,
      vesselName,
      voyageNumber,
      eventType: 'created'
    });
    const shipment = {
      trackingNumber: generateTracking(), sender, receiver, origin, destination,
      email: email || null, weight: weight || null, type: type || 'Ocean Freight',
      transportMode: req.body.transportMode || 'Ocean Freight',
      status: initialEvent.status, location: initialEvent.location,
      date: initialEvent.timestamp, createdAt: initialEvent.timestamp,
      trackingHistory: [initialEvent],
      events: [initialEvent]
    };
    data.push(shipment);
    writeData(data);
    res.status(201).json({ message: 'Shipment created', trackingNumber: shipment.trackingNumber, shipment: normaliseShipment(shipment) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/track/:trackingNumber', (req, res) => {
  const shipment = readShipments().find((item) => item.trackingNumber === req.params.trackingNumber);
  if (!shipment) return res.status(404).json({ message: 'Tracking number not found' });
  res.json(normaliseShipment(shipment));
});

app.get('/shipments', requireAdmin, (_req, res) => res.json(readShipments()));

// Every request appends an immutable event; it never replaces previous tracking updates.
app.put('/update-status/:trackingNumber', requireAdmin, requireCsrf, (req, res) => {
  const data = readShipments();
  const shipment = data.find((item) => item.trackingNumber === req.params.trackingNumber);
  if (!shipment) return res.status(404).json({ message: 'Tracking number not found' });

  if (isDelivered(shipment.status) && req.body.overrideDelivered !== true) {
    return res.status(409).json({ message: 'This shipment is delivered. Set overrideDelivered: true for an explicit administrator override.' });
  }

  try {
    const event = createEvent(req.body);
    const history = [...shipment.trackingHistory, normaliseEvent(event)];
    shipment.trackingHistory = history;
    shipment.events = history;
    shipment.status = event.status;
    shipment.location = event.location;
    shipment.date = event.timestamp;
    shipment.updatedAt = new Date().toISOString();
    writeData(data);
    res.json({ message: 'Tracking event saved successfully', shipment: normaliseShipment(shipment) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delivered shipments may be permanently removed by an authenticated administrator only.
app.delete('/shipments/:trackingNumber', requireAdmin, requireCsrf, (req, res) => {
  const data = readShipments();
  const index = data.findIndex((item) => item.trackingNumber === req.params.trackingNumber);
  if (index === -1) return res.status(404).json({ message: 'Tracking number not found' });
  if (!isDelivered(data[index].status)) {
    return res.status(409).json({ message: 'Only delivered shipments can be deleted.' });
  }
  data.splice(index, 1);
  writeData(data);
  res.json({ message: 'Delivered shipment deleted permanently.' });
});

app.get('/', (_req, res) => res.send('DHL Gold Express backend is running'));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dhl-gold-express-backend' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
