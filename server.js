const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { closeDatabase, initializeDatabase } = require('./database');
const { createShipment, deleteShipment, findPublicShipment, listShipments, updateShipment } = require('./storage');

const app = express();

const PORT = process.env.PORT || 3000;
const configuredFrontendOrigin = typeof process.env.FRONTEND_ORIGIN === 'string'
  ? process.env.FRONTEND_ORIGIN.trim()
  : '';
if (process.env.NODE_ENV === 'production' && !configuredFrontendOrigin) {
  throw new Error('FRONTEND_ORIGIN must be configured in production for browser API access.');
}
const allowedOrigins = new Set((configuredFrontendOrigin || 'http://localhost:5500,http://127.0.0.1:5500,http://localhost:8765,http://127.0.0.1:8765,http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));
if (process.env.NODE_ENV === 'production') {
  for (const origin of allowedOrigins) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch (_error) {
      throw new Error('FRONTEND_ORIGIN must contain valid origins.');
    }
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
      throw new Error('FRONTEND_ORIGIN entries must be exact origins without paths or trailing slashes.');
    }
  }
}

app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10kb' }));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const publicTrackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many tracking requests. Please try again in 15 minutes.' }
});
const createShipmentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many shipment creation requests. Please try again in 15 minutes.' }
});

function toDashboardShipment(shipment) {
  return {
    trackingNumber: shipment.trackingNumber,
    sender: shipment.sender,
    receiver: shipment.receiver,
    origin: shipment.origin,
    destination: shipment.destination,
    type: shipment.type,
    transportMode: shipment.transportMode,
    status: shipment.status,
    location: shipment.location,
    date: shipment.date,
    createdAt: shipment.createdAt,
    ...(shipment.updatedAt ? { updatedAt: shipment.updatedAt } : {}),
    ...(shipment.archivedAt ? { archivedAt: shipment.archivedAt } : {}),
    trackingHistory: shipment.trackingHistory.map((event) => ({
      status: event.status,
      location: event.location,
      message: event.message,
      timestamp: event.timestamp,
      date: event.date,
      eventType: event.eventType
    }))
  };
}

app.post('/create-shipment', createShipmentLimiter, asyncHandler(async (req, res) => {
  const { sender, receiver, origin, destination } = req.body;
  if (!sender || !receiver || !origin || !destination) {
    return res.status(400).json({ message: 'Missing required shipment fields' });
  }

  const shipment = await createShipment(req.body, 'customer');
  res.status(201).json({
    message: 'Shipment created',
    trackingNumber: shipment.trackingNumber,
    shipment: await findPublicShipment(shipment.trackingNumber)
  });
}));

app.get('/track/:trackingNumber', publicTrackingLimiter, asyncHandler(async (req, res) => {
  const shipment = await findPublicShipment(req.params.trackingNumber);
  if (!shipment) return res.status(404).json({ message: 'Tracking number not found' });
  res.json(shipment);
}));

app.get('/shipments', asyncHandler(async (_req, res) => {
  const shipments = await listShipments();
  res.json(shipments.map(toDashboardShipment));
}));

app.put('/update-status/:trackingNumber', asyncHandler(async (req, res) => {
  const shipment = await updateShipment(
    req.params.trackingNumber,
    req.body,
    'admin',
    req.body.overrideDelivered === true
  );
  if (!shipment) return res.status(404).json({ message: 'Tracking number not found' });
  res.json({
    message: 'Tracking event saved successfully',
    shipment: await findPublicShipment(shipment.trackingNumber)
  });
}));

app.delete('/shipments/:trackingNumber', asyncHandler(async (req, res) => {
  const archived = await deleteShipment(req.params.trackingNumber);
  if (!archived) return res.status(404).json({ message: 'Active tracking number not found' });
  res.json({ message: 'Delivered shipment archived. Its record and history have been retained.', archived: true });
}));

app.get('/', (_req, res) => res.send('DHL Gold Express backend is running'));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dhl-gold-express-backend' }));

app.use((error, _req, res, next) => {
  console.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  res.status(status).json({ message: status < 500 ? error.message : 'Internal server error.' });
});

async function startServer() {
  await initializeDatabase();
  const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  const shutdown = () => server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

startServer().catch(async (error) => {
  console.error('Backend startup failed:', error.message);
  await closeDatabase().catch(() => {});
  process.exitCode = 1;
});
