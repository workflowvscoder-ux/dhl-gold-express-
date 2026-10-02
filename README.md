# DHL GOLD Express Backend

Node.js 18+ and Express backend with local administrator authentication. No paid identity service or API key is used for ongoing admin access.

## First Administrator

Set `ADMIN_SETUP_TOKEN` to a random value of at least 32 bytes before the first deployment. This one-time bootstrap token protects the public setup endpoint; it is not used to log in or authorize later requests. After creating the administrator, remove `ADMIN_SETUP_TOKEN` from the service environment. The account file prevents setup from being reused.

Generate a token locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`; keep it private and enter it only in the service environment and first-setup request.

Check whether setup is available:

```http
GET /auth/setup/status
```

Create the first account once:

```http
POST /auth/setup
Content-Type: application/json

{"setupToken":"<one-time-token>","username":"<admin-username>","password":"<password-at-least-12-characters>"}
```

Usernames are 3-32 letters, digits, dots, underscores, or hyphens. Passwords must be at least 12 characters and at most 72 UTF-8 bytes. Passwords are stored as bcrypt hashes. Setup returns `409` after the first account is created.

## Login And Frontend Requests

Login endpoint: `POST /auth/login`.

```js
const login = await fetch(`${apiBase}/auth/login`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
}).then((response) => response.json());

const csrfToken = login.csrfToken;
```

Use `credentials: 'include'` on every request. Keep the returned CSRF token in memory and send it as `X-CSRF-Token` on `POST`, `PUT`, and `DELETE` requests. Call `GET /auth/me` on dashboard load to restore the login state and get a fresh copy of the CSRF token. Call `POST /auth/logout` with the CSRF header to invalidate the session.

Admin-only routes:

- `GET /shipments`
- `POST /create-shipment`
- `PUT /update-status/:trackingNumber`
- `DELETE /shipments/:trackingNumber`

Public routes include `GET /track/:trackingNumber` and `GET /health`. Public clients should use the tracking-number endpoint rather than fetching the full admin shipment list.

In production, the session cookie is `HttpOnly`, `Secure`, and `SameSite=None`. CSRF tokens are session-bound. Login and initial setup have separate rate limits. Configure `FRONTEND_ORIGIN` to the exact frontend origin (or a comma-separated list of origins) so credentialed browser requests are accepted.

## Deployment And Storage

The Render blueprint mounts a persistent disk at `/var/data` and sets `DATA_DIR` there. Keep that disk attached and run one backend instance: shipment data, the hashed admin account, the generated session-signing key, and encrypted session files are stored in that directory. Losing the disk loses the local admin account and invalidates sessions; it does not expose a default password or generate a default account.

On Render, configure:

- `FRONTEND_ORIGIN`: the deployed frontend origin, with no path.
- `ADMIN_SETUP_TOKEN`: a securely generated one-time value of at least 32 bytes; remove it after setup.
- Keep the existing persistent disk and `DATA_DIR=/var/data` settings.

No `ADMIN_API_KEY` or session-secret environment variable is required. Session signing/encryption material is generated automatically and stored on the persistent disk.

## Local Checks

```sh
npm ci
npm test
npm start
```

The integration test uses a temporary data directory and does not modify the project's shipment records. The login URL is the `POST /auth/login` API endpoint; the responsive login page and dashboard are maintained in the separate frontend project.