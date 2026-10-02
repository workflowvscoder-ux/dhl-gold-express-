const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function ensureFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([], null, 2));
}

ensureFile(DATA_FILE);

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

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ message: 'Deletion is disabled until ADMIN_API_KEY is configured.' });
  }
  if (req.get('x-admin-key') !== ADMIN_API_KEY) {
    return res.status(401).json({ message: 'Authorised admin access is required.' });
  }
  next();
}

app.post('/create-shipment', (req, res) => {
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

app.get('/shipments', (_req, res) => res.json(readShipments()));

// Every request appends an immutable event; it never replaces previous tracking updates.
app.put('/update-status/:trackingNumber', (req, res) => {
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
app.delete('/shipments/:trackingNumber', requireAdmin, (req, res) => {
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
