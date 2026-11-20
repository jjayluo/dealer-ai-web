# Dealer AI backend

This branch contains two independent backend implementations. They use different databases, authentication models and entry points; do not run both on the same port.

| Implementation | Entry point | Data store | Purpose |
| --- | --- | --- | --- |
| Local full-stack app | `server.mjs` | SQLite | Product UI at `/app/`: inventory, customers, leads and users; JWT auth, role scopes, invitations, audit history and API tests. See [README.local.md](README.local.md). |
| PostgreSQL starter | `server.js` | PostgreSQL | Earlier inventory/customers/leads integration starter with a shared staff bearer token. Kept unchanged. See [README.postgres.md](README.postgres.md). |

Quick start for the local full-stack app, from the repository root:

```sh
DEALER_ADMIN_EMAIL='owner@your-dealership.com' \
DEALER_ADMIN_PASSWORD='replace-with-a-strong-password' \
node backend/server.mjs
```

The service starts at <http://localhost:3000/app/>. After the first run, the admin environment variables are no longer required.

From `backend/`, `npm run start:app` runs the local full-stack app, `npm start` runs the PostgreSQL starter, and `npm test` runs the local API tests. The PostgreSQL starter's setup, migration, seed and deployment notes remain in [README.postgres.md](README.postgres.md).
