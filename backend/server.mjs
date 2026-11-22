import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, extname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { Store, ApiError, schemas } from './domain.mjs';
import { Auth } from './auth.mjs';
import { seed } from './seed.mjs';
import { listRecords } from './query.mjs';
import { buildVehicleFacts, generateReply } from './ai.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
async function body(req, max = 65536) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Request exceeds ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
  const bytes = await body(req);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'Malformed JSON'); }
}
async function photoBody(req) {
  const contentType = req.headers['content-type'] || '';
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/i.exec(contentType);
  if (!match) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data with a file field');
  const boundary = match[1] || match[2];
  if (boundary.length > 200) throw new ApiError(400, 'INVALID_MULTIPART', 'Invalid boundary');
  const bytes = await body(req, 10 * 1024 * 1024 + 4096);
  const marker = Buffer.from(`--${boundary}`);
  if (!bytes.subarray(0, marker.length).equals(marker)) throw new ApiError(400, 'INVALID_MULTIPART', 'Invalid multipart body');
  let position = marker.length; let file;
  while (bytes.subarray(position, position + 2).toString() !== '--') {
    if (bytes.subarray(position, position + 2).toString() !== '\r\n') throw new ApiError(400, 'INVALID_MULTIPART', 'Invalid multipart separator');
    const headerEnd = bytes.indexOf('\r\n\r\n', position);
    if (headerEnd < 0 || headerEnd - position > 4096) throw new ApiError(400, 'INVALID_MULTIPART', 'Invalid multipart headers');
    const header = bytes.subarray(position + 2, headerEnd).toString('utf8');
    const end = bytes.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4);
    if (end < 0) throw new ApiError(400, 'INVALID_MULTIPART', 'Unterminated multipart body');
    if (/content-disposition: form-data;[^\r\n]*\bname="file"/i.test(header)) {
      if (file) throw new ApiError(422, 'VALIDATION_ERROR', 'Upload one file at a time');
      file = { bytes: bytes.subarray(headerEnd + 4, end), mime: /content-type:\s*([^\r\n]+)/i.exec(header)?.[1].toLowerCase() };
    }
    position = end + 2 + marker.length;
  }
  if (!file || file.bytes.length > 10 * 1024 * 1024) throw new ApiError(422, 'VALIDATION_ERROR', 'A file of at most 10 MB is required');
  return file;
}
function version(req) {
  const value = req.headers['if-match'];
  if (!value) throw new ApiError(428, 'VERSION_REQUIRED', 'Send the current version in If-Match');
  if (!/^"?[1-9]\d*"?$/.test(value)) throw new ApiError(400, 'INVALID_VERSION', 'Invalid If-Match version');
  return Number(value.replaceAll('"', ''));
}
function inventoryWrite(actor) {
  if (!['owner', 'manager'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Inventory changes require manager access');
}

export function createApp({ store = new Store(), secret, aiReply = generateReply } = {}) {
  const auth = new Auth(store, secret);
  const aiAttempts = new Map();
  const server = createServer(async (req, res) => {
    const request_id = randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, data, meta = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(status === 204 ? undefined : JSON.stringify({ data, meta: { request_id, ...meta } }));
    };
    try {
      const appOrigin = process.env.APP_ORIGIN || 'http://localhost:3000';
      const allowedUrl = new URL(appOrigin);
      if (req.headers.host !== allowedUrl.host) throw new ApiError(403, 'INVALID_HOST', 'Host is not allowed');
      if (req.headers.origin && req.headers.origin !== allowedUrl.origin) throw new ApiError(403, 'INVALID_ORIGIN', 'Cross-origin access is disabled');
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET');
        if (path === '/') { res.writeHead(302, { Location: '/app/' }); res.end(); return; }
        let file;
        if (path === '/app/' || path === '/app') file = resolve(directory, 'public/index.html');
        else if (['/app/app.js', '/app/app.css'].includes(path)) file = resolve(directory, 'public', basename(path));
        else if (path === '/css/style.css') file = resolve(root, 'css/style.css');
        if (!file) throw new ApiError(404, 'NOT_FOUND', 'Page not found');
        let bytes;
        try { bytes = await readFile(file); } catch { throw new ApiError(404, 'NOT_FOUND', 'Page not found'); }
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': types[extname(file)] }); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (path === '/api/v1/auth/login' && req.method === 'POST') { send(200, auth.login(await jsonBody(req), req.socket.remoteAddress)); return; }
      if (path === '/api/v1/auth/accept-invitation' && req.method === 'POST') { send(200, auth.issueToken(store.acceptInvitation(await jsonBody(req)))); return; }
      const actor = auth.authenticate(req.headers.authorization);
      if (!['GET', 'HEAD'].includes(req.method) && !['owner', 'manager', 'sales', 'bdc'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Read-only account');
      if (path === '/api/v1/me' && req.method === 'GET') { send(200, actor); return; }
      if (path === '/api/v1/users' && req.method === 'GET') {
        store.requireManager(actor);
        const result = store.listUsers(actor, url.searchParams);
        send(200, result.data, { ...result.pagination, ...(result.counts ? { counts: result.counts } : {}) });
        return;
      }
      if (path === '/api/v1/users/invitations') {
        if (req.method === 'GET') { send(200, store.listInvitations(actor)); return; }
        if (req.method === 'POST') { send(201, store.createInvitation(await jsonBody(req), actor)); return; }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
      }
      const invitationMatch = /^\/api\/v1\/users\/invitations\/([a-zA-Z0-9-]+)$/.exec(path);
      if (invitationMatch) {
        if (req.method === 'DELETE') { store.revokeInvitation(invitationMatch[1], actor); send(204); return; }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
      }
      const userMatch = /^\/api\/v1\/users\/([a-zA-Z0-9-]+)$/.exec(path);
      if (userMatch) {
        if (req.method === 'GET') { send(200, store.getUser(userMatch[1], actor)); return; }
        if (req.method === 'PATCH') { send(200, store.updateUser(userMatch[1], await jsonBody(req), actor)); return; }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
      }
      if (path === '/api/v1/summary' && req.method === 'GET') {
        const counts = {};
        for (const kind of Object.keys(schemas)) {
          const rows = store.all(kind, actor);
          counts[kind] = { total: rows.length, by_status: {} };
          for (const row of rows) counts[kind].by_status[row.status] = (counts[kind].by_status[row.status] || 0) + 1;
        }
        send(200, counts); return;
      }
      if (path === '/api/v1/conversations' && req.method === 'GET') {
        const result = store.listConversations(actor, url.searchParams);
        send(200, result.data, { ...result.pagination, counts: result.counts });
        return;
      }
      if (path === '/api/v1/conversations' && req.method === 'POST') {
        send(201, store.createConversation(await jsonBody(req), actor));
        return;
      }
      const messageMatch = /^\/api\/v1\/conversations\/([a-zA-Z0-9-]+)\/messages$/.exec(path);
      if (messageMatch) {
        if (req.method === 'POST') {
          const result = store.addMessage(messageMatch[1], await jsonBody(req), actor, req.headers['idempotency-key']);
          send(result.replayed ? 200 : 201, result.message, { conversation_version: result.conversation_version, replayed: result.replayed });
          return;
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
      }
      const suggestionMatch = /^\/api\/v1\/conversations\/([a-zA-Z0-9-]+)\/ai-suggestion$/.exec(path);
      if (suggestionMatch) {
        if (req.method === 'POST') {
          const input = await jsonBody(req);
          if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError(422, 'VALIDATION_ERROR', 'Expected a JSON object');
          for (const key of Object.keys(input)) if (!['tone', 'objective', 'language'].includes(key)) throw new ApiError(422, 'VALIDATION_ERROR', `Unknown field: ${key}`, { [key]: 'Unknown field' });
          for (const key of ['tone', 'objective', 'language']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 50)) throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${key}`, { [key]: 'Use a string of at most 50 characters' });
          const now = Date.now();
          const limit = aiAttempts.get(actor.id) || { count: 0, until: now + 60000 };
          if (limit.until <= now) { limit.count = 0; limit.until = now + 60000; }
          limit.count += 1;
          aiAttempts.set(actor.id, limit);
          if (limit.count > 20) throw new ApiError(429, 'RATE_LIMITED', 'Too many AI suggestions. Try again in a minute.');
          const context = store.aiContext(suggestionMatch[1], actor);
          const result = await aiReply({
            vehicleFacts: buildVehicleFacts(context.vehicle),
            question: context.question.body,
            language: typeof input.language === 'string' ? input.language : context.conversation.reply_language,
            tone: typeof input.tone === 'string' ? input.tone : 'friendly',
            objective: typeof input.objective === 'string' ? input.objective : 'answer_question',
          });
          store.audit('conversations', suggestionMatch[1], actor, 'ai_suggestion_generated', { provider: result.provider, model: result.model, message_id: context.question.id, vehicle_id: context.vehicle.id });
          send(200, { ...result, question: context.question.body, vehicle_id: context.vehicle.id, generated_at: new Date().toISOString() });
          return;
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
      }
      const conversationMatch = /^\/api\/v1\/conversations\/([a-zA-Z0-9-]+)$/.exec(path);
      if (conversationMatch) {
        if (req.method === 'GET') { send(200, store.getConversation(conversationMatch[1], actor)); return; }
        if (req.method === 'PATCH') { send(200, store.updateConversation(conversationMatch[1], await jsonBody(req), actor, version(req))); return; }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
      }
      const match = /^\/api\/v1\/(vehicles|customers|leads)(?:\/([a-zA-Z0-9-]+))?(?:\/(notes|activity|media)(?:\/([a-zA-Z0-9-]+))?)?$/.exec(path);
      if (!match) throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
      const [, kind, id, child, childId] = match;
      if (child === 'activity' && !childId && req.method === 'GET') { send(200, store.activity(kind, id, actor)); return; }
      if (kind === 'customers' && child === 'notes' && !childId) {
        if (req.method === 'GET') { send(200, store.notes(id, actor)); return; }
        if (req.method === 'POST') { send(201, store.addNote(id, await jsonBody(req), actor)); return; }
      }
      if (kind === 'vehicles' && child === 'media') {
        if (!childId && req.method === 'GET') { send(200, store.media(id, actor)); return; }
        if (!childId && req.method === 'POST') { inventoryWrite(actor); const file = await photoBody(req); send(201, store.addMedia(id, file.bytes, file.mime, actor)); return; }
        if (childId) {
          store.get('vehicles', id, actor);
          if (req.method === 'DELETE') inventoryWrite(actor);
          const media = store.db.prepare('SELECT * FROM media WHERE id = ? AND vehicle_id = ? AND organization_id = ?').get(childId, id, actor.organization_id);
          if (!media) throw new ApiError(404, 'NOT_FOUND', 'Photo not found');
          if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': media.mime }); res.end(Buffer.from(media.content)); return; }
          if (req.method === 'DELETE') {
            store.transaction(() => { store.db.prepare('DELETE FROM media WHERE id = ? AND organization_id = ?').run(childId, actor.organization_id); store.audit(kind, id, actor, 'photo_deleted', { media_id: childId }); });
            send(204); return;
          }
        }
      }
      if (!child) {
        if (req.method === 'GET' && !id) { const result = listRecords(store, kind, url.searchParams, actor); send(200, result.data, result.pagination); return; }
        if (req.method === 'GET' && id) {
          const record = store.project(kind, store.get(kind, id, actor), actor);
          for (const [field, target, name] of [['customer_id', 'customers', 'customer'], ['vehicle_id', 'vehicles', 'vehicle'], ['interested_vehicle_id', 'vehicles', 'interested_vehicle']]) {
            if (record[field]) record[name] = store.project(target, store.get(target, record[field], actor, true, true), actor);
          }
          if (record.assigned_user_id) record.assigned_user = store.db.prepare('SELECT id, name FROM users WHERE id = ? AND organization_id = ?').get(record.assigned_user_id, actor.organization_id);
          if (kind === 'customers') { record.notes = store.notes(id, actor); record.lead_count = store.all('leads', actor).filter(l => l.customer_id === id).length; }
          if (kind === 'vehicles') record.media = store.media(id, actor);
          res.setHeader('ETag', `"${record.version}"`); send(200, record); return;
        }
        if ((req.method === 'POST' && !id) || (req.method === 'PATCH' && id)) {
          if (kind === 'vehicles') inventoryWrite(actor);
          const expected = id ? version(req) : undefined;
          const record = store.save(kind, await jsonBody(req), actor, id, expected);
          const warnings = kind === 'customers' ? store.duplicates(record, actor, record.id) : [];
          res.setHeader('ETag', `"${record.version}"`);
          send(id ? 200 : 201, store.project(kind, record, actor), warnings.length ? { duplicate_candidates: warnings } : {}); return;
        }
        if (req.method === 'DELETE' && id) { store.archive(kind, id, actor, version(req)); send(204); return; }
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not supported for this endpoint');
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error(`[${request_id}]`, error);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: error.code && error.status ? error.code : 'INTERNAL_ERROR', message: error.status ? error.message : 'Unexpected server error', field_errors: error.field_errors || {}, request_id } }));
      } else res.end();
    }
  });
  return { server, store, auth };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // SQLite locking is unreliable over the Windows-to-WSL UNC share. Keep this
  // development database on the host's local disk when Node runs on Windows.
  const defaultDatabase = process.platform === 'win32' && directory.startsWith('\\\\')
    ? resolve(homedir(), 'AppData', 'Local', 'Temp', 'dealer-ai-web', createHash('sha256').update(root).digest('hex').slice(0, 12), 'dealer.sqlite')
    : resolve(directory, 'data/dealer.sqlite');
  const databasePath = process.env.DEALER_DB_PATH || defaultDatabase;
  const store = new Store(databasePath);
  const email = process.env.DEALER_ADMIN_EMAIL;
  const password = process.env.DEALER_ADMIN_PASSWORD;
  const initialized = seed(store, { email, password });
  if (initialized === 'unconfigured') {
    console.error('First run requires DEALER_ADMIN_EMAIL and DEALER_ADMIN_PASSWORD (at least 10 characters).');
    store.close();
    process.exitCode = 1;
  } else {
    const { server } = createApp({ store, secret: process.env.DEALER_JWT_SECRET });
    const port = Number(process.env.PORT || 3000);
    server.listen(port, '0.0.0.0', () => {
      console.log(`DealerAI: http://localhost:${port}/app/`);
      console.log(`Database: ${databasePath}`);
      if (initialized) console.log(`Owner account created: ${email}`);
    });
    server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(); }));
  }
}
