import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { passwordHash } from './passwords.mjs';

export const ROLES = ['owner', 'manager', 'sales', 'bdc'];
export const USER_STATUSES = ['invited', 'active', 'disabled'];
export const TRANSMISSIONS = ['Automatic', 'Manual', 'CVT', 'eCVT', 'Other', 'Unknown'];
export const CONVERSATION_CHANNELS = ['web', 'email', 'phone', 'sms', 'facebook', 'whatsapp'];
export const CONVERSATION_STATUSES = ['open', 'closed'];
const roleRank = { owner: 3, manager: 2, sales: 1, bdc: 1 };
const isOptOut = body => typeof body === 'string' && /^(?:stop|unsubscribe|opt out|do not contact me|stop contacting me)[.!]?$/i.test(body.trim());
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
const publicStock = "organization_id = ? AND archived_at IS NULL AND json_extract(data, '$.status') = 'available'";
export const schemas = {
  vehicles: {
    stock_number: { ...string, required: true, max: 40 }, vin: { ...string, nullable: true },
    year: { type: 'number', integer: true, min: 1900, max: new Date().getUTCFullYear() + 2, required: true },
    make: { ...string, required: true }, model: { ...string, required: true }, trim: string,
    status: { ...enumRule('draft', 'available', 'pending', 'reserved', 'in_transit', 'sold'), default: 'available' },
    body_type: string, body_style: string, exterior_color: string, interior_color: string,
    transmission: { ...enumRule(...TRANSMISSIONS), default: 'Unknown' }, drivetrain: string, fuel_type: string,
    condition: { ...enumRule('new', 'used', 'certified'), default: 'used' },
    mileage: { type: 'number', integer: true, min: 0, max: 99999999, nullable: true },
    mileage_source: { ...string, nullable: true, max: 40 },
    mileage_reported_at: { ...string, nullable: true },
    mileage_conflict: { type: 'boolean', default: false },
    title_status: { ...string, nullable: true, max: 200 },
    accident_count: { type: 'number', integer: true, min: 0, max: 100, nullable: true },
    accident_summary: { ...text, nullable: true },
    service_record_count: { type: 'number', integer: true, min: 0, max: 10000, nullable: true },
    last_service_date: { ...string, nullable: true },
    history_summary: { ...text, nullable: true },
    history_report_date: { ...string, nullable: true },
    history_report_url: { ...string, nullable: true, max: 500 },
    hybrid_battery_status: { ...enumRule('unknown', 'inspected_good', 'needs_attention', 'replaced'), default: 'unknown' },
    smog_status: { ...enumRule('unknown', 'passed', 'not_passed'), default: 'unknown' },
    ac_status: { ...enumRule('unknown', 'works', 'not_working'), default: 'unknown' },
    inspection_notes: { ...text, nullable: true },
    inspection_conflict: { type: 'boolean', default: false },
    test_current_mileage: { type: 'number', integer: true, min: 0, max: 99999999, nullable: true },
    test_mileage_note: { ...string, nullable: true, max: 200 },
    list_price: { ...money, required: true }, purchase_cost: { ...money, nullable: true }, minimum_price: { ...money, nullable: true },
    location: string, description: text, internal_notes: text, acquired_at: { ...string, nullable: true }, acquisition_source: string,
  },
  customers: {
    first_name: { ...string, required: true, max: 80 }, last_name: { ...string, max: 80 },
    phone: { ...string, max: 30 }, email: string, preferred_language: { ...string, default: 'en', max: 10 },
    lead_source: string,
    status: { ...enumRule('new', 'contacted', 'qualified', 'appointment', 'won', 'lost'), default: 'new' },
    preferred_contact: { ...enumRule('email', 'phone'), nullable: true },
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
    if (data.status !== 'draft' && data.mileage == null) fail('mileage', 'Enter the recorded mileage before listing this vehicle');
    if (data.minimum_price != null && data.minimum_price > data.list_price) fail('minimum_price', 'Minimum price cannot exceed list price');
    for (const field of ['acquired_at', 'mileage_reported_at', 'last_service_date', 'history_report_date']) {
      if (data[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(data[field]) || !Number.isFinite(Date.parse(data[field])) || new Date(data[field]).toISOString().slice(0, 10) !== data[field])) fail(field, 'Use a valid YYYY-MM-DD date');
    }
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
    const mediaColumns = this.db.prepare('PRAGMA table_info(media)').all();
    if (!mediaColumns.some(c => c.name === 'sort_position')) this.db.exec('ALTER TABLE media ADD COLUMN sort_position INTEGER NOT NULL DEFAULT 0');
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
    this.db.prepare(`UPDATE vehicles SET data = json_set(data, '$.transmission', 'Unknown')
      WHERE json_extract(data, '$.transmission') IS NULL
         OR json_extract(data, '$.transmission') = ''
         OR json_extract(data, '$.transmission') NOT IN ('Automatic', 'Manual', 'CVT', 'eCVT', 'Other', 'Unknown')`).run();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        vehicle_id TEXT,
        lead_id TEXT,
        channel TEXT NOT NULL DEFAULT 'web',
        status TEXT NOT NULL DEFAULT 'open',
        assigned_user_id TEXT,
        customer_language TEXT NOT NULL DEFAULT 'en',
        reply_language TEXT NOT NULL DEFAULT 'en',
        ai_auto_reply_enabled INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        last_message_preview TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_tenant ON conversations(organization_id, status, last_message_at);
      CREATE INDEX IF NOT EXISTS conversations_assigned ON conversations(organization_id, assigned_user_id);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        sender_user_id TEXT,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        original_body TEXT,
        original_language TEXT,
        translated_language TEXT,
        translation_provider TEXT,
        ai_generated INTEGER NOT NULL DEFAULT 0,
        ai_confidence REAL,
        channel TEXT NOT NULL DEFAULT 'web',
        delivery_status TEXT NOT NULL DEFAULT 'recorded',
        external_message_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(organization_id, conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS conversation_reads (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_read_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS inquiry_receipts (
        organization_id TEXT NOT NULL, submission_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        received_at TEXT NOT NULL, PRIMARY KEY (organization_id, submission_id)
      );
      CREATE TABLE IF NOT EXISTS message_operations (
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id, idempotency_key)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'inquiry_name')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN inquiry_name TEXT');
    }
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
      delete result.history_report_url; delete result.mileage_conflict; delete result.inspection_conflict;
      delete result.test_current_mileage; delete result.test_mileage_note;
    }
    return result;
  }
  references(kind, data, actor, previous = {}, input = {}) {
    if (kind === 'leads' && !previous.id && data.status !== 'new') fail('status', 'New leads must start at the new stage');
    for (const [key, type] of [['customer_id', 'customers'], ['vehicle_id', 'vehicles'], ['interested_vehicle_id', 'vehicles']]) {
      const reopening = kind === 'leads' && ['won', 'lost'].includes(previous.status) && !['won', 'lost'].includes(data.status);
      if (data[key] && (data[key] !== previous[key] || reopening)) {
        try { this.get(type, data[key], actor); } catch { fail(key, 'Related record is missing or unavailable'); }
      }
    }
    if (data.assigned_user_id && !this.db.prepare('SELECT id FROM users WHERE id = ? AND organization_id = ? AND active = 1').get(data.assigned_user_id, actor.organization_id)) fail('assigned_user_id', 'Choose an active user in this dealership');
    if (kind === 'vehicles' && previous.status === 'sold' && data.status !== 'sold') throw new ApiError(409, 'STATE_CONFLICT', 'Sold inventory cannot be reopened through an ordinary edit');
    if (kind === 'leads' && data.status === 'lost' && !data.lost_reason) fail('lost_reason', 'A reason is required when marking a lead lost');
    if (kind === 'leads' && previous.status && previous.status !== data.status) {
      const transitions = { new: ['working', 'lost'], working: ['qualified', 'lost'], qualified: ['working', 'lost'], won: [], lost: ['working'] };
      if (!transitions[previous.status].includes(data.status)) throw new ApiError(409, 'STATE_CONFLICT', `Cannot move lead from ${previous.status} to ${data.status}`);
      if (previous.status === 'lost' && !['manager', 'owner'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Only a manager can reopen a lost lead');
      if (data.status === 'lost' && (!Object.hasOwn(input, 'lost_reason') || !data.lost_reason)) fail('lost_reason', 'A reason is required when marking a lead lost');
      if (previous.status === 'lost' && (!Object.hasOwn(input, 'reopen_reason') || !data.reopen_reason)) fail('reopen_reason', 'A reason is required when reopening a lost lead');
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
        let review;
        if (kind === 'customers' && !id && input && Object.hasOwn(input, 'duplicate_review')) {
          ({ duplicate_review: review, ...input } = input);
          if (!Array.isArray(review) || review.some(value => typeof value !== 'string')) fail('duplicate_review', 'Expected a list of reviewed customer IDs');
        }
        const data = validate(kind, input, previous);
        if (kind === 'customers' && !id) {
          const candidates = this.duplicates(data, actor);
          if ((candidates.length || review?.length) && (review?.length !== candidates.length || !candidates.every(c => review.includes(c.id)))) {
            const error = new ApiError(409, 'DUPLICATE_REVIEW', 'Review the matching contacts before creating a separate profile.');
            error.duplicate_candidates = candidates;
            throw error;
          }
        }
        if (['customers', 'leads'].includes(kind) && !managerRoles.includes(actor.role)) {
          if (Object.hasOwn(input, 'assigned_user_id')) {
            if (!input.assigned_user_id || input.assigned_user_id !== actor.id) throw new ApiError(403, 'FORBIDDEN', 'You can only keep records assigned to yourself');
          } else if (!id) {
            data.assigned_user_id = actor.id;
          }
        }
        this.references(kind, data, actor, previous, input);
        const now = new Date().toISOString();
        if (kind === 'vehicles' && data.status === 'sold') data.sold_at = previous.sold_at || now;
        if (kind === 'leads') {
          data.last_activity_at = now;
          if (data.status !== 'lost') delete data.lost_reason;
          if (data.status !== 'working') delete data.reopen_reason;
        }
        if (id) this.db.prepare(`UPDATE ${kind} SET data = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?`).run(JSON.stringify(data), now, id, actor.organization_id);
        else {
          id = randomUUID();
          this.db.prepare(`INSERT INTO ${kind} (id, organization_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, actor.organization_id, JSON.stringify(data), now, now);
        }
        const changes = Object.fromEntries(Object.entries(data).filter(([key, value]) => previous[key] !== value).map(([key, value]) => [key, { before: previous[key] ?? null, after: value }]));
        this.audit(kind, id, actor, previous.id ? 'updated' : 'created', changes);
        if (review?.length) this.audit(kind, id, actor, 'distinct_customer_confirmed', { reviewed_count: review.length });
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
    return this.db.prepare('SELECT id, mime, created_at FROM media WHERE vehicle_id = ? AND organization_id = ? ORDER BY sort_position, created_at, id').all(id, actor.organization_id).map((m, index) => ({ ...m, is_primary: index === 0, url: `/api/v1/vehicles/${id}/media/${m.id}` }));
  }
  touchMedia(id, actor, action, changes) {
    this.db.prepare('UPDATE vehicles SET version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?')
      .run(new Date().toISOString(), id, actor.organization_id);
    this.audit('vehicles', id, actor, action, changes);
  }
  reorderMedia(id, ids, actor, expectedVersion) {
    this.requireManager(actor);
    return this.transaction(() => {
      const vehicle = this.get('vehicles', id, actor);
      if (vehicle.version !== expectedVersion) throw new ApiError(409, 'STALE_VERSION', 'Photos changed. Reload before reordering.');
      const current = this.media(id, actor);
      if (!Array.isArray(ids) || ids.length !== current.length || !current.every(m => ids.includes(m.id))) fail('media_ids', 'Include every current photo exactly once');
      const move = this.db.prepare('UPDATE media SET sort_position = ? WHERE id = ? AND vehicle_id = ? AND organization_id = ?');
      ids.forEach((mediaId, index) => move.run(index, mediaId, id, actor.organization_id));
      this.touchMedia(id, actor, 'photos_reordered', { media_ids: ids });
      return this.media(id, actor);
    });
  }
  addMedia(id, bytes, mime, actor, primary = false) {
    if (!managerRoles.includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Inventory changes require manager access');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!((mime === 'image/png' && png) || (mime === 'image/jpeg' && jpg))) fail('file', 'Choose a PNG or JPEG image');
    return this.transaction(() => {
      if (this.media(id, actor).length >= 10) fail('file', 'A vehicle can have at most 10 images');
      const mediaId = randomUUID();
      const bounds = this.db.prepare('SELECT MIN(sort_position) AS first, MAX(sort_position) AS last FROM media WHERE vehicle_id = ? AND organization_id = ?').get(id, actor.organization_id);
      const position = primary ? (bounds.first ?? 0) - 1 : (bounds.last ?? -1) + 1;
      this.db.prepare('INSERT INTO media (id, organization_id, vehicle_id, content, mime, created_at, sort_position) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(mediaId, actor.organization_id, id, bytes, mime, new Date().toISOString(), position);
      this.touchMedia(id, actor, 'photo_added', { media_id: mediaId });
      return this.media(id, actor).find(m => m.id === mediaId);
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
  activeUser(id, organizationId) {
    return this.db.prepare('SELECT id, name, role FROM users WHERE id = ? AND organization_id = ? AND active = 1').get(id, organizationId);
  }
  conversationScope(actor) {
    if (managerRoles.includes(actor.role)) return { sql: '', params: [] };
    if (actor.role === 'sales') return { sql: 'AND assigned_user_id = ?', params: [actor.id] };
    if (actor.role === 'bdc') return { sql: "AND (assigned_user_id = ? OR assigned_user_id IS NULL OR assigned_user_id = '')", params: [actor.id] };
    return { sql: 'AND 0', params: [] };
  }
  conversationRow(id, actor) {
    const scope = this.conversationScope(actor);
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ? AND organization_id = ? ${scope.sql}`).get(id, actor.organization_id, ...scope.params);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found');
    return row;
  }
  related(kind, id, actor) {
    if (!id) return null;
    try { return this.project(kind, this.get(kind, id, actor, true), actor); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  unreadCount(conversationId, actor) {
    const read = this.db.prepare('SELECT last_read_at FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(conversationId, actor.id);
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM messages WHERE organization_id = ? AND conversation_id = ? AND direction = 'inbound' AND created_at > ?`).get(actor.organization_id, conversationId, read?.last_read_at || '');
    return row.total;
  }
  recordOptOut(customerId, body, actor, conversationId) {
    if (!isOptOut(body)) return;
    const result = this.db.prepare(`UPDATE customers SET data = json_set(data, '$.do_not_contact', json('true')),
      version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?
      AND COALESCE(json_extract(data, '$.do_not_contact'), 0) = 0`).run(new Date().toISOString(), customerId, actor.organization_id);
    if (result.changes) this.audit('customers', customerId, actor, 'contact_opt_out', { conversation_id: conversationId, do_not_contact: true });
  }
  markConversationRead(conversationId, actor) {
    this.db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`).run(conversationId, actor.id, new Date().toISOString());
  }
  conversationView(row, actor) {
    const customer = this.related('customers', row.customer_id, actor);
    return {
      ...row,
      ai_auto_reply_enabled: Boolean(row.ai_auto_reply_enabled),
      customer,
      inquiry_name: customer ? row.inquiry_name : null,
      vehicle: this.related('vehicles', row.vehicle_id, actor),
      lead: this.related('leads', row.lead_id, actor),
      assigned_user: row.assigned_user_id ? this.db.prepare('SELECT id, name, role FROM users WHERE id = ? AND organization_id = ?').get(row.assigned_user_id, actor.organization_id) : null,
      unread_count: this.unreadCount(row.id, actor),
    };
  }
  conversationMessages(conversationId, actor) {
    this.conversationRow(conversationId, actor);
    return this.db.prepare(`SELECT m.*, u.name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.organization_id = ? AND m.conversation_id = ? ORDER BY m.created_at, m.rowid`).all(actor.organization_id, conversationId).map(message => ({ ...message, ai_generated: Boolean(message.ai_generated) }));
  }
  getConversation(id, actor) {
    const row = this.conversationRow(id, actor);
    const conversation = this.conversationView(row, actor);
    conversation.messages = this.conversationMessages(id, actor);
    this.markConversationRead(id, actor);
    conversation.unread_count = 0;
    return conversation;
  }
  listConversations(actor, params = new URLSearchParams()) {
    const page = integerParam(params, 'page', 1, 1000000);
    const page_size = integerParam(params, 'page_size', 20, 100);
    const status = params.get('status');
    if (status && !CONVERSATION_STATUSES.includes(status)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid status', { status: `Allowed: ${CONVERSATION_STATUSES.join(', ')}` });
    const channel = params.get('channel');
    if (channel && !CONVERSATION_CHANNELS.includes(channel)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid channel', { channel: `Allowed: ${CONVERSATION_CHANNELS.join(', ')}` });
    const unreadOnly = ['1', 'true'].includes(String(params.get('unread_only') || '').toLowerCase());
    const assigned = params.get('assigned_user_id');
    const q = params.get('q')?.trim().toLowerCase();
    const scope = this.conversationScope(actor);
    const all = this.db.prepare(`SELECT * FROM conversations WHERE organization_id = ? ${scope.sql}
      ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC`).all(actor.organization_id, ...scope.params).map(row => this.conversationView(row, actor));
    let rows = all;
    if (channel) rows = rows.filter(row => row.channel === channel);
    if (assigned) rows = rows.filter(row => assigned === 'unassigned' ? !row.assigned_user_id : row.assigned_user_id === assigned);
    if (q) rows = rows.filter(row => {
      const customer = row.customer;
      const vehicle = row.vehicle;
      return [row.inquiry_name, customer?.first_name, customer?.last_name, `${customer?.first_name || ''} ${customer?.last_name || ''}`, customer?.email, customer?.phone,
        vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.stock_number, vehicle?.vin, row.last_message_preview]
        .some(value => String(value ?? '').toLowerCase().includes(q));
    });
    const counts = {
      total: rows.length,
      open: rows.filter(row => row.status === 'open').length,
      closed: rows.filter(row => row.status === 'closed').length,
      unread: rows.filter(row => row.unread_count > 0).length,
    };
    if (status) rows = rows.filter(row => row.status === status);
    if (unreadOnly) rows = rows.filter(row => row.unread_count > 0);
    const total = rows.length;
    return {
      data: rows.slice((page - 1) * page_size, page * page_size),
      pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) },
      counts,
    };
  }
  createConversation(input, actor) {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['customer_id', 'vehicle_id', 'lead_id', 'message', 'channel', 'assigned_user_id', 'customer_language', 'reply_language'].includes(key)) fail(key, 'Unknown field');
    if (typeof input.customer_id !== 'string' || !input.customer_id) fail('customer_id', 'Choose a customer');
    let customer;
    try { customer = this.get('customers', input.customer_id, actor); } catch { fail('customer_id', 'Choose a customer in your access scope'); }
    let vehicle = null;
    if (input.vehicle_id !== undefined && input.vehicle_id !== null && input.vehicle_id !== '') {
      try { vehicle = this.get('vehicles', input.vehicle_id, actor); } catch { fail('vehicle_id', 'Choose an available vehicle'); }
    }
    let lead = null;
    if (input.lead_id !== undefined && input.lead_id !== null && input.lead_id !== '') {
      try { lead = this.get('leads', input.lead_id, actor); } catch { fail('lead_id', 'Choose a lead in your access scope'); }
      if (lead.customer_id !== customer.id) fail('lead_id', 'The lead belongs to a different customer');
      if (vehicle && lead.vehicle_id && lead.vehicle_id !== vehicle.id) fail('vehicle_id', 'The vehicle does not match the lead');
    }
    if (!lead) {
      lead = this.all('leads', actor).find(item => item.customer_id === customer.id && (!vehicle || item.vehicle_id === vehicle.id) && !['won', 'lost'].includes(item.status)) || null;
    }
    const channel = input.channel ?? 'web';
    if (!CONVERSATION_CHANNELS.includes(channel)) fail('channel', `Allowed: ${CONVERSATION_CHANNELS.join(', ')}`);
    const customerLanguage = typeof input.customer_language === 'string' && input.customer_language.trim() ? input.customer_language.trim() : 'en';
    const replyLanguage = typeof input.reply_language === 'string' && input.reply_language.trim() ? input.reply_language.trim() : 'en';
    if (customerLanguage.length > 10) fail('customer_language', 'Use a language code of at most 10 characters');
    if (replyLanguage.length > 10) fail('reply_language', 'Use a language code of at most 10 characters');
    let assigned = actor.id;
    if (Object.hasOwn(input, 'assigned_user_id') && input.assigned_user_id !== undefined) {
      if (!managerRoles.includes(actor.role) && input.assigned_user_id !== actor.id) throw new ApiError(403, 'FORBIDDEN', 'You can only assign conversations to yourself');
      assigned = input.assigned_user_id === '' ? null : input.assigned_user_id;
      if (assigned && !this.activeUser(assigned, actor.organization_id)) fail('assigned_user_id', 'Choose an active user in this dealership');
    }
    if (!managerRoles.includes(actor.role)) assigned = actor.id;
    let message = null;
    if (input.message !== undefined) {
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 5000) fail('message', 'Enter a question of 1–5000 characters');
      message = input.message.trim();
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO conversations (id, organization_id, customer_id, vehicle_id, lead_id, channel, status, assigned_user_id, customer_language, reply_language, ai_auto_reply_enabled, last_message_at, last_message_preview, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?, ?, 1, ?, ?)`)
        .run(id, actor.organization_id, customer.id, vehicle?.id ?? null, lead?.id ?? null, channel, assigned, customerLanguage, replyLanguage, message ? now : null, message ? message.slice(0, 200) : null, now, now);
      if (message) {
        this.db.prepare(`INSERT INTO messages (id, organization_id, conversation_id, sender_type, sender_user_id, direction, body, original_body, original_language, translated_language, translation_provider, ai_generated, ai_confidence, channel, delivery_status, external_message_id, created_at)
          VALUES (?, ?, ?, 'customer', NULL, 'inbound', ?, ?, ?, NULL, NULL, 0, NULL, ?, 'received', NULL, ?)`)
          .run(randomUUID(), actor.organization_id, id, message, message, customerLanguage, channel, now);
      }
      this.recordOptOut(customer.id, message, actor, id);
      this.markConversationRead(id, actor);
      this.audit('conversations', id, actor, 'conversation_created', { customer_id: customer.id, vehicle_id: vehicle?.id ?? null, lead_id: lead?.id ?? null, channel });
      return this.getConversation(id, actor);
    });
  }
  addMessage(conversationId, input, actor, idempotencyKey) {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['body', 'direction', 'language', 'channel', 'ai_generated'].includes(key)) fail(key, 'Unknown field');
    const conversation = this.conversationRow(conversationId, actor);
    const direction = input.direction ?? 'outbound';
    if (!['inbound', 'outbound'].includes(direction)) fail('direction', 'Allowed: inbound, outbound');
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 5000) fail('body', 'Enter a message of 1–5000 characters');
    const body = input.body.trim();
    const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : (direction === 'inbound' ? conversation.customer_language : conversation.reply_language);
    if (language.length > 10) fail('language', 'Use a language code of at most 10 characters');
    const channel = input.channel ?? conversation.channel;
    if (!CONVERSATION_CHANNELS.includes(channel)) fail('channel', `Allowed: ${CONVERSATION_CHANNELS.join(', ')}`);
    const aiGenerated = input.ai_generated === true;
    if (direction === 'inbound' && aiGenerated) fail('ai_generated', 'Inbound messages cannot be AI generated');
    const key = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
    if (direction === 'outbound' && (!key || key.length > 200)) throw new ApiError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header for outbound messages');
    const requestHash = createHash('sha256').update(JSON.stringify({ conversationId, direction, body, language, aiGenerated })).digest('hex');
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (key) {
        const operation = this.db.prepare('SELECT * FROM message_operations WHERE organization_id = ? AND user_id = ? AND idempotency_key = ?').get(actor.organization_id, actor.id, key);
        if (operation) {
          if (operation.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key was already used with a different request');
          const existing = this.db.prepare('SELECT * FROM messages WHERE id = ? AND organization_id = ?').get(operation.message_id, actor.organization_id);
          if (existing.channel !== channel) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key was used for a different channel');
          const current = this.db.prepare('SELECT version FROM conversations WHERE id = ? AND organization_id = ?').get(conversationId, actor.organization_id);
          return { message: { ...existing, ai_generated: Boolean(existing?.ai_generated) }, conversation_version: current.version, replayed: true };
        }
      }
      const id = randomUUID();
      if (conversation.status !== 'open') throw new ApiError(409, 'CONVERSATION_CLOSED', 'Reopen the conversation before adding messages');
      if (direction === 'outbound') {
        const customer = this.get('customers', conversation.customer_id, actor, true, true);
        if (customer.do_not_contact) throw new ApiError(409, 'CONTACT_SUPPRESSED', 'This customer is marked do not contact');
        if (channel === 'email' && !customer.email) fail('channel', 'Add an email address before recording an email reply');
        if (['sms', 'phone', 'whatsapp'].includes(channel) && !customer.phone) fail('channel', 'Add a phone number before recording a reply on this channel');
      }
      const senderType = direction === 'inbound' ? 'customer' : 'user';
      const senderUserId = direction === 'inbound' ? null : actor.id;
      const deliveryStatus = direction === 'inbound' ? 'received' : 'recorded';
      this.db.prepare(`INSERT INTO messages (id, organization_id, conversation_id, sender_type, sender_user_id, direction, body, original_body, original_language, translated_language, translation_provider, ai_generated, ai_confidence, channel, delivery_status, external_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, ?)`)
        .run(id, actor.organization_id, conversationId, senderType, senderUserId, direction, body, body, language, aiGenerated ? 1 : 0, channel, deliveryStatus, now);
      const version = conversation.version + 1;
      this.db.prepare('UPDATE conversations SET last_message_at = ?, last_message_preview = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?')
        .run(now, body.slice(0, 200), now, conversationId, actor.organization_id);
      if (key) this.db.prepare('INSERT INTO message_operations (organization_id, user_id, idempotency_key, conversation_id, request_hash, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(actor.organization_id, actor.id, key, conversationId, requestHash, id, now);
      if (direction === 'inbound') {
        this.recordOptOut(conversation.customer_id, body, actor, conversationId);
        this.markConversationRead(conversationId, actor);
      }
      this.audit('conversations', conversationId, actor, direction === 'inbound' ? 'message_logged' : 'message_sent', { message_id: id, direction, channel, ai_generated: aiGenerated });
      return {
        message: { id, organization_id: actor.organization_id, conversation_id: conversationId, sender_type: senderType, sender_user_id: senderUserId, direction, body, original_body: body, original_language: language, translated_language: null, translation_provider: null, ai_generated: aiGenerated, ai_confidence: null, channel, delivery_status: deliveryStatus, external_message_id: null, created_at: now },
        conversation_version: version,
        replayed: false,
      };
    });
  }
  aiContext(id, actor) {
    const conversation = this.conversationRow(id, actor);
    const customer = this.get('customers', conversation.customer_id, actor, true, true);
    if (customer.do_not_contact) throw new ApiError(409, 'CONTACT_SUPPRESSED', 'This customer is marked do not contact');
    if (conversation.status !== 'open') throw new ApiError(409, 'CONVERSATION_CLOSED', 'Reopen the conversation before requesting a draft');
    if (!conversation.vehicle_id) throw new ApiError(422, 'VEHICLE_REQUIRED', 'Link a vehicle before requesting an AI reply');
    let vehicle;
    try { vehicle = this.get('vehicles', conversation.vehicle_id, actor); } catch { throw new ApiError(422, 'VEHICLE_REQUIRED', 'The linked vehicle is unavailable'); }
    const question = this.db.prepare(`SELECT id, body, rowid AS sequence, created_at FROM messages WHERE organization_id = ? AND conversation_id = ? AND direction = 'inbound' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(actor.organization_id, id);
    if (!question) throw new ApiError(422, 'NO_CUSTOMER_MESSAGE', 'Add the customer question before requesting an AI reply');
    // Anchor history at the question being answered, including ties within one millisecond.
    const history = this.db.prepare(`SELECT direction, substr(body, 1, 1200) AS body FROM messages
      WHERE organization_id = ? AND conversation_id = ? AND (created_at, rowid) < (?, ?)
      ORDER BY created_at DESC, rowid DESC LIMIT 8`)
      .all(actor.organization_id, id, question.created_at, question.sequence).reverse();
    return { conversation, customer, vehicle, question, history };
  }
  updateConversation(id, input, actor, expectedVersion) {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['status', 'assigned_user_id'].includes(key)) fail(key, 'Unknown or read-only field');
    return this.transaction(() => {
      const conversation = this.conversationRow(id, actor);
      if (conversation.version !== expectedVersion) throw new ApiError(409, 'STALE_VERSION', 'This conversation changed. Reload it before saving.');
      const next = { status: conversation.status, assigned_user_id: conversation.assigned_user_id };
      if (Object.hasOwn(input, 'status')) {
        if (!CONVERSATION_STATUSES.includes(input.status)) fail('status', `Allowed: ${CONVERSATION_STATUSES.join(', ')}`);
        next.status = input.status;
      }
      if (Object.hasOwn(input, 'assigned_user_id') && input.assigned_user_id !== undefined) {
        if (!managerRoles.includes(actor.role) && input.assigned_user_id !== actor.id) throw new ApiError(403, 'FORBIDDEN', 'You can only assign conversations to yourself');
        next.assigned_user_id = input.assigned_user_id === '' ? null : input.assigned_user_id;
        if (next.assigned_user_id && !this.activeUser(next.assigned_user_id, actor.organization_id)) fail('assigned_user_id', 'Choose an active user in this dealership');
      }
      const now = new Date().toISOString();
      this.db.prepare('UPDATE conversations SET status = ?, assigned_user_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?')
        .run(next.status, next.assigned_user_id, now, id, actor.organization_id);
      const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => conversation[key] !== value).map(([key, value]) => [key, { before: conversation[key], after: value }]));
      this.audit('conversations', id, actor, 'conversation_updated', changes);
      return this.getConversation(id, actor);
    });
  }
  publicOrganizationId() {
    if (process.env.DEALER_PUBLIC_ORG_ID) return process.env.DEALER_PUBLIC_ORG_ID;
    const organizations = this.db.prepare('SELECT DISTINCT organization_id FROM users LIMIT 2').all();
    if (organizations.length !== 1) throw new ApiError(503, 'CATALOG_UNAVAILABLE', 'The public inventory is currently unavailable.');
    return organizations[0].organization_id;
  }
  publicVehicleList(params) {
    const page = integerParam(params, 'page', 1, 1000000);
    const page_size = integerParam(params, 'page_size', 12, 48);
    const organizationId = this.publicOrganizationId();
    const total = this.db.prepare(`SELECT count(*) AS total FROM vehicles WHERE ${publicStock}`).get(organizationId).total;
    const rows = this.db.prepare(`SELECT * FROM vehicles WHERE ${publicStock} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(organizationId, page_size, (page - 1) * page_size);
    return { data: rows.map(row => this.publicVehicleFields(row)), pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) } };
  }
  publicVehicle(id) {
    const row = this.db.prepare(`SELECT * FROM vehicles WHERE id = ? AND ${publicStock}`).get(id, this.publicOrganizationId());
    return row ? this.publicVehicleFields(row) : null;
  }
  publicVehicleFields(row) {
    const vehicle = this.unpack(row);
    const fields = ['id', 'year', 'make', 'model', 'trim', 'body_type', 'condition', 'mileage', 'list_price', 'status', 'fuel_type', 'transmission', 'exterior_color', 'interior_color', 'location', 'description'];
    return Object.fromEntries(fields.filter(field => vehicle[field] !== undefined).map(field => [field, vehicle[field]]));
  }
  createPublicInquiry(input) {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail('body', 'Expected a JSON object');
    for (const key of Object.keys(input)) if (!['vehicle_id', 'name', 'email', 'phone', 'preferred_contact', 'question', 'consent', 'submission_id'].includes(key)) fail(key, 'Unknown field');
    if (typeof input.vehicle_id !== 'string' || !input.vehicle_id) fail('vehicle_id', 'Vehicle is required');
    const organizationId = this.publicOrganizationId();
    const vehicleRow = this.db.prepare('SELECT id FROM vehicles WHERE id = ? AND organization_id = ?').get(input.vehicle_id, organizationId);
    if (!vehicleRow) throw new ApiError(404, 'NOT_FOUND', 'Vehicle not found');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 160) fail('name', 'Enter a name of 1–160 characters');
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.trim().length > 4000) fail('question', 'Enter a question of 1–4000 characters');
    if (input.consent !== true) fail('consent', 'Consent is required');
    if (typeof input.submission_id !== 'string' || input.submission_id.trim().length < 8 || input.submission_id.length > 100) fail('submission_id', 'Invalid submission reference');
    if (!['email', 'phone'].includes(input.preferred_contact)) fail('preferred_contact', 'Choose email or phone');
    const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : '';
    const phone = typeof input.phone === 'string' && input.phone.trim() ? input.phone.trim() : '';
    if (!email && !phone) fail('email', 'Enter an email or phone number');
    if (input.preferred_contact === 'email' && !email) fail('email', 'Email is required for your preferred contact');
    if (input.preferred_contact === 'phone' && !phone) fail('phone', 'Phone is required for your preferred contact');
    const submissionId = input.submission_id.trim();
    const nameParts = input.name.trim().replace(/\s+/g, ' ').split(' ');
    const firstName = nameParts.shift();
    const lastName = nameParts.join(' ');
    const customerData = validate('customers', {
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      preferred_contact: input.preferred_contact,
      lead_source: 'Website',
      status: 'new',
    }, {});
    const now = new Date().toISOString();
    const publicActor = { id: 'public', organization_id: organizationId, role: 'public' };
    return this.transaction(() => {
      const requestHash = createHash('sha256').update(JSON.stringify([input.vehicle_id, customerData.first_name, customerData.last_name,
        customerData.email, customerData.phone, customerData.preferred_contact, input.question.trim()])).digest('hex');
      const receipt = this.db.prepare('SELECT * FROM inquiry_receipts WHERE organization_id = ? AND submission_id = ?').get(organizationId, submissionId);
      if (receipt && receipt.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This reference was used for a different inquiry');
      const existingLeadRow = !receipt && this.db.prepare(`SELECT * FROM leads WHERE organization_id = ? AND json_extract(data, '$.source') = 'Website' AND json_extract(data, '$.external_lead_id') = ?`).get(organizationId, submissionId);
      if (receipt || existingLeadRow) {
        return {
          reference: submissionId,
          received_at: receipt?.received_at ?? existingLeadRow.created_at,
          duplicate: true,
          vehicle: this.publicVehicle(input.vehicle_id),
          acknowledgement: 'We received your question. Our team will follow up using your preferred contact. This does not confirm availability or an appointment.',
        };
      }
      if (!this.publicVehicle(input.vehicle_id)) throw new ApiError(404, 'NOT_FOUND', 'Vehicle not found');
      // Public contact details identify review candidates, not an authenticated customer.
      const matches = this.db.prepare(`SELECT data FROM customers WHERE organization_id = ?
        AND archived_at IS NULL AND ((? != '' AND json_extract(data, '$.email') = ?)
          OR (? != '' AND json_extract(data, '$.phone') = ?))`)
        .all(organizationId, customerData.email, customerData.email, customerData.phone, customerData.phone);
      customerData.do_not_contact = matches.some(row => JSON.parse(row.data).do_not_contact);
      const customerId = randomUUID();
      this.db.prepare('INSERT INTO customers (id, organization_id, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(customerId, organizationId, JSON.stringify(customerData), now, now);
      this.audit('customers', customerId, publicActor, 'public_inquiry_customer_created', {
        source: 'Website', review_contact_match: matches.length > 0, preferred_contact: customerData.preferred_contact,
        consent: true, submission_id: submissionId,
      });
      this.db.prepare('INSERT INTO inquiry_receipts VALUES (?, ?, ?, ?)').run(organizationId, submissionId, requestHash, now);
      const leadData = validate('leads', {
        customer_id: customerId,
        vehicle_id: input.vehicle_id,
        source: 'Website',
        external_lead_id: submissionId,
        status: 'new',
        priority: 'normal',
        message: input.question.trim(),
      }, {});
      const leadId = randomUUID();
      this.db.prepare('INSERT INTO leads (id, organization_id, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(leadId, organizationId, JSON.stringify(leadData), now, now);
      this.audit('leads', leadId, publicActor, 'public_inquiry_received', { source: 'Website', external_lead_id: submissionId, vehicle_id: input.vehicle_id, customer_id: customerId });
      const conversationId = randomUUID();
      this.db.prepare(`INSERT INTO conversations (id, organization_id, customer_id, vehicle_id, lead_id, channel, status, assigned_user_id, customer_language, reply_language, ai_auto_reply_enabled, last_message_at, last_message_preview, version, created_at, updated_at, inquiry_name)
        VALUES (?, ?, ?, ?, ?, 'web', 'open', NULL, 'en', 'en', 0, ?, ?, 1, ?, ?, ?)`)
        .run(conversationId, organizationId, customerId, input.vehicle_id, leadId, now, input.question.trim().slice(0, 200), now, now, [firstName, lastName].filter(Boolean).join(' '));
      this.db.prepare(`INSERT INTO messages (id, organization_id, conversation_id, sender_type, sender_user_id, direction, body, original_body, original_language, translated_language, translation_provider, ai_generated, ai_confidence, channel, delivery_status, external_message_id, created_at)
        VALUES (?, ?, ?, 'customer', NULL, 'inbound', ?, ?, 'en', NULL, NULL, 0, NULL, 'web', 'received', NULL, ?)`)
        .run(randomUUID(), organizationId, conversationId, input.question.trim(), input.question.trim(), now);
      this.recordOptOut(customerId, input.question, publicActor, conversationId);
      this.audit('conversations', conversationId, publicActor, 'public_inquiry_received', { lead_id: leadId, vehicle_id: input.vehicle_id });
      return {
        reference: submissionId,
        received_at: now,
        duplicate: false,
        vehicle: this.publicVehicle(input.vehicle_id),
        acknowledgement: 'We received your question. Our team will follow up using your preferred contact. This does not confirm availability or an appointment.',
      };
    });
  }
}
