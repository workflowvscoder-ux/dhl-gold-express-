# DHL GOLD Express Backend

Node.js 18+ and Express API. Shipment creation and tracking are public. Shipment listing and all shipment administration require the existing administrator session; status updates and deletion also require a CSRF token.

## Public Routes

These routes do not require an administrator session:

- `GET /`
- `GET /health`
- `GET /track/:trackingNumber`
- `POST /create-shipment`

## Administrator Routes

- `GET /shipments`
- `PUT /update-status/:trackingNumber`
- `DELETE /shipments/:trackingNumber` (only delivered shipments)

All administrator routes require a logged-in administrator session. `PUT /update-status/:trackingNumber` and `DELETE /shipments/:trackingNumber` additionally require the session's CSRF token in the `X-CSRF-Token` header. Deletion is limited to delivered shipments.

## Administrator Authentication

- `GET /auth/setup/status`
- `POST /auth/setup`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`

The first administrator account is created through `/auth/setup` using the configured one-time `ADMIN_SETUP_TOKEN`. Keep that token secret. The dashboard signs in through `/auth/login`, uses the resulting session cookie, and sends the CSRF token on state-changing administrator requests.

## Frontend And CORS

The static frontend uses `https://dhl-gold-express.onrender.com` as its API base URL. Configure `FRONTEND_ORIGIN` in Render to the exact website origin, for example `https://<distribution-id>.cloudfront.net`, with no trailing slash. The backend enables credentialed CORS for this origin so the administrator session cookie can be used. CORS is not a substitute for session or CSRF authorization.

Public tracking clients should call `GET /track/:trackingNumber`; do not retrieve the full shipment list just to track one shipment.

## Storage

Render sets `DATA_DIR=/var/data` and mounts the existing persistent disk there. Shipment records remain in `data.json`; do not detach or replace that disk. The server also stores the administrator account, sessions, and session secret in the same directory. Shipment data writes use atomic file replacement; successful create/update/delete responses are sent only after the write completes. No frontend deployment step changes or migrates storage.

## Local Checks

```sh
npm ci
npm test
npm start
```

The integration test uses a temporary data directory and does not alter the configured shipment store.