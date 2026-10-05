const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { getDatabase, withTransaction } = require('./database');

const shipmentFields = new Set([
  'id', 'trackingNumber', 'sender', 'receiver', 'origin', 'destination', 'email', 'weight',
  'type', 'transportMode', 'status', 'location', 'createdAt', 'updatedAt', 'date',
  'trackingHistory', 'events', 'history'
]);
const historyFields = new Set([
  'id', 'status', 'title', 'location', 'place', 'message', 'description', 'details',
  'timestamp', 'date', 'updatedAt', 'createdAt', 'eventType', 'vessel', 'vesselName',
  'voyage', 'voyageNumber', 'changedBy'
]);

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function dateIso(value, fallback) {
  const date = new Date(value || fallback || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('Shipment timestamp must be valid.');
  return date.toISOString();
}

function makeEvent(input, changedBy, fallbackTimestamp) {
  if (!input.status || !String(input.status).trim()) throw new Error('status is required');
  if (!input.location || !String(input.location).trim()) throw new Error('location is required');
  const vessel = input.vessel ?? input.vesselName;
  const voyage = input.voyage ?? input.voyageNumber;
  const extra = Object.fromEntries(Object.entries(input).filter(([key]) => !historyFields.has(key)));

  return {
    id: String(input.id || crypto.randomUUID()),
    status: String(input.status || input.title).trim(),
    location: String(input.location || input.place).trim(),
    message: input.message || input.description || input.details || null,
    eventType: input.eventType || 'updated',
    changedBy: input.changedBy || changedBy,
    timestamp: dateIso(input.timestamp || input.date || input.updatedAt || input.createdAt, fallbackTimestamp),
    vessel: vessel ? String(vessel).trim() : null,
    voyage: voyage ? String(voyage).trim() : null,
    extra
  };
}

function eventToApi(row) {
  const timestamp = dateIso(row.created_at);
  return {
    ...jsonObject(row.extra),
    id: String(row.id),
    status: row.status,
    location: row.location,
    message: row.message,
    timestamp,
    date: timestamp,
    eventType: row.event_type,
    changedBy: row.changed_by,
    vessel: row.vessel,
    voyage: row.voyage,
    vesselName: row.vessel,
    voyageNumber: row.voyage
  };
}

function shipmentToApi(row, history) {
  const createdAt = dateIso(row.created_at);
  const updatedAt = row.updated_at ? dateIso(row.updated_at) : undefined;
  const trackingHistory = history.map(eventToApi);
  const latest = trackingHistory[trackingHistory.length - 1];
  return {
    ...jsonObject(row.extra),
    id: String(row.id),
    trackingNumber: row.tracking_number,
    sender: row.sender,
    receiver: row.receiver,
    origin: row.origin,
    destination: row.destination,
    email: row.email,
    weight: row.weight,
    type: row.type,
    transportMode: row.transport_mode,
    status: row.status,
    location: row.location,
    date: latest ? latest.timestamp : createdAt,
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    ...(row.archived_at ? { archivedAt: dateIso(row.archived_at) } : {}),
    trackingHistory,
    events: trackingHistory
  };
}

async function getHistory(client, trackingNumber) {
  const result = await client.query(
    'SELECT * FROM shipment_history WHERE tracking_number = $1 ORDER BY created_at, sequence',
    [trackingNumber]
  );
  return result.rows;
}

async function getShipmentWithHistory(client, trackingNumber) {
  const result = await client.query(
    'SELECT * FROM shipments WHERE tracking_number = $1 AND archived_at IS NULL',
    [trackingNumber]
  );
  if (!result.rows[0]) return null;
  return shipmentToApi(result.rows[0], await getHistory(client, trackingNumber));
}

async function insertHistory(client, shipment, event) {
  await client.query(
    `INSERT INTO shipment_history
      (id, shipment_id, tracking_number, status, location, message, event_type, changed_by, created_at, vessel, voyage, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [event.id, shipment.id, shipment.tracking_number, event.status, event.location, event.message,
      event.eventType, event.changedBy, event.timestamp, event.vessel, event.voyage, JSON.stringify(event.extra)]
  );
}

async function insertShipment(client, input, { changedBy, imported = false } = {}) {
  const rawHistory = Array.isArray(input.trackingHistory) && input.trackingHistory.length
    ? input.trackingHistory
    : Array.isArray(input.events) && input.events.length
      ? input.events
      : Array.isArray(input.history) ? input.history : [];
  const createdAt = dateIso(input.createdAt || input.date || (rawHistory[0] && rawHistory[0].timestamp));
  const id = String(input.id || crypto.randomUUID());
  const trackingNumber = String(input.trackingNumber || '');
  if (!trackingNumber) throw new Error('trackingNumber is required');

  let events = rawHistory.map((event) => makeEvent(event, event.changedBy || changedBy || (imported ? 'migration' : 'customer'), createdAt));
  if (!events.length) {
    events = [makeEvent({
      status: input.status || 'Shipment Created',
      location: input.location || input.origin,
      message: imported ? 'Imported legacy shipment state.' : 'Shipment registered and awaiting origin processing.',
      timestamp: input.date || createdAt,
      eventType: 'created'
    }, changedBy || (imported ? 'migration' : 'customer'), createdAt)];
  }
  events.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  const latest = events[events.length - 1];
  const shipment = {
    id,
    tracking_number: trackingNumber,
    sender: String(input.sender || ''),
    receiver: String(input.receiver || ''),
    origin: String(input.origin || ''),
    destination: String(input.destination || ''),
    email: input.email || null,
    weight: input.weight == null ? null : String(input.weight),
    type: input.type || 'Ocean Freight',
    transport_mode: input.transportMode || 'Ocean Freight',
    status: latest.status || input.status || 'Shipment Created',
    location: latest.location || input.location || input.origin,
    created_at: createdAt,
    updated_at: input.updatedAt ? dateIso(input.updatedAt) : null,
    extra: Object.fromEntries(Object.entries(input).filter(([key]) => !shipmentFields.has(key)))
  };

  await client.query(
    `INSERT INTO shipments
      (id, tracking_number, sender, receiver, origin, destination, email, weight, type, transport_mode, status, location, created_at, updated_at, extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
    [shipment.id, shipment.tracking_number, shipment.sender, shipment.receiver, shipment.origin,
      shipment.destination, shipment.email, shipment.weight, shipment.type, shipment.transport_mode,
      shipment.status, shipment.location, shipment.created_at, shipment.updated_at, JSON.stringify(shipment.extra)]
  );
  for (const event of events) await insertHistory(client, shipment, event);
  return shipmentToApi(shipment, events.map((event) => ({
    ...event,
    event_type: event.eventType,
    changed_by: event.changedBy,
    created_at: event.timestamp
  })));
}

function newTrackingNumber() {
  return `DHLG${crypto.randomInt(0, 1000000000000).toString().padStart(12, '0')}`;
}

async function createShipment(input, changedBy = 'customer') {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shipmentInput = { ...input, trackingNumber: newTrackingNumber() };
    try {
      return await withTransaction((client) => insertShipment(client, shipmentInput, { changedBy }));
    } catch (error) {
      if (error.code !== '23505' || attempt === 4) throw error;
    }
  }
  throw new Error('Unable to generate a unique tracking number.');
}

async function listShipments() {
  const client = getDatabase();
  const result = await client.query('SELECT * FROM shipments ORDER BY created_at DESC, tracking_number');
  if (!result.rows.length) return [];
  const trackingNumbers = result.rows.map((row) => row.tracking_number);
  const placeholders = trackingNumbers.map((_value, index) => `$${index + 1}`).join(', ');
  const historyResult = await client.query(
    'SELECT * FROM shipment_history WHERE tracking_number = ANY($1::text[]) ORDER BY created_at, sequence',
    [trackingNumbers]
  );
  const histories = new Map(trackingNumbers.map((trackingNumber) => [trackingNumber, []]));
  for (const event of historyResult.rows) histories.get(event.tracking_number).push(event);
  return result.rows.map((row) => shipmentToApi(row, histories.get(row.tracking_number) || []));
}

async function findShipment(trackingNumber) {
  return getShipmentWithHistory(getDatabase(), trackingNumber);
}

function toPublicTrackingResponse(shipment) {
  if (!shipment) return null;
  const trackingHistory = shipment.trackingHistory.map((event) => ({
    status: event.status,
    location: event.location,
    message: event.message,
    timestamp: event.timestamp,
    date: event.date,
    eventType: event.eventType
  }));
  return {
    trackingNumber: shipment.trackingNumber,
    origin: shipment.origin,
    destination: shipment.destination,
    type: shipment.type,
    transportMode: shipment.transportMode,
    status: shipment.status,
    location: shipment.location,
    date: shipment.date,
    createdAt: shipment.createdAt,
    ...(shipment.updatedAt ? { updatedAt: shipment.updatedAt } : {}),
    trackingHistory,
    events: trackingHistory
  };
}

async function findPublicShipment(trackingNumber) {
  return toPublicTrackingResponse(await findShipment(trackingNumber));
}

async function updateShipment(trackingNumber, input, changedBy, overrideDelivered = false) {
  return withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM shipments WHERE tracking_number = $1 FOR UPDATE', [trackingNumber]);
    if (!current.rows[0]) return null;
    if (current.rows[0].archived_at) {
      const error = new Error('Archived shipments cannot be updated.');
      error.status = 409;
      throw error;
    }
    const currentHistory = await getHistory(client, trackingNumber);
    const latest = currentHistory[currentHistory.length - 1];
    const currentStatus = latest ? latest.status : current.rows[0].status;
    if (String(currentStatus || '').trim().toLowerCase() === 'delivered' && !overrideDelivered) {
      const error = new Error('This shipment is delivered. Set overrideDelivered: true for an explicit administrator override.');
      error.status = 409;
      throw error;
    }
    const nextEvent = makeEvent(input, changedBy, new Date().toISOString());
    await client.query(
      'UPDATE shipments SET status = $2, location = $3, updated_at = $4 WHERE tracking_number = $1',
      [trackingNumber, nextEvent.status, nextEvent.location, new Date().toISOString()]
    );
    const row = current.rows[0];
    await insertHistory(client, row, nextEvent);
    return shipmentToApi({
      ...row,
      status: nextEvent.status,
      location: nextEvent.location,
      updated_at: new Date().toISOString()
    }, [...currentHistory, {
      ...nextEvent,
      event_type: nextEvent.eventType,
      changed_by: nextEvent.changedBy,
      created_at: nextEvent.timestamp
    }].sort((left, right) => new Date(left.created_at || left.timestamp) - new Date(right.created_at || right.timestamp)));
  });
}

