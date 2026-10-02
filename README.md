# DHL GOLD Express Backend

Node.js 18+ and Express API. Shipment management endpoints are intentionally public in this deployment; no administrator login, API key, or CSRF token is required for them.

## Routes

Public health/tracking routes:

- `GET /`
- `GET /health`
- `GET /track/:trackingNumber`

Public shipment-management routes:

- `GET /shipments`
- `POST /create-shipment`
- `PUT /update-status/:trackingNumber`
- `DELETE /shipments/:trackingNumber` (only delivered shipments)

The management routes do not require an administrator session or CSRF header. **Anyone who can reach the API can read shipment/customer details, create shipments, change tracking status/history, and permanently delete delivered records.** CORS only limits browser origins; it does not prevent direct HTTP clients from calling these routes. Do not use this configuration for real customer data unless public mutation and disclosure are explicitly acceptable.

The older local authentication endpoints remain available but are not used to authorize dashboard routes:

- `GET /auth/setup/status`
- `POST /auth/setup`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`

Administrator setup is not needed to open or use the dashboard while management routes remain public.

## Frontend And CORS

The static frontend uses `https://dhl-gold-express.onrender.com` as its API base URL. Configure `FRONTEND_ORIGIN` in Render to the exact website origin, for example `https://<distribution-id>.cloudfront.net`, with no trailing slash. This controls browser CORS only and does not secure public management routes.

Public tracking clients should call `GET /track/:trackingNumber`; do not retrieve the full shipment list just to track one shipment.

## Storage

Render sets `DATA_DIR=/var/data` and mounts the existing persistent disk there. Shipment records remain in `data.json`; do not detach or replace that disk. The server also stores local authentication account/session files in the same directory for the unused auth endpoints. No frontend deployment step changes or migrates storage.

## Local Checks

```sh
npm ci
npm test
npm start
```

The integration test uses a temporary data directory and does not alter the configured shipment store.