# DHL GOLD Express Backend

Node.js 18+ and Express API. PostgreSQL is the production source of truth for shipment records and history. The browser communicates only with this API; `DATABASE_URL` remains backend-only.

## Access model

The Admin Dashboard does not require authentication. It is intentionally accessible without a login. There is no login, logout, session, cookie authentication, or CSRF token flow.

The Dashboard is the only shipment-management interface; no separate database-admin dashboard is required. Its management API routes are also intentionally unauthenticated. Anyone who can reach the API can list shipments, see shipment names/routes/status/history, update shipments, and archive delivered shipments. The Admin Dashboard is therefore not private, and CORS is not an access-control boundary. Do not treat HTTPS or the frontend origin allowlist as authentication.

## Routes

- `GET /`
- `GET /health`
- `POST /create-shipment` — public, limited to 10 requests per 15 minutes per client IP.
- `GET /track/:trackingNumber` — public, limited to 120 requests per 15 minutes per client IP. Returns tracking information and history without customer email or internal database fields.
- `GET /shipments` — unauthenticated Admin Dashboard listing; customer email and internal fields are omitted.
- `PUT /update-status/:trackingNumber` — unauthenticated status/location update; appends a history event.
- `DELETE /shipments/:trackingNumber` — unauthenticated archive action; archives delivered shipments without deleting shipment or history records.

The public rate limits use the existing in-process rate limiter and return HTTP 429 when exceeded. The management routes have no authentication by owner requirement.

## Storage architecture

Production storage is PostgreSQL reached only by the Express backend through the server-side `DATABASE_URL`. The frontend must never receive the database URL or connect directly to PostgreSQL. PGlite is used only by automated tests.

Startup initializes the shipment tables and history index. It does not create authentication tables or require administrator credentials. If legacy `admin_users`, `admin_sessions`, or `app_settings` tables already exist in a database, the application no longer reads or writes them and does not drop them.

- `shipments` stores the tracking number, shipment/customer fields, status/location, timestamps, archive marker, and preserved legacy fields.
- `shipment_history` stores every creation and update event, including status, location, message, event type, actor label, time, vessel/voyage, and preserved legacy event fields. A restrictive foreign key prevents shipment deletion from cascading to history.

Shipment creation and each status/location update write shipment state and its history event transactionally. History is returned in chronological order. Archiving marks a delivered shipment and retains its record/history; archived shipments remain in the dashboard list and are no longer publicly trackable or editable.

## Legacy JSON import

There is no automatic production import. Back up and review the source JSON first, then set `DATABASE_URL` to the intended destination and run:

```sh
npm run migrate:file -- "path/to/data.json"
```

The shipment import is transactional and idempotent by tracking number. Existing records are skipped, never replaced. It imports shipment data only; administrator-account files are no longer used. Never run a migration with a production URL unless intentionally performing an approved migration.

## Environment variables

- `DATABASE_URL` (required): PostgreSQL connection URL, kept only in the backend/Render environment.
- `FRONTEND_ORIGIN` (required in production for browser API access): exact public frontend origin, including scheme but no path or trailing slash. This configures CORS only; it does not restrict non-browser clients or authenticate management requests.
- `NODE_ENV=production` (Render): enables production configuration validation.
- `PORT` (optional): supplied by Render in production.

There is no requirement for `DATA_DIR`, `ADMIN_SETUP_TOKEN`, admin passwords, session secrets, or a persistent Render disk. Startup fails if `DATABASE_URL` is missing or invalid; production shipment persistence is PostgreSQL.

## Local development and deployment

Automated integration tests use PGlite in a temporary OS directory and do not use Neon, a production API, or an external database:

```sh
npm ci
npm test
```

For manual development, provide a disposable PostgreSQL-compatible `DATABASE_URL` and a local `FRONTEND_ORIGIN`, then run `npm start`. Render should provide `PORT` and configure `DATABASE_URL`, `FRONTEND_ORIGIN`, and `NODE_ENV=production`. Do not deploy until PostgreSQL is configured in the backend environment.

Serve the Admin Dashboard from a real HTTPS frontend origin before final production verification. HTTPS protects data in transit but does not make the unauthenticated dashboard private or prevent unauthorized management operations.