async function deleteShipment(trackingNumber) {
  return withTransaction(async (client) => {
    const current = await client.query(
      'SELECT status, archived_at FROM shipments WHERE tracking_number = $1 FOR UPDATE',
      [trackingNumber]
    );
    if (!current.rows[0] || current.rows[0].archived_at) return false;
    if (String(current.rows[0].status || '').trim().toLowerCase() !== 'delivered') {
      const error = new Error('Only delivered shipments can be deleted.');
      error.status = 409;
      throw error;
    }
    const result = await client.query(
      'UPDATE shipments SET archived_at = $2 WHERE tracking_number = $1 AND archived_at IS NULL RETURNING tracking_number',
      [trackingNumber, new Date().toISOString()]
    );
    return result.rowCount > 0;
  });
}

async function migrateLegacyFiles(dataFile) {
  const shipmentRows = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  if (!Array.isArray(shipmentRows)) throw new Error('Legacy shipment file must contain a JSON array.');

  return withTransaction(async (client) => {
    let importedShipments = 0;
    let skippedShipments = 0;
    for (const record of shipmentRows) {
      const exists = await client.query('SELECT 1 FROM shipments WHERE tracking_number = $1', [record.trackingNumber]);
      if (exists.rows.length) {
        skippedShipments += 1;
        continue;
      }
      await insertShipment(client, record, { changedBy: 'migration', imported: true });
      importedShipments += 1;
    }

    return { importedShipments, skippedShipments };
  });
}

module.exports = {
  createShipment,
  deleteShipment,
  findPublicShipment,
  findShipment,
  listShipments,
  migrateLegacyFiles,
  newTrackingNumber,
  updateShipment
};