import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { passwordHash } from './passwords.mjs';

export const ROLES = ['owner', 'manager', 'sales', 'bdc'];
export const USER_STATUSES = ['invited', 'active', 'disabled'];
const roleRank = { owner: 3, manager: 2, sales: 1, bdc: 1 };
const managerRoles = ['owner', 'manager'];

export class ApiError extends Error {
  constructor(status, code, message, field_errors = {}) {
    super(message); Object.assign(this, { status, code, field_errors });
  }
}
const fail = (field, message) => { throw new ApiError(422, 'VALIDATION_ERROR', message, { [field]: message }); };
const enumRule = (...values) => ({ type: 'string', values });
const string = { type: 'string', max: 200 };
const text = { type: 'string', max: 10000 };
const money = { type: 'number', min: 0, max: 9999999999.99, money: true };
const reference = { type: 'string', nullable: true, max: 36 };
function integerParam(params, name, fallback, max) {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || +value < 1 || +value > max) throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${name}`, { [name]: `Use an integer between 1 and ${max}` });
  return +value;
}
export const schemas = {
  vehicles: {
    stock_number: { ...string, required: true, max: 40 }, vin: { ...string, nullable: true },
    year: { type: 'number', integer: true, min: 1900, max: new Date().getUTCFullYear() + 2, required: true },
    make: { ...string, required: true }, model: { ...string, required: true }, trim: string,
    status: { ...enumRule('draft', 'available', 'pending', 'reserved', 'in_transit', 'sold'), default: 'available' },
    body_type: string, body_style: string, exterior_color: string, interior_color: string,
    transmission: string, drivetrain: string, fuel_type: string,
    condition: { ...enumRule('new', 'used', 'certified'), default: 'used' },
    mileage: { type: 'number', integer: true, min: 0, max: 99999999, default: 0 },
    list_price: { ...money, required: true }, purchase_cost: { ...money, nullable: true }, minimum_price: { ...money, nullable: true },
    location: string, description: text, internal_notes: text, acquired_at: { ...string, nullable: true }, acquisition_source: string,
  },
  customers: {
    first_name: { ...string, required: true, max: 80 }, last_name: { ...string, max: 80 },
    phone: { ...string, max: 30 }, email: string, preferred_language: { ...string, default: 'en', max: 10 },
    lead_source: string,
    status: { ...enumRule('new', 'contacted', 'qualified', 'appointment', 'won', 'lost'), default: 'new' },
    assigned_user_id: reference, interested_vehicle_id: reference,
    do_not_contact: { type: 'boolean', default: false },
  },
  leads: {
    customer_id: { ...reference, required: true, nullable: false }, vehicle_id: reference,
    source: { ...string, required: true, max: 40 }, external_lead_id: { ...string, nullable: true, max: 120 },
    status: { ...enumRule('new', 'working', 'qualified', 'won', 'lost'), default: 'new' },
    priority: { ...enumRule('low', 'normal', 'high'), default: 'normal' }, assigned_user_id: reference,
    message: text, lost_reason: { ...string, nullable: true, max: 1000 }, reopen_reason: { ...string, nullable: true, max: 1000 },
  },
};

export function validate(kind, input, previous = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
  const schema = schemas[kind];
  for (const key of Object.keys(input)) if (!Object.hasOwn(schema, key)) fail(key, 'Unknown or read-only field');
  const data = {};
  for (const [key, rule] of Object.entries(schema)) {
    let value = Object.hasOwn(input, key) ? input[key] : previous[key] ?? rule.default;
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null) {
      if (rule.required) fail(key, 'Required field');
      if (value === null && !rule.nullable) fail(key, 'Null is not allowed');
      if (value !== undefined) data[key] = value;
      continue;
    }
    if (typeof value !== rule.type) fail(key, `Expected ${rule.type}`);
    if (rule.required && value === '') fail(key, 'Required field');
    if (rule.max && typeof value === 'string' && value.length > rule.max) fail(key, `Maximum ${rule.max} characters`);
    if (rule.values && !rule.values.includes(value)) fail(key, `Allowed: ${rule.values.join(', ')}`);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < rule.min || value > rule.max) fail(key, `Must be between ${rule.min} and ${rule.max}`);
      if (rule.integer && !Number.isInteger(value)) fail(key, 'Must be a whole number');
      if (rule.money && Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) fail(key, 'Use at most two decimal places');
    }
    data[key] = value;
  }
  if (kind === 'vehicles') {
    data.stock_number = data.stock_number.toUpperCase();
    if (data.vin) data.vin = data.vin.toUpperCase();
    if (data.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(data.vin)) fail('vin', 'VIN must have 17 characters, excluding I, O and Q');
    if (data.status !== 'draft' && !data.vin) fail('vin', 'VIN is required outside draft status');
    if (data.minimum_price != null && data.minimum_price > data.list_price) fail('minimum_price', 'Minimum price cannot exceed list price');
    if (data.acquired_at && (!/^\d{4}-\d{2}-\d{2}$/.test(data.acquired_at) || !Number.isFinite(Date.parse(data.acquired_at)) || new Date(data.acquired_at).toISOString().slice(0, 10) !== data.acquired_at)) fail('acquired_at', 'Use a valid YYYY-MM-DD date');
  }
  if (kind === 'customers') {
    if (data.email) { data.email = data.email.toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) fail('email', 'Invalid email address'); }
    if (data.phone) { data.phone = data.phone.replace(/[\s().-]/g, ''); if (!/^\+?\d{7,15}$/.test(data.phone)) fail('phone', 'Use 7–15 digits, optionally prefixed with +'); }
  }
  return data;
}

export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active', auth_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
        email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL,
        expires_at TEXT NOT NULL, accepted_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS invitations_pending ON invitations(organization_id, accepted_at, revoked_at, expires_at);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        author_user_id TEXT NOT NULL, note_text TEXT NOT NULL, is_pinned INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, kind TEXT NOT NULL,
        record_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, vehicle_id TEXT NOT NULL,
        content BLOB NOT NULL, mime TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    const userColumns = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
    for (const [name, definition] of [
      ['status', "TEXT NOT NULL DEFAULT 'active'"],
      ['auth_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['created_at', "TEXT NOT NULL DEFAULT ''"],
      ['updated_at', "TEXT NOT NULL DEFAULT ''"],
      ['last_login_at', 'TEXT'],
    ]) if (!userColumns.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    const migratedAt = new Date().toISOString();
    this.db.exec("UPDATE users SET status = CASE WHEN active = 1 THEN 'active' ELSE 'disabled' END WHERE status IS NULL OR status = ''");
    this.db.prepare("UPDATE users SET created_at = ? WHERE created_at = ''").run(migratedAt);
    this.db.prepare("UPDATE users SET updated_at = ? WHERE updated_at = ''").run(migratedAt);
    for (const kind of Object.keys(schemas)) this.db.exec(`CREATE TABLE IF NOT EXISTS ${kind} (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      version INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${kind}_tenant ON ${kind}(organization_id, archived_at, created_at);`);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS vehicle_stock ON vehicles(organization_id, json_extract(data, '$.stock_number'));
      CREATE UNIQUE INDEX IF NOT EXISTS vehicle_vin ON vehicles(organization_id, json_extract(data, '$.vin')) WHERE json_extract(data, '$.vin') IS NOT NULL AND json_extract(data, '$.vin') != '';
      CREATE UNIQUE INDEX IF NOT EXISTS lead_external ON leads(organization_id, json_extract(data, '$.source'), json_extract(data, '$.external_lead_id')) WHERE json_extract(data, '$.external_lead_id') IS NOT NULL AND json_extract(data, '$.external_lead_id') != '';
      CREATE INDEX IF NOT EXISTS customers_assigned ON customers(organization_id, json_extract(data, '$.assigned_user_id'));
      CREATE INDEX IF NOT EXISTS leads_assigned ON leads(organization_id, json_extract(data, '$.assigned_user_id'));
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  unpack(row) {
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Record not found');
    const { data, ...rest } = row; return { ...JSON.parse(data), ...rest };
  }
  scopeClause(kind, actor) {
    if (!['customers', 'leads'].includes(kind) || managerRoles.includes(actor.role)) return { sql: '', params: [] };
    if (actor.role === 'sales') return { sql: "AND json_extract(data, '$.assigned_user_id') = ?", params: [actor.id] };
    if (actor.role === 'bdc') return { sql: "AND (json_extract(data, '$.assigned_user_id') = ? OR json_extract(data, '$.assigned_user_id') IS NULL OR json_extract(data, '$.assigned_user_id') = '')", params: [actor.id] };
    return { sql: 'AND 0', params: [] };
  }
  get(kind, id, actor, includeArchived = false, allowOutOfScope = false) {
    const scope = allowOutOfScope ? { sql: '', params: [] } : this.scopeClause(kind, actor);
    return this.unpack(this.db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND organization_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ${scope.sql}`).get(id, actor.organization_id, ...scope.params));
  }
  all(kind, actor) {
    const scope = this.scopeClause(kind, actor);
    return this.db.prepare(`SELECT * FROM ${kind} WHERE organization_id = ? AND archived_at IS NULL ${scope.sql} ORDER BY created_at DESC, id`).all(actor.organization_id, ...scope.params).map(r => this.unpack(r));
  }
  project(kind, record, actor) {
    const result = { ...record };
    if (kind === 'vehicles' && !['owner', 'manager'].includes(actor.role)) {
      delete result.purchase_cost; delete result.minimum_price; delete result.internal_notes;
    }
    return result;
  }
  references(kind, data, actor, previous = {}) {
    if (kind === 'leads' && !previous.id && data.status !== 'new') fail('status', 'New leads must start at the new stage');
    for (const [key, type] of [['customer_id', 'customers'], ['vehicle_id', 'vehicles'], ['interested_vehicle_id', 'vehicles']]) {
      const reopening = kind === 'leads' && ['won', 'lost'].includes(previous.status) && !['won', 'lost'].includes(data.status);
      if (data[key] && (data[key] !== previous[key] || reopening)) {
        try { this.get(type, data[key], actor); } catch { fail(key, 'Related record is missing or unavailable'); }
      }
    }
    if (data.assigned_user_id && !this.db.prepare('SELECT id FROM users WHERE id = ? AND organization_id = ? AND active = 1').get(data.assigned_user_id, actor.organization_id)) fail('assigned_user_id', 'Choose an active user in this dealership');
    if (kind === 'vehicles' && previous.status === 'sold' && data.status !== 'sold') throw new ApiError(409, 'STATE_CONFLICT', 'Sold inventory cannot be reopened through an ordinary edit');
    if (kind === 'leads' && previous.status && previous.status !== data.status) {
      const transitions = { new: ['working', 'qualified', 'lost'], working: ['qualified', 'lost'], qualified: ['working', 'won', 'lost'], won: [], lost: ['working'] };
      if (!transitions[previous.status].includes(data.status)) throw new ApiError(409, 'STATE_CONFLICT', `Cannot move lead from ${previous.status} to ${data.status}`);
      if (previous.status === 'lost' && !['manager', 'owner'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Only a manager can reopen a lost lead');
      if (data.status === 'lost' && !data.lost_reason) fail('lost_reason', 'A reason is required when marking a lead lost');
      if (previous.status === 'lost' && !data.reopen_reason) fail('reopen_reason', 'A reason is required when reopening a lost lead');
    }
  }
  audit(kind, id, actor, action, changes) {
    this.db.prepare('INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), actor.organization_id, kind, id, actor.id, action, JSON.stringify(changes), new Date().toISOString());
  }
  save(kind, input, actor, id, expectedVersion) {
    if (kind === 'vehicles' && !managerRoles.includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Inventory changes require manager access');
    try {
      return this.transaction(() => {
        const previous = id ? this.get(kind, id, actor) : {};
        if (id && previous.version !== expectedVersion) throw new ApiError(409, 'STALE_VERSION', 'This record changed. Reload it before saving.');
        if (kind === 'vehicles' && !['owner', 'manager'].includes(actor.role) && ['purchase_cost', 'minimum_price', 'internal_notes'].some(k => Object.hasOwn(input, k))) throw new ApiError(403, 'FORBIDDEN', 'Financial fields require manager access');
        const data = validate(kind, input, previous);
        if (['customers', 'leads'].includes(kind) && !managerRoles.includes(actor.role)) {
          if (Object.hasOwn(input, 'assigned_user_id')) {
            if (!input.assigned_user_id || input.assigned_user_id !== actor.id) throw new ApiError(403, 'FORBIDDEN', 'You can only keep records assigned to yourself');
          } else if (!id) {
            data.assigned_user_id = actor.id;
          }
        }
        this.references(kind, data, actor, previous);
        const now = new Date().toISOString();
        if (kind === 'vehicles' && data.status === 'sold') data.sold_at = previous.sold_at || now;
        if (kind === 'leads') data.last_activity_at = now;
        if (id) this.db.prepare(`UPDATE ${kind} SET data = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?`).run(JSON.stringify(data), now, id, actor.organization_id);
        else {
          id = randomUUID();
          this.db.prepare(`INSERT INTO ${kind} (id, organization_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, actor.organization_id, JSON.stringify(data), now, now);
        }
        const changes = Object.fromEntries(Object.entries(data).filter(([key, value]) => previous[key] !== value).map(([key, value]) => [key, { before: previous[key] ?? null, after: value }]));
        this.audit(kind, id, actor, previous.id ? 'updated' : 'created', changes);
        return this.get(kind, id, actor);
      });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) throw new ApiError(409, 'DUPLICATE', kind === 'vehicles' ? 'VIN or stock number already exists, including archived vehicles' : 'This external lead already exists');
      throw error;
    }
  }
  archive(kind, id, actor, version) {
    if (!['owner', 'manager'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Archival requires manager access');
    return this.transaction(() => {
      const record = this.get(kind, id, actor);
      if (record.version !== version) throw new ApiError(409, 'STALE_VERSION', 'This record changed. Reload before archiving.');
      if (kind !== 'leads' && this.all('leads', actor).some(l => !['won', 'lost'].includes(l.status) && l[kind === 'customers' ? 'customer_id' : 'vehicle_id'] === id)) throw new ApiError(409, 'ACTIVE_LEADS', 'Close or reassign active leads before archiving this record');
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE ${kind} SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND organization_id = ?`).run(now, now, id, actor.organization_id);
      this.audit(kind, id, actor, 'archived', {});
    });
  }
  notes(id, actor) {
    this.get('customers', id, actor);
    return this.db.prepare(`SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.customer_id = ? AND n.organization_id = ? ORDER BY n.is_pinned DESC, n.created_at DESC, n.id`).all(id, actor.organization_id).map(n => ({ ...n, is_pinned: Boolean(n.is_pinned) }));
  }
  addNote(id, input, actor) {
    if (!input || Object.keys(input).some(k => !['note_text', 'is_pinned'].includes(k))) fail('body', 'Only note_text and is_pinned are accepted');
    if (typeof input.note_text !== 'string' || !input.note_text.trim() || input.note_text.length > 10000) fail('note_text', 'Enter a note of 1–10000 characters');
    if (input.is_pinned !== undefined && typeof input.is_pinned !== 'boolean') fail('is_pinned', 'Expected boolean');
    return this.transaction(() => {
      this.get('customers', id, actor);
      const note = { id: randomUUID(), organization_id: actor.organization_id, customer_id: id, author_user_id: actor.id, note_text: input.note_text.trim(), is_pinned: input.is_pinned ?? false, created_at: new Date().toISOString() };
      this.db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)').run(note.id, note.organization_id, id, actor.id, note.note_text, Number(note.is_pinned), note.created_at);
      this.audit('customers', id, actor, 'note_added', { note_id: note.id }); return note;
    });
  }
  activity(kind, id, actor) {
    this.get(kind, id, actor);
    return this.db.prepare('SELECT * FROM activity WHERE kind = ? AND record_id = ? AND organization_id = ? ORDER BY created_at DESC, rowid DESC').all(kind, id, actor.organization_id).map(r => ({ ...r, changes: this.project(kind, JSON.parse(r.changes), actor) }));
  }
  duplicates(data, actor, excludeId) {
    return this.all('customers', actor).filter(c => c.id !== excludeId && ((data.email && c.email === data.email) || (data.phone && c.phone === data.phone))).map(c => ({ id: c.id, first_name: c.first_name, last_name: c.last_name }));
  }
  media(id, actor) {
    this.get('vehicles', id, actor);
    return this.db.prepare('SELECT id, mime, created_at FROM media WHERE vehicle_id = ? AND organization_id = ? ORDER BY created_at, id').all(id, actor.organization_id).map(m => ({ ...m, url: `/api/v1/vehicles/${id}/media/${m.id}` }));
  }
  addMedia(id, bytes, mime, actor) {
    if (!managerRoles.includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Inventory changes require manager access');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!((mime === 'image/png' && png) || (mime === 'image/jpeg' && jpg))) fail('file', 'Choose a PNG or JPEG image');
    return this.transaction(() => {
      if (this.media(id, actor).length >= 10) fail('file', 'A vehicle can have at most 10 images');
      const mediaId = randomUUID();
      this.db.prepare('INSERT INTO media VALUES (?, ?, ?, ?, ?, ?)').run(mediaId, actor.organization_id, id, bytes, mime, new Date().toISOString());
      this.audit('vehicles', id, actor, 'photo_added', { media_id: mediaId });
      return { id: mediaId, url: `/api/v1/vehicles/${id}/media/${mediaId}` };
    });
  }
  requireManager(actor) {
    if (!managerRoles.includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Manager access required');
  }
  userView(user, actor) {
    const { password_hash, auth_version, active, ...rest } = user;
    return { ...rest, active: Boolean(active), is_self: user.id === actor.id };
  }
  listUsers(actor, params = new URLSearchParams()) {
    const manager = managerRoles.includes(actor.role);
    const page = integerParam(params, 'page', 1, 1000000);
    const page_size = integerParam(params, 'page_size', manager ? 20 : 100, 100);
    let rows = this.db.prepare('SELECT * FROM users WHERE organization_id = ? ORDER BY name, email').all(actor.organization_id);
    const allUsers = rows;
    if (!manager) {
      rows = rows.filter(user => user.status === 'active' && user.active);
      const total = rows.length;
      return { data: rows.slice((page - 1) * page_size, page * page_size).map(user => ({ id: user.id, name: user.name, role: user.role })), pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) } };
    }
    const status = params.get('status');
    if (status) {
      if (!USER_STATUSES.includes(status)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid status', { status: `Allowed: ${USER_STATUSES.join(', ')}` });
      rows = rows.filter(user => user.status === status);
    }
    const role = params.get('role');
    if (role) {
      if (!ROLES.includes(role)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid role', { role: `Allowed: ${ROLES.join(', ')}` });
      rows = rows.filter(user => user.role === role);
    }
    const q = params.get('q')?.trim().toLowerCase();
    if (q) rows = rows.filter(user => user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q));
    const total = rows.length;
    const counts = { total: allUsers.length, by_status: Object.fromEntries(USER_STATUSES.map(value => [value, allUsers.filter(user => user.status === value).length])) };
    const invitations = this.db.prepare('SELECT id, user_id, expires_at FROM invitations WHERE organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').all(actor.organization_id);
    const pending = new Map(invitations.map(invitation => [invitation.user_id, invitation]));
    return {
      data: rows.slice((page - 1) * page_size, page * page_size).map(user => {
        const view = this.userView(user, actor);
        if (user.status === 'invited' && pending.has(user.id)) {
          const invitation = pending.get(user.id);
          view.invitation = { id: invitation.id, expires_at: invitation.expires_at };
        }
        return view;
      }),
      pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) },
      counts,
    };
  }
  getUser(id, actor) {
    this.requireManager(actor);
    const user = this.db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(id, actor.organization_id);
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    const view = this.userView(user, actor);
    if (user.status === 'invited') {
      const invitation = this.db.prepare('SELECT id, expires_at FROM invitations WHERE user_id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').get(id, actor.organization_id);
      if (invitation) view.invitation = invitation;
    }
    return view;
  }
  listInvitations(actor) {
    this.requireManager(actor);
    return this.db.prepare(`SELECT i.id, i.email, i.role, i.user_id, i.expires_at, i.created_at
      FROM invitations i JOIN users u ON u.id = i.user_id
      WHERE i.organization_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND u.status = 'invited'
      ORDER BY i.created_at DESC`).all(actor.organization_id, new Date().toISOString());
  }
  createInvitation(input, actor) {
    this.requireManager(actor);
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['email', 'name', 'role', 'role_ids'].includes(key)) fail(key, 'Unknown field');
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('email', 'Invalid email address');
    let role = input.role;
    if (input.role_ids !== undefined) {
      if (!Array.isArray(input.role_ids) || input.role_ids.length !== 1) fail('role_ids', 'This local version supports exactly one role per user');
      if (role !== undefined && role !== input.role_ids[0]) fail('role_ids', 'role and role_ids disagree');
      role = input.role_ids[0];
    }
    if (!ROLES.includes(role)) fail('role', `Allowed: ${ROLES.join(', ')}`);
    if (roleRank[role] > roleRank[actor.role]) throw new ApiError(403, 'FORBIDDEN', 'Managers cannot grant a role above their own');
    let name;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) fail('name', 'Enter a name of 1–200 characters');
      name = input.name.trim();
    }
    const existing = this.db.prepare('SELECT id, organization_id, status FROM users WHERE email = ?').get(email);
    if (existing) {
      if (existing.organization_id === actor.organization_id && existing.status === 'invited') throw new ApiError(409, 'INVITATION_PENDING', 'This email already has a pending invitation');
      throw new ApiError(409, 'EMAIL_EXISTS', 'A user with this email already exists');
    }
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    try {
      return this.transaction(() => {
        const id = randomUUID();
        const userId = randomUUID();
        const displayName = name || email.split('@')[0];
        this.db.prepare(`INSERT INTO users (id, organization_id, email, name, role, password_hash, active, status, auth_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'invited', 0, ?, ?)`).run(userId, actor.organization_id, email, displayName, role, `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`, now.toISOString(), now.toISOString());
        this.db.prepare('INSERT INTO invitations (id, organization_id, user_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, actor.organization_id, userId, email, role, createHash('sha256').update(token).digest('hex'), actor.id, expires.toISOString(), now.toISOString());
        this.audit('users', userId, actor, 'user_invited', { email, role });
        return { id, user_id: userId, email, name: displayName, role, status: 'invited', expires_at: expires.toISOString(), token, accept_path: '/api/v1/auth/accept-invitation' };
      });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) throw new ApiError(409, 'EMAIL_EXISTS', 'A user with this email already exists');
      throw error;
    }
  }
  acceptInvitation(input) {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['token', 'name', 'password'].includes(key)) fail(key, 'Unknown field');
    if (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 200) fail('token', 'Invalid invitation token');
    if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 200) fail('password', 'Use 10–200 characters');
    let name;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) fail('name', 'Enter a name of 1–200 characters');
      name = input.name.trim();
    }
    const now = new Date().toISOString();
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    return this.transaction(() => {
      const invitation = this.db.prepare('SELECT * FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL').get(tokenHash);
      if (!invitation || invitation.expires_at <= now) throw new ApiError(422, 'INVALID_INVITATION', 'This invitation is invalid or has expired');
      const user = this.db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(invitation.user_id, invitation.organization_id);
      if (!user || user.status !== 'invited') throw new ApiError(409, 'INVITATION_USED', 'This invitation has already been used');
      this.db.prepare('UPDATE users SET name = ?, password_hash = ?, status = ?, active = 1, auth_version = auth_version + 1, updated_at = ? WHERE id = ? AND organization_id = ?')
        .run(name || user.name, passwordHash(input.password), 'active', now, user.id, invitation.organization_id);
      this.db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(now, invitation.id);
      this.audit('users', user.id, { id: user.id, organization_id: invitation.organization_id, role: user.role }, 'invitation_accepted', { email: user.email });
      return this.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    });
  }
  updateUser(id, input, actor) {
    this.requireManager(actor);
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['name', 'role', 'status'].includes(key)) fail(key, 'Unknown or read-only field');
    return this.transaction(() => {
      const target = this.db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(id, actor.organization_id);
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found');
      if (roleRank[target.role] > roleRank[actor.role]) throw new ApiError(403, 'FORBIDDEN', 'Managers cannot modify a user with a higher role');
      const next = { name: target.name, role: target.role, status: target.status };
      if (Object.hasOwn(input, 'name')) {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) fail('name', 'Enter a name of 1–200 characters');
        next.name = input.name.trim();
      }
      if (Object.hasOwn(input, 'role')) {
        if (!ROLES.includes(input.role)) fail('role', `Allowed: ${ROLES.join(', ')}`);
        if (roleRank[input.role] > roleRank[actor.role]) throw new ApiError(403, 'FORBIDDEN', 'Managers cannot grant a role above their own');
        next.role = input.role;
      }
      if (Object.hasOwn(input, 'status')) {
        if (!['active', 'disabled'].includes(input.status)) fail('status', 'Allowed: active, disabled');
        if (target.status === 'invited') throw new ApiError(409, 'INVITATION_PENDING', 'Revoke the invitation instead of changing its status');
        next.status = input.status;
      }
      if (target.role === 'owner' && target.status === 'active' && (next.role !== 'owner' || next.status !== 'active')) {
        const owners = this.db.prepare("SELECT COUNT(*) AS total FROM users WHERE organization_id = ? AND role = 'owner' AND status = 'active' AND active = 1").get(actor.organization_id).total;
        if (owners <= 1) throw new ApiError(409, 'LAST_OWNER', 'The last active owner cannot be demoted or disabled');
      }
      const authChanged = next.role !== target.role || next.status !== target.status;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE users SET name = ?, role = ?, status = ?, active = ?, auth_version = auth_version + ?, updated_at = ? WHERE id = ? AND organization_id = ?')
        .run(next.name, next.role, next.status, next.status === 'active' ? 1 : 0, authChanged ? 1 : 0, now, id, actor.organization_id);
      if (target.status === 'invited' && next.role !== target.role) this.db.prepare('UPDATE invitations SET role = ? WHERE user_id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(next.role, id, actor.organization_id);
      const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => target[key] !== value).map(([key, value]) => [key, { before: target[key], after: value }]));
      this.audit('users', id, actor, 'user_updated', changes);
      return this.userView(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id), actor);
    });
  }
  revokeInvitation(id, actor) {
    this.requireManager(actor);
    return this.transaction(() => {
      const invitation = this.db.prepare('SELECT * FROM invitations WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').get(id, actor.organization_id);
      if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
      const now = new Date().toISOString();
      const target = this.db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(invitation.user_id, actor.organization_id);
      if (target) {
        if (roleRank[target.role] > roleRank[actor.role]) throw new ApiError(403, 'FORBIDDEN', 'Managers cannot modify a user with a higher role');
        this.db.prepare("UPDATE users SET status = 'disabled', active = 0, auth_version = auth_version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND status = 'invited'").run(now, target.id, actor.organization_id);
      }
      this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(now, id);
      this.audit('users', invitation.user_id, actor, 'invitation_revoked', { email: invitation.email });
    });
  }
}
