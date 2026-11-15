# Dealer AI backend starter

A Node.js 24 API for the Anstar demo. Inventory, customers, and leads are persisted in PostgreSQL. This PR does not integrate the existing frontend, implement user accounts, or call an AI model. Use fictional data only: the shared bearer token is for staff integration testing, not multi-user access control. Never embed it in frontend code.

## Local setup

Create a separate empty PostgreSQL database (e.g. `createdb dealer_ai`, if your local PostgreSQL role has permission). From the repository root:

```sh
cd backend
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Set DATABASE_URL and paste the generated token into .env as STAFF_API_TOKEN.
node --env-file=.env migrate.js
node --env-file=.env seed.js
node --env-file=.env server.js
```

Seed data contains 10 fictional vehicles (DA-001–DA-010); it does not overwrite existing rows. Unknown history or inspection fields are null. The asking price is in integer USD cents; mileage is in miles.

## API

| Resource | List / create | Read / update |
|---|---|---|
| Inventory | GET /api/inventory; POST /api/inventory | GET /api/inventory/:id; PATCH /api/inventory/:id |
| Customers | GET /api/customers; POST /api/customers | GET /api/customers/:id; PATCH /api/customers/:id |
| Leads | GET /api/leads; POST /api/leads | GET /api/leads/:id; PATCH /api/leads/:id |

Lists return `{items, limit, offset}`; default limit 50, maximum 100. PATCH takes just the changed fields. Use `Authorization: Bearer <STAFF_API_TOKEN>` on every API request. Writes require `Content-Type: application/json`.

- Inventory create: stock_number, year, make, model, mileage, asking_price_cents, availability (available, pending, sold, unknown). Optional: availability_verified_at, history_summary, inspection_notes.
- Customer create: name; optional email and phone.
- Lead create: customer_id and inquiry; optional vehicle_id and status (new, contacted, qualified, closed).
- GET /health checks database connectivity and returns 200 or 503 without disclosing connection details.

Example customer payload: `{"name":"Demo Buyer","email":"demo@example.com"}`. Then create a lead with that returned ID: `{"customer_id":1,"vehicle_id":1,"inquiry":"Can I see the Camry this Saturday?"}` (replace example IDs with actual IDs).

## Render

Create a dedicated PostgreSQL instance and native Node Web Service in the same region/account. Do not point this at Partaka's database.

| Setting | Value |
|---|---|
| Root Directory | backend |
| Build Command | npm ci |
| Pre-Deploy Command | npm run migrate (where supported) |
| Start Command | npm start |
| Health Check Path | /health |
| Environment | DATABASE_URL (internal connection string), STAFF_API_TOKEN (unique random secret) |

If pre-deploy is unavailable, use `npm run migrate && npm start` as the Start Command for this single-service demo. The server binds to `0.0.0.0` and reads Render's PORT automatically. Seed separately, on a dedicated demo database only. For local migration or seed against Render, use its external connection string if authorized; do not commit or share it. See [Render deploy docs](https://render.com/docs/deploys).

## First PR

Unzip into a temporary folder, review any existing backend files before copying, then from the Dealer AI repo create a branch, copy the backend contents, and run:

```sh
git add backend/
git diff --cached
git commit -m "Add Dealer AI PostgreSQL API starter"
git push -u origin HEAD
```

Open a PR into main. Do not commit .env or node_modules. Next PR: staff login and frontend integration, then inventory-backed reply drafting with staff review.
