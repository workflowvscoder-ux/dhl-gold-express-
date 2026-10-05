const { Pool } = require('pg');

let pool;
let embeddedDatabase;

function createEmbeddedPool(database) {
  return {
    query: (text, values) => database.query(text, values),
    async connect() {
      return {
        query: (text, values) => database.query(text, values),
        release() {}
      };
    },
    end: () => database.close()
  };
}

async function initializeDatabase() {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be configured.');

  if (process.env.NODE_ENV === 'test') {
    const testDatabaseDirectory = process.env.TEST_DATABASE_DIR;
    if (!testDatabaseDirectory) throw new Error('TEST_DATABASE_DIR is required for isolated tests.');
    const { PGlite } = await import('@electric-sql/pglite');
    embeddedDatabase = new PGlite(testDatabaseDirectory);
    await embeddedDatabase.waitReady;
    pool = createEmbeddedPool(embeddedDatabase);
  } else {
    let parsedUrl;
    try {
      parsedUrl = new URL(databaseUrl);
    } catch (_error) {
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
      throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
    }
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      keepAlive: true
    });
    pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message));
    await pool.query('SELECT 1');
  }

  await initializeSchema();
  return pool;
}

async function initializeSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      tracking_number TEXT NOT NULL UNIQUE,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      email TEXT,
      weight TEXT,
      type TEXT,
      transport_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      location TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE TABLE IF NOT EXISTS shipment_history (
      id TEXT PRIMARY KEY,
      sequence BIGSERIAL NOT NULL UNIQUE,
      shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE RESTRICT,
      tracking_number TEXT NOT NULL,
      status TEXT NOT NULL,
      location TEXT NOT NULL,
      message TEXT,
      event_type TEXT NOT NULL DEFAULT 'updated',
      changed_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      vessel TEXT,
      voyage TEXT,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    'CREATE INDEX IF NOT EXISTS shipment_history_tracking_time_idx ON shipment_history (tracking_number, created_at, sequence)'
  ];

  for (const statement of statements) await pool.query(statement);
  await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');

  const historyForeignKeys = await pool.query(
    `SELECT conname, confdeltype
     FROM pg_constraint
     WHERE conrelid = 'shipment_history'::regclass
       AND confrelid = 'shipments'::regclass
       AND contype = 'f'`
  );
  for (const foreignKey of historyForeignKeys.rows) {
    if (foreignKey.confdeltype === 'c') {
      const constraintName = String(foreignKey.conname).replace(/"/g, '""');
      await pool.query(`ALTER TABLE shipment_history DROP CONSTRAINT "${constraintName}"`);
    }
  }
  if (!historyForeignKeys.rows.some((foreignKey) => foreignKey.confdeltype === 'r' || foreignKey.confdeltype === 'a')) {
    await pool.query(
      `ALTER TABLE shipment_history
       ADD CONSTRAINT shipment_history_shipment_id_fkey
       FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT`
    );
  }
}

function getDatabase() {
  if (!pool) throw new Error('Database has not been initialized.');
  return pool;
}

async function withTransaction(operation) {
  const client = await getDatabase().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function closeDatabase() {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  embeddedDatabase = undefined;
  await currentPool.end();
}

module.exports = {
  closeDatabase,
  getDatabase,
  initializeDatabase,
  withTransaction
};