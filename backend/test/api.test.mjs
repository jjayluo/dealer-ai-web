import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Store } from '../domain.mjs';
import { createUser } from '../auth.mjs';
import { createApp } from '../server.mjs';
import { buildVehicleFacts, fallbackReply } from '../ai.mjs';

const vehicle = (extra = {}) => ({ stock_number: 'A-1', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', mileage: 80000, list_price: 8995, ...extra });
async function fixture(t) {
  const store = new Store();
  const manager = createUser(store, { organization_id: randomUUID(), email: 'manager@example.com', password: 'test-password', name: 'Manager' });
  const { server } = createApp({ store, aiReply: fallbackReply });
  const network = process.env.DEALER_HTTP_TEST === '1';
  if (network) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const base = `http://127.0.0.1:${network ? server.address().port : 3000}`;
  // Exercise the same request handler without sockets in restricted environments.
  // DEALER_HTTP_TEST=1 runs these assertions over real HTTP instead.
  const fetchLocal = network ? fetch : async (url, options = {}) => {
    const request = new Request(url, options);
    const bytes = Buffer.from(await request.arrayBuffer());
    const req = Readable.from(bytes.length ? [bytes] : []);
    req.method = request.method; req.url = new URL(url).pathname + new URL(url).search;
    req.headers = { host: new URL(url).host, ...Object.fromEntries(request.headers) };
    req.socket = { remoteAddress: '127.0.0.1' };
    const chunks = []; const headers = {}; let status = 200;
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    res.setHeader = (name, value) => { headers[name] = value; };
    res.writeHead = (code, values = {}) => { status = code; Object.assign(headers, values); res.headersSent = true; };
    const finished = once(res, 'finish');
    await server.listeners('request')[0](req, res); await finished;
    return new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers });
  };
  t.after(async () => { if (network) await new Promise(resolve => server.close(resolve)); store.close(); });
  async function request(path, { method = 'GET', data, token, version, headers = {}, body } = {}) {
    if (data !== undefined) { body = JSON.stringify(data); headers['Content-Type'] = 'application/json'; }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (version !== undefined) headers['If-Match'] = String(version);
    const response = await fetchLocal(`${base}/api/v1${path}`, { method, body, headers });
    const result = response.status === 204 ? null : await response.json();
    return { status: response.status, ...result };
  }
  const login = await request('/auth/login', { method: 'POST', data: { email: manager.email, password: 'test-password' } });
  const token = login.data.access_token;
  const api = (path, options = {}) => request(path, { token, ...options });
  return { store, manager, base, request, api, token, fetchLocal };
}

test('authentication, errors and static file allowlist', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/vehicles')).status, 401);
  assert.equal((await f.request('/vehicles', { token: 'bad.token.value' })).status, 401);
  assert.equal((await f.api('/me')).data.email, 'manager@example.com');
  assert.equal((await f.request('/auth/login', { method: 'POST', data: { email: 'manager@example.com', password: 'wrong' } })).status, 401);
  for (const path of ['/backend/data/dealer.sqlite', '/.git/config', '/docs/README.md', '/api/v1/nope']) assert.ok((await f.fetchLocal(f.base + path)).status >= 400);
  assert.equal((await f.fetchLocal(f.base + '/app/')).status, 200);
  assert.equal((await f.api('/vehicles', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.api('/vehicles', { method: 'POST', data: {}, headers: { Origin: 'https://untrusted.example' } })).status, 403);
});

test('vehicle CRUD, normalization, filters, pagination and summaries', async t => {
  const { api } = await fixture(t);
  const created = await api('/vehicles', { method: 'POST', data: vehicle({ stock_number: ' a-1 ', vin: '1hgcm82633a004352' }) });
  assert.equal(created.status, 201); assert.equal(created.data.stock_number, 'A-1');
  const id = created.data.id;
  assert.equal((await api(`/vehicles/${id}`)).data.vin, '1HGCM82633A004352');
  const filtered = await api('/vehicles?make=Honda&price_min=8000&price_max=9000&q=Accord&page_size=1');
  assert.equal(filtered.meta.total, 1); assert.equal(filtered.data.length, 1);
  assert.equal((await api('/vehicles?make=Toyota')).meta.total, 0);
  assert.equal((await api('/vehicles?page=2&page_size=1')).data.length, 0);
  assert.equal((await api('/summary')).data.vehicles.by_status.available, 1);
  const patched = await api(`/vehicles/${id}`, { method: 'PATCH', version: 1, data: { list_price: 8500 } });
  assert.equal(patched.data.version, 2); assert.equal(patched.data.make, 'Honda');
  assert.equal((await api(`/vehicles/${id}`, { method: 'DELETE', version: 2 })).status, 204);
  assert.equal((await api(`/vehicles/${id}`)).status, 404);
  assert.equal((await api('/vehicles')).meta.total, 0);
});

test('validation rejects invalid VINs, prices, years, input types and query values', async t => {
  const { api } = await fixture(t);
  for (const change of [{ vin: 'INVALID' }, { list_price: -1 }, { list_price: 1.001 }, { minimum_price: 99999 }, { mileage: 1.5 }, { year: 1800 }, { year: '2003' }, { acquired_at: '2026-02-30' }, { status: 'unknown' }, { organization_id: 'forged' }]) {
    const result = await api('/vehicles', { method: 'POST', data: vehicle(change) }); assert.equal(result.status, 422, JSON.stringify(change)); assert.ok(result.error.request_id);
  }
  assert.equal((await api('/vehicles', { method: 'POST', data: [] })).status, 422);
  for (const query of ['page=0', 'page_size=101', 'page=abc', 'price_min=nope', 'price_min=10&price_max=1', 'status=nope']) assert.equal((await api(`/vehicles?${query}`)).status, 422, query);
  assert.equal((await api('/vehicles', { method: 'POST', data: vehicle({ status: 'draft', vin: null }) })).status, 201);
});

test('duplicate VIN and stock numbers conflict, even after archival', async t => {
  const { api } = await fixture(t);
  const created = await api('/vehicles', { method: 'POST', data: vehicle() });
  assert.equal((await api('/vehicles', { method: 'POST', data: vehicle({ stock_number: 'A-2' }) })).status, 409);
  assert.equal((await api('/vehicles', { method: 'POST', data: vehicle({ vin: '5YJ3E1EB7PF123456' }) })).status, 409);
  await api(`/vehicles/${created.data.id}`, { method: 'DELETE', version: 1 });
  assert.equal((await api('/vehicles', { method: 'POST', data: vehicle() })).status, 409);
});

test('optimistic concurrency prevents stale edits and stale archives', async t => {
  const { api } = await fixture(t);
  const { data } = await api('/vehicles', { method: 'POST', data: vehicle() });
  const path = `/vehicles/${data.id}`;
  assert.equal((await api(path, { method: 'PATCH', data: { mileage: 90000 } })).status, 428);
  const updates = await Promise.all([api(path, { method: 'PATCH', version: 1, data: { mileage: 90000 } }), api(path, { method: 'PATCH', version: 1, data: { mileage: 91000 } })]);
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
  assert.equal((await api(path, { method: 'DELETE', version: 1 })).error.code, 'STALE_VERSION');
  assert.equal((await api(`${path}/activity`)).data.length, 2);
});

test('customers persist notes, duplicate warnings, consent and multiple leads', async t => {
  const { api } = await fixture(t);
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex', email: ' ALEX@example.com ', phone: '+1 (408) 555-9213', do_not_contact: true } })).data;
  assert.equal(customer.email, 'alex@example.com'); assert.equal(customer.phone, '+14085559213');
  const duplicate = await api('/customers', { method: 'POST', data: { first_name: 'Another', email: 'alex@example.com' } });
  assert.equal(duplicate.status, 201); assert.equal(duplicate.meta.duplicate_candidates[0].id, customer.id);
  assert.equal((await api(`/customers/${customer.id}/notes`, { method: 'POST', data: { note_text: 'Call next week', is_pinned: true } })).status, 201);
  assert.equal((await api(`/customers/${customer.id}/notes`, { method: 'POST', data: { note_text: ' ' } })).status, 422);
  assert.equal((await api(`/customers/${customer.id}/notes`, { method: 'POST', data: { note_text: 'Hello', is_pinned: 'true' } })).status, 422);
  for (let i = 0; i < 2; i++) assert.equal((await api('/leads', { method: 'POST', data: { customer_id: customer.id, source: 'Website' } })).status, 201);
  const detail = (await api(`/customers/${customer.id}`)).data;
  assert.equal(detail.lead_count, 2); assert.equal(detail.notes[0].is_pinned, true); assert.equal(detail.do_not_contact, true);
  assert.equal((await api('/leads?q=Alex')).meta.total, 2);
  assert.equal((await api('/customers?q=%27%20OR%201%3D1--')).meta.total, 0);
});

test('lead lifecycle, assignment, external deduplication and audit history', async t => {
  const { api, manager } = await fixture(t);
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex' } })).data;
  const data = { customer_id: customer.id, source: 'Website', external_lead_id: 'EXT-1', assigned_user_id: manager.id };
  assert.equal((await api('/leads', { method: 'POST', data: { ...data, status: 'won' } })).status, 422);
  const lead = (await api('/leads', { method: 'POST', data })).data;
  assert.equal((await api('/leads', { method: 'POST', data })).status, 409);
  assert.equal((await api('/leads', { method: 'POST', data: { ...data, external_lead_id: '2', customer_id: randomUUID() } })).status, 422);
  assert.equal((await api(`/leads/${lead.id}`, { method: 'PATCH', version: 1, data: { status: 'won' } })).status, 409);
  const working = await api(`/leads/${lead.id}`, { method: 'PATCH', version: 1, data: { status: 'working', priority: 'high' } }); assert.equal(working.status, 200);
  await api(`/leads/${lead.id}`, { method: 'PATCH', version: 2, data: { status: 'qualified' } });
  const won = await api(`/leads/${lead.id}`, { method: 'PATCH', version: 3, data: { status: 'won' } }); assert.equal(won.status, 200);
  assert.equal((await api(`/leads/${lead.id}`, { method: 'PATCH', version: 4, data: { status: 'working' } })).status, 409);
  assert.equal((await api(`/leads/${lead.id}/activity`)).data[0].changes.status.after, 'won');
});

test('lost and reopened leads require reasons', async t => {
  const { api } = await fixture(t);
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex' } })).data;
  const lead = (await api('/leads', { method: 'POST', data: { customer_id: customer.id, source: 'Website' } })).data;
  const missingLostReason = await api(`/leads/${lead.id}`, { method: 'PATCH', version: 1, data: { status: 'lost' } });
  assert.equal(missingLostReason.status, 422);
  assert.ok(missingLostReason.error.field_errors.lost_reason);
  const lost = await api(`/leads/${lead.id}`, { method: 'PATCH', version: 1, data: { status: 'lost', lost_reason: 'Price too high' } });
  assert.equal(lost.status, 200);
  const missingReopenReason = await api(`/leads/${lead.id}`, { method: 'PATCH', version: 2, data: { status: 'working' } });
  assert.equal(missingReopenReason.status, 422);
  assert.ok(missingReopenReason.error.field_errors.reopen_reason);
  assert.equal((await api(`/leads/${lead.id}`, { method: 'PATCH', version: 2, data: { status: 'working', reopen_reason: 'Customer returned' } })).status, 200);
});

test('active leads prevent archival and terminal history remains linked', async t => {
  const { api } = await fixture(t);
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex' } })).data;
  const car = (await api('/vehicles', { method: 'POST', data: vehicle() })).data;
  const lead = (await api('/leads', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, source: 'Walk-in' } })).data;
  assert.equal((await api(`/vehicles/${car.id}`, { method: 'DELETE', version: 1 })).error.code, 'ACTIVE_LEADS');
  assert.equal((await api(`/customers/${customer.id}`, { method: 'DELETE', version: 1 })).status, 409);
  await api(`/leads/${lead.id}`, { method: 'PATCH', version: 1, data: { status: 'lost', lost_reason: 'Customer chose another vehicle' } });
  assert.equal((await api(`/vehicles/${car.id}`, { method: 'DELETE', version: 1 })).status, 204);
  assert.equal((await api('/leads')).data[0].vehicle.model, 'Accord');
  assert.equal((await api('/leads', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, source: 'Website' } })).status, 422);
  assert.equal((await api(`/leads/${lead.id}`, { method: 'PATCH', version: 2, data: { status: 'working' } })).status, 422);
});

test('tenant isolation covers list, details, references, notes and activity', async t => {
  const { api, store } = await fixture(t);
  const other = createUser(store, { organization_id: randomUUID(), email: 'other@example.com', password: 'pass', name: 'Other' });
  const customer = store.save('customers', { first_name: 'Private' }, other);
  const car = store.save('vehicles', vehicle(), other);
  for (const path of [`/customers/${customer.id}`, `/customers/${customer.id}/notes`, `/customers/${customer.id}/activity`, `/vehicles/${car.id}/media`]) assert.equal((await api(path)).status, 404);
  assert.equal((await api('/customers')).meta.total, 0);
  assert.equal((await api('/leads', { method: 'POST', data: { customer_id: customer.id, source: 'Website' } })).status, 422);
  assert.equal((await api('/customers', { method: 'POST', data: { first_name: 'Alex', interested_vehicle_id: car.id } })).status, 422);
  assert.equal((await api('/customers', { method: 'POST', data: { first_name: 'Alex', assigned_user_id: other.id } })).status, 422);
});

test('sales role cannot read or write private costs, including nested vehicles and activity', async t => {
  const { api, store, manager, request } = await fixture(t);
  const salesUser = createUser(store, { organization_id: manager.organization_id, email: 'sales@example.com', password: 'pass', name: 'Sales', role: 'sales' });
  const login = await request('/auth/login', { method: 'POST', data: { email: 'sales@example.com', password: 'pass' } });
  const sales = (path, options = {}) => request(path, { ...options, token: login.data.access_token });
  const car = (await api('/vehicles', { method: 'POST', data: vehicle({ purchase_cost: 5000, minimum_price: 7000, internal_notes: 'private' }) })).data;
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex', interested_vehicle_id: car.id, assigned_user_id: salesUser.id } })).data;
  await api('/leads', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, source: 'Website', assigned_user_id: salesUser.id } });
  for (const path of ['/vehicles', `/vehicles/${car.id}`, `/vehicles/${car.id}/activity`, '/leads', '/customers']) {
    const value = JSON.stringify(await sales(path)); assert.equal(value.includes('purchase_cost'), false, path); assert.equal(value.includes('internal_notes'), false, path);
  }
  assert.equal((await sales('/vehicles', { method: 'POST', data: vehicle({ stock_number: 'A-2' }) })).status, 403);
  assert.equal((await sales(`/vehicles/${car.id}`, { method: 'PATCH', version: 1, data: { purchase_cost: 1 } })).status, 403);
  assert.equal((await sales(`/vehicles/${car.id}`, { method: 'DELETE', version: 1 })).status, 403);
  assert.equal((await sales(`/vehicles/${car.id}`, { method: 'PATCH', version: 1, data: { mileage: 81000 } })).status, 403);
  assert.equal((await sales(`/vehicles/${car.id}/media`, { method: 'POST' })).status, 403);
  assert.equal((await sales(`/vehicles/${car.id}/media/${randomUUID()}`, { method: 'DELETE' })).status, 403);
});

test('multipart photo upload, retrieval, limit, validation and deletion', async t => {
  const { api, base, token, fetchLocal } = await fixture(t);
  const car = (await api('/vehicles', { method: 'POST', data: vehicle() })).data;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const upload = async (bytes, mime) => {
    const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), 'photo.png');
    const res = await fetchLocal(`${base}/api/v1/vehicles/${car.id}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }); return { status: res.status, ...await res.json() };
  };
  assert.equal((await upload('not an image', 'image/png')).status, 422);
  const uploaded = await upload(png, 'image/png'); assert.equal(uploaded.status, 201);
  const response = await fetchLocal(base + uploaded.data.url, { headers: { Authorization: `Bearer ${token}` } }); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  for (let i = 1; i < 10; i++) assert.equal((await upload(png, 'image/png')).status, 201);
  assert.equal((await upload(png, 'image/png')).status, 422);
  assert.equal((await api(`/vehicles/${car.id}/media/${uploaded.data.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/vehicles/${car.id}/media`)).data.length, 9);
});

test('sold inventory cannot be silently reopened', async t => {
  const { api } = await fixture(t);
  const car = (await api('/vehicles', { method: 'POST', data: vehicle({ status: 'sold' }) })).data;
  assert.ok(car.sold_at);
  assert.equal((await api(`/vehicles/${car.id}`, { method: 'PATCH', version: 1, data: { status: 'available' } })).status, 409);
});

test('database records and audit survive a connection restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dealer-persistence-'));
  const filename = join(folder, 'test.sqlite');
  let store;
  try {
    store = new Store(filename);
    const actor = createUser(store, { organization_id: randomUUID(), email: 'persist@example.com', password: 'pass', name: 'Persistent' });
    const customer = store.save('customers', { first_name: 'Saved' }, actor);
    store.addNote(customer.id, { note_text: 'Durable note' }, actor); store.close(); store = new Store(filename);
    assert.equal(store.get('customers', customer.id, actor).first_name, 'Saved');
    assert.equal(store.notes(customer.id, actor)[0].note_text, 'Durable note');
    assert.equal(store.activity('customers', customer.id, actor).length, 2);
  } finally {
    store?.close();
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('role scopes: sales and BDC only see assigned records; inventory is manager-write', async t => {
  const { api, store, manager, request } = await fixture(t);
  const salesA = createUser(store, { organization_id: manager.organization_id, email: 'sales.a@example.com', password: 'sales-pass-123', name: 'Sales A', role: 'sales' });
  const salesB = createUser(store, { organization_id: manager.organization_id, email: 'sales.b@example.com', password: 'sales-pass-123', name: 'Sales B', role: 'sales' });
  const bdc = createUser(store, { organization_id: manager.organization_id, email: 'bdc@example.com', password: 'bdc-pass-123', name: 'BDC', role: 'bdc' });
  const loginAs = async (email, password) => (await request('/auth/login', { method: 'POST', data: { email, password } })).data.access_token;
  const as = token => (path, options = {}) => request(path, { token, ...options });
  const a = as(await loginAs('sales.a@example.com', 'sales-pass-123'));
  const b = as(await loginAs('sales.b@example.com', 'sales-pass-123'));
  const d = as(await loginAs('bdc@example.com', 'bdc-pass-123'));

  const car = (await api('/vehicles', { method: 'POST', data: vehicle() })).data;
  const customerA = (await api('/customers', { method: 'POST', data: { first_name: 'Assigned A', assigned_user_id: salesA.id } })).data;
  const customerB = (await api('/customers', { method: 'POST', data: { first_name: 'Assigned B', assigned_user_id: salesB.id } })).data;
  const customerQueue = (await api('/customers', { method: 'POST', data: { first_name: 'Queue' } })).data;
  const customerBdc = (await api('/customers', { method: 'POST', data: { first_name: 'BDC own', assigned_user_id: bdc.id } })).data;
  const leadA = (await api('/leads', { method: 'POST', data: { customer_id: customerA.id, source: 'Website', assigned_user_id: salesA.id } })).data;
  const leadB = (await api('/leads', { method: 'POST', data: { customer_id: customerB.id, source: 'Website', assigned_user_id: salesB.id } })).data;
  const leadQueue = (await api('/leads', { method: 'POST', data: { customer_id: customerQueue.id, source: 'Website' } })).data;
  const leadBdc = (await api('/leads', { method: 'POST', data: { customer_id: customerBdc.id, source: 'Website', assigned_user_id: bdc.id } })).data;

  assert.deepEqual((await a('/customers')).data.map(row => row.id), [customerA.id]);
  assert.deepEqual((await a('/leads')).data.map(row => row.id), [leadA.id]);
  assert.equal((await a(`/customers/${customerB.id}`)).status, 404);
  assert.equal((await a(`/customers/${customerB.id}/notes`)).status, 404);
  assert.equal((await a(`/leads/${leadB.id}`)).status, 404);
  assert.equal((await a(`/leads/${leadB.id}/activity`)).status, 404);
  assert.equal((await a(`/customers/${customerQueue.id}`)).status, 404);

  const createdCustomer = await a('/customers', { method: 'POST', data: { first_name: 'Created by A' } });
  assert.equal(createdCustomer.status, 201);
  assert.equal(createdCustomer.data.assigned_user_id, salesA.id);
  const createdLead = await a('/leads', { method: 'POST', data: { customer_id: createdCustomer.data.id, source: 'Walk-in' } });
  assert.equal(createdLead.status, 201);
  assert.equal(createdLead.data.assigned_user_id, salesA.id);
  assert.equal((await a('/leads', { method: 'POST', data: { customer_id: customerB.id, source: 'Website' } })).status, 422);
  assert.equal((await a('/customers', { method: 'POST', data: { first_name: 'Assigned elsewhere', assigned_user_id: salesB.id } })).status, 403);

  assert.equal((await a(`/customers/${customerA.id}`, { method: 'PATCH', version: customerA.version, data: { assigned_user_id: salesB.id } })).status, 403);
  assert.equal((await a(`/customers/${customerA.id}`, { method: 'PATCH', version: customerA.version, data: { assigned_user_id: salesA.id, first_name: 'Updated A' } })).status, 200);
  assert.equal((await a('/vehicles', { method: 'POST', data: vehicle({ stock_number: 'A-2' }) })).status, 403);
  assert.equal((await a(`/vehicles/${car.id}`, { method: 'PATCH', version: car.version, data: { mileage: 90000 } })).status, 403);
  assert.equal((await a(`/vehicles/${car.id}`, { method: 'DELETE', version: car.version })).status, 403);
  assert.equal((await a(`/vehicles/${car.id}/media`, { method: 'POST' })).status, 403);
  assert.equal((await a(`/vehicles/${car.id}/media/${randomUUID()}`, { method: 'DELETE' })).status, 403);
  const inventory = (await a('/vehicles')).data;
  assert.equal(inventory.length, 1);
  for (const field of ['purchase_cost', 'minimum_price', 'internal_notes']) assert.equal(field in inventory[0], false);

  assert.deepEqual((await d('/customers')).data.map(row => row.id).sort(), [customerQueue.id, customerBdc.id].sort());
  assert.deepEqual((await d('/leads')).data.map(row => row.id).sort(), [leadQueue.id, leadBdc.id].sort());
  assert.equal((await d(`/customers/${customerA.id}`)).status, 404);
  const claimed = await d(`/customers/${customerQueue.id}`, { method: 'PATCH', version: customerQueue.version, data: { assigned_user_id: bdc.id } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.assigned_user_id, bdc.id);
  assert.equal((await d(`/customers/${customerQueue.id}`, { method: 'PATCH', version: claimed.data.version, data: { assigned_user_id: salesA.id } })).status, 403);
  assert.equal((await d('/vehicles', { method: 'POST', data: vehicle({ stock_number: 'A-3' }) })).status, 403);
  assert.equal((await d(`/vehicles/${car.id}`, { method: 'PATCH', version: car.version, data: { mileage: 90000 } })).status, 403);

  const salesSummary = (await a('/summary')).data;
  assert.equal(salesSummary.customers.total, 2);
  assert.equal(salesSummary.leads.total, 2);
  assert.equal(salesSummary.vehicles.total, 1);
  const bdcSummary = (await d('/summary')).data;
  assert.equal(bdcSummary.customers.total, 2);
  assert.equal(bdcSummary.leads.total, 2);
  const managerSummary = (await api('/summary')).data;
  assert.equal(managerSummary.customers.total, 5);
  assert.equal(managerSummary.leads.total, 5);

  const queueCurrent = (await api(`/customers/${customerQueue.id}`)).data;
  assert.equal((await api(`/customers/${customerQueue.id}`, { method: 'PATCH', version: queueCurrent.version, data: { assigned_user_id: salesB.id } })).status, 200);
  assert.equal((await d('/summary')).data.customers.total, 1);
  assert.equal((await b('/summary')).data.customers.total, 2);
  assert.equal((await api('/customers')).meta.total, 5);
});

test('user management: invitations, acceptance, roles, status and token invalidation', async t => {
  const { api, store, manager, request } = await fixture(t);
  const listed = await api('/users');
  assert.equal(listed.status, 200);
  const self = listed.data.find(user => user.id === manager.id);
  assert.equal(self.email, 'manager@example.com');
  assert.equal(self.status, 'active');
  assert.equal(self.is_self, true);
  assert.equal('password_hash' in self, false);
  assert.equal('auth_version' in self, false);
  assert.equal(listed.meta.counts.by_status.active, 1);

  assert.equal((await api('/users/invitations', { method: 'POST', data: { email: 'owner2@example.com', role: 'owner' } })).status, 403);
  const invitation = await api('/users/invitations', { method: 'POST', data: { email: 'New-Sales@Example.com', name: 'New Sales', role: 'sales' } });
  assert.equal(invitation.status, 201);
  assert.equal(invitation.data.email, 'new-sales@example.com');
  assert.equal(invitation.data.status, 'invited');
  assert.equal(invitation.data.accept_path, '/api/v1/auth/accept-invitation');
  assert.ok(invitation.data.token.length >= 20);
  assert.equal((await api('/users/invitations', { method: 'POST', data: { email: 'new-sales@example.com', role: 'sales' } })).error.code, 'INVITATION_PENDING');
  const pending = await api('/users/invitations');
  assert.equal(pending.data.length, 1);
  assert.equal(pending.data[0].email, 'new-sales@example.com');
  const invited = (await api('/users')).data.find(user => user.email === 'new-sales@example.com');
  assert.equal(invited.status, 'invited');
  assert.equal(invited.invitation.id, invitation.data.id);

  assert.equal((await request('/auth/login', { method: 'POST', data: { email: 'new-sales@example.com', password: 'new-password-123' } })).status, 401);
  assert.equal((await api(`/users/${invited.id}`, { method: 'PATCH', data: { status: 'active' } })).error.code, 'INVITATION_PENDING');

  createUser(store, { organization_id: manager.organization_id, email: 'viewer@example.com', password: 'viewer-password', name: 'Viewer', role: 'bdc' });
  const viewerLogin = await request('/auth/login', { method: 'POST', data: { email: 'viewer@example.com', password: 'viewer-password' } });
  assert.equal((await request('/users', { token: viewerLogin.data.access_token })).status, 403);

  const accepted = await request('/auth/accept-invitation', { method: 'POST', data: { token: invitation.data.token, name: 'New Sales', password: 'new-password-123' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.user.status, 'active');
  const salesToken = accepted.data.access_token;
  assert.equal((await request('/auth/accept-invitation', { method: 'POST', data: { token: invitation.data.token, password: 'new-password-123' } })).error.code, 'INVALID_INVITATION');

  const sales = (path, options = {}) => request(path, { ...options, token: salesToken });
  assert.equal((await sales('/users/invitations', { method: 'POST', data: { email: 'x@example.com', role: 'sales' } })).status, 403);
  assert.equal((await sales('/users')).status, 403);

  const target = (await api('/users')).data.find(user => user.email === 'new-sales@example.com');
  assert.equal(target.status, 'active');
  const promoted = await api(`/users/${target.id}`, { method: 'PATCH', data: { role: 'manager' } });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.role, 'manager');
  assert.equal((await sales('/me')).status, 401);

  const relogin = await request('/auth/login', { method: 'POST', data: { email: 'new-sales@example.com', password: 'new-password-123' } });
  assert.equal(relogin.status, 200);
  const disabled = await api(`/users/${target.id}`, { method: 'PATCH', data: { status: 'disabled' } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.status, 'disabled');
  assert.equal((await request('/me', { token: relogin.data.access_token })).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', data: { email: 'new-sales@example.com', password: 'new-password-123' } })).status, 401);
  const filtered = await api('/users?status=disabled&role=manager');
  assert.equal(filtered.meta.total, 1);
  assert.equal((await api('/users?status=nope')).status, 422);
  assert.equal((await api('/users?role=nope')).status, 422);
});

test('user management: last active owner protection and manager scope', async t => {
  const { api, store, manager, request } = await fixture(t);
  const owner = createUser(store, { organization_id: manager.organization_id, email: 'owner@example.com', password: 'owner-password', name: 'Owner', role: 'owner' });
  const ownerLogin = await request('/auth/login', { method: 'POST', data: { email: 'owner@example.com', password: 'owner-password' } });
  const ownerApi = (path, options = {}) => request(path, { ...options, token: ownerLogin.data.access_token });

  assert.equal((await api(`/users/${owner.id}`, { method: 'PATCH', data: { role: 'manager' } })).status, 403);
  assert.equal((await ownerApi(`/users/${owner.id}`, { method: 'PATCH', data: { role: 'manager' } })).error.code, 'LAST_OWNER');
  assert.equal((await ownerApi(`/users/${owner.id}`, { method: 'PATCH', data: { status: 'disabled' } })).error.code, 'LAST_OWNER');
  assert.equal((await ownerApi(`/users/${owner.id}`, { method: 'PATCH', data: { name: 'Renamed Owner' } })).data.name, 'Renamed Owner');

  createUser(store, { organization_id: manager.organization_id, email: 'owner2@example.com', password: 'owner-password', name: 'Owner 2', role: 'owner' });
  const demoted = await ownerApi(`/users/${owner.id}`, { method: 'PATCH', data: { role: 'manager' } });
  assert.equal(demoted.status, 200);
  assert.equal((await ownerApi('/me')).status, 401);
  assert.equal((await api(`/users/${owner.id}`, { method: 'PATCH', data: { status: 'disabled' } })).status, 200);
});

test('user management: invitation validation, revoke and tenant isolation', async t => {
  const { api, store, manager, request } = await fixture(t);
  for (const data of [{ email: 'not-an-email', role: 'sales' }, { email: 'valid@example.com', role: 'superuser' }, { email: 'valid@example.com' }]) {
    const result = await api('/users/invitations', { method: 'POST', data });
    assert.ok([422, 409].includes(result.status), JSON.stringify(data));
  }
  assert.equal((await api('/users/invitations', { method: 'POST', data: { email: 'manager@example.com', role: 'sales' } })).error.code, 'EMAIL_EXISTS');
  assert.equal((await api('/users/invitations', { method: 'POST', data: { email: 'roles@example.com', role_ids: ['sales', 'manager'] } })).status, 422);
  const invitation = await api('/users/invitations', { method: 'POST', data: { email: 'revoke@example.com', role_ids: ['bdc'] } });
  assert.equal(invitation.status, 201);
  assert.equal(invitation.data.role, 'bdc');
  assert.equal((await api(`/users/invitations/${invitation.data.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await request('/auth/accept-invitation', { method: 'POST', data: { token: invitation.data.token, password: 'revoked-password' } })).error.code, 'INVALID_INVITATION');
  const revoked = (await api('/users')).data.find(user => user.email === 'revoke@example.com');
  assert.equal(revoked.status, 'disabled');
  assert.equal((await api('/users/invitations')).data.some(item => item.id === invitation.data.id), false);

  const stranger = createUser(store, { organization_id: randomUUID(), email: 'stranger@example.com', password: 'stranger-password', name: 'Stranger', role: 'owner' });
  const strangerLogin = await request('/auth/login', { method: 'POST', data: { email: 'stranger@example.com', password: 'stranger-password' } });
  const strangerApi = (path, options = {}) => request(path, { ...options, token: strangerLogin.data.access_token });
  assert.equal((await strangerApi('/users')).data.length, 1);
  assert.equal((await strangerApi(`/users/${manager.id}`, { method: 'PATCH', data: { status: 'disabled' } })).status, 404);
  assert.equal((await api(`/users/${stranger.id}`, { method: 'PATCH', data: { status: 'disabled' } })).status, 404);
});

test('conversations: vehicle-aware AI draft, idempotent messages and unread state', async t => {
  const { api, store, manager, request } = await fixture(t);
  const car = (await api('/vehicles', { method: 'POST', data: vehicle({ mileage: 34500, list_price: 24995, purchase_cost: 19000, minimum_price: 22000, internal_notes: 'internal floor plan note' }) })).data;
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex', last_name: 'Chen', email: 'alex@example.com', phone: '+14085550187' } })).data;
  const created = await api('/conversations', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, message: 'Is it still available and how many miles does it have?', channel: 'web' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'open');
  assert.equal(created.data.customer.email, 'alex@example.com');
  assert.equal(created.data.vehicle.id, car.id);
  assert.equal(created.data.messages.length, 1);
  assert.equal(created.data.messages[0].direction, 'inbound');
  assert.equal(created.data.unread_count, 0);
  const conversationId = created.data.id;

  const suggestion = await api(`/conversations/${conversationId}/ai-suggestion`, { method: 'POST', data: { tone: 'friendly' } });
  assert.equal(suggestion.status, 200);
  assert.match(suggestion.data.draft, /34,500 miles/);
  assert.match(suggestion.data.draft.toLowerCase(), /available/);
  assert.equal(suggestion.data.provider, 'local');
  assert.ok(suggestion.data.verification_notes.length > 0);
  assert.equal(suggestion.data.draft.includes('internal floor plan note'), false);
  assert.equal(suggestion.data.draft.includes('19,000'), false);
  assert.equal(suggestion.data.draft.includes('22,000'), false);
  assert.equal((await api(`/conversations/${conversationId}`)).data.messages.length, 1);

  const payload = { body: 'Yes, it is available. Our team can confirm before your visit.', direction: 'outbound', ai_generated: true };
  const sent = await api(`/conversations/${conversationId}/messages`, { method: 'POST', data: payload, headers: { 'Idempotency-Key': 'message-key-1' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.ai_generated, true);
  assert.equal(sent.data.delivery_status, 'recorded');
  const replay = await api(`/conversations/${conversationId}/messages`, { method: 'POST', data: payload, headers: { 'Idempotency-Key': 'message-key-1' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.meta.replayed, true);
  assert.equal(replay.data.id, sent.data.id);
  assert.equal((await api(`/conversations/${conversationId}`)).data.messages.length, 2);
  assert.equal((await api(`/conversations/${conversationId}/messages`, { method: 'POST', data: { body: 'A different reply', direction: 'outbound' }, headers: { 'Idempotency-Key': 'message-key-1' } })).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await api(`/conversations/${conversationId}/messages`, { method: 'POST', data: { body: 'No key', direction: 'outbound' } })).status, 428);

  createUser(store, { organization_id: manager.organization_id, email: 'manager2@example.com', password: 'manager2-pass', name: 'Manager Two', role: 'manager' });
  const login2 = await request('/auth/login', { method: 'POST', data: { email: 'manager2@example.com', password: 'manager2-pass' } });
  const api2 = (path, options = {}) => request(path, { ...options, token: login2.data.access_token });
  const list2 = await api2('/conversations');
  assert.equal(list2.data.find(row => row.id === conversationId).unread_count, 1);
  assert.equal(list2.meta.counts.unread, 1);
  await api2(`/conversations/${conversationId}`);
  assert.equal((await api2('/conversations')).data.find(row => row.id === conversationId).unread_count, 0);

  const current = (await api(`/conversations/${conversationId}`)).data;
  const closed = await api(`/conversations/${conversationId}`, { method: 'PATCH', version: current.version, data: { status: 'closed' } });
  assert.equal(closed.status, 200);
  assert.equal((await api(`/conversations/${conversationId}/messages`, { method: 'POST', data: { body: 'closed reply', direction: 'outbound' }, headers: { 'Idempotency-Key': 'closed-key' } })).error.code, 'CONVERSATION_CLOSED');
  assert.equal((await api(`/conversations/${conversationId}`, { method: 'PATCH', version: closed.data.version, data: { status: 'open' } })).status, 200);

  const customerCurrent = (await api(`/customers/${customer.id}`)).data;
  await api(`/customers/${customer.id}`, { method: 'PATCH', version: customerCurrent.version, data: { do_not_contact: true } });
  assert.equal((await api(`/conversations/${conversationId}/ai-suggestion`, { method: 'POST', data: {} })).error.code, 'CONTACT_SUPPRESSED');
  assert.equal((await api(`/conversations/${conversationId}/messages`, { method: 'POST', data: { body: 'blocked', direction: 'outbound' }, headers: { 'Idempotency-Key': 'blocked-key' } })).error.code, 'CONTACT_SUPPRESSED');
});

test('conversation scope: sales and BDC visibility, assignment and access', async t => {
  const { api, store, manager, request } = await fixture(t);
  const salesA = createUser(store, { organization_id: manager.organization_id, email: 'conv.sales.a@example.com', password: 'sales-pass-123', name: 'Sales A', role: 'sales' });
  const salesB = createUser(store, { organization_id: manager.organization_id, email: 'conv.sales.b@example.com', password: 'sales-pass-123', name: 'Sales B', role: 'sales' });
  const bdc = createUser(store, { organization_id: manager.organization_id, email: 'conv.bdc@example.com', password: 'bdc-pass-123', name: 'BDC', role: 'bdc' });
  const loginAs = async (email, password) => (await request('/auth/login', { method: 'POST', data: { email, password } })).data.access_token;
  const as = token => (path, options = {}) => request(path, { ...options, token });
  const a = as(await loginAs('conv.sales.a@example.com', 'sales-pass-123'));
  const d = as(await loginAs('conv.bdc@example.com', 'bdc-pass-123'));

  const car = (await api('/vehicles', { method: 'POST', data: vehicle() })).data;
  const customerA = (await api('/customers', { method: 'POST', data: { first_name: 'Assigned A', assigned_user_id: salesA.id } })).data;
  const customerB = (await api('/customers', { method: 'POST', data: { first_name: 'Assigned B', assigned_user_id: salesB.id } })).data;
  const customerQueue = (await api('/customers', { method: 'POST', data: { first_name: 'Queue' } })).data;
  const customerBdc = (await api('/customers', { method: 'POST', data: { first_name: 'BDC own', assigned_user_id: bdc.id } })).data;
  const convA = (await api('/conversations', { method: 'POST', data: { customer_id: customerA.id, vehicle_id: car.id, message: 'Question A', assigned_user_id: salesA.id } })).data;
  const convB = (await api('/conversations', { method: 'POST', data: { customer_id: customerB.id, vehicle_id: car.id, message: 'Question B', assigned_user_id: salesB.id } })).data;
  const convQueue = (await api('/conversations', { method: 'POST', data: { customer_id: customerQueue.id, vehicle_id: car.id, message: 'Queue question', assigned_user_id: null } })).data;
  const convBdc = (await api('/conversations', { method: 'POST', data: { customer_id: customerBdc.id, vehicle_id: car.id, message: 'BDC question', assigned_user_id: bdc.id } })).data;

  assert.deepEqual((await a('/conversations')).data.map(row => row.id), [convA.id]);
  assert.equal((await a(`/conversations/${convB.id}`)).status, 404);
  assert.equal((await a(`/conversations/${convB.id}/messages`, { method: 'POST', data: { body: 'blocked', direction: 'outbound' }, headers: { 'Idempotency-Key': 'scope-key' } })).status, 404);
  assert.equal((await a(`/conversations/${convB.id}`, { method: 'PATCH', version: convB.version, data: { status: 'closed' } })).status, 404);

  const own = await a('/conversations', { method: 'POST', data: { customer_id: customerA.id, vehicle_id: car.id, message: 'Sales A own question' } });
  assert.equal(own.status, 201);
  assert.equal(own.data.assigned_user_id, salesA.id);
  assert.equal((await a('/conversations', { method: 'POST', data: { customer_id: customerA.id, vehicle_id: car.id, message: 'Assign away', assigned_user_id: salesB.id } })).status, 403);
  assert.equal((await a(`/conversations/${convA.id}`, { method: 'PATCH', version: convA.version, data: { assigned_user_id: salesB.id } })).status, 403);
  assert.equal((await a(`/conversations/${convA.id}`, { method: 'PATCH', version: convA.version, data: { assigned_user_id: salesA.id } })).status, 200);

  assert.deepEqual((await d('/conversations')).data.map(row => row.id).sort(), [convQueue.id, convBdc.id].sort());
  assert.equal((await d(`/conversations/${convA.id}`)).status, 404);
  const claimed = await d(`/conversations/${convQueue.id}`, { method: 'PATCH', version: convQueue.version, data: { assigned_user_id: bdc.id } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.assigned_user_id, bdc.id);
  assert.equal((await d(`/conversations/${convQueue.id}`, { method: 'PATCH', version: claimed.data.version, data: { assigned_user_id: salesA.id } })).status, 403);
  assert.equal((await d(`/conversations/${convQueue.id}/messages`, { method: 'POST', data: { body: 'BDC reply', direction: 'outbound' }, headers: { 'Idempotency-Key': 'bdc-key' } })).status, 201);
  assert.equal((await api('/conversations')).meta.total, 5);
});

test('conversation validation and AI privacy boundary', async t => {
  const { api } = await fixture(t);
  const car = (await api('/vehicles', { method: 'POST', data: vehicle() })).data;
  const customer = (await api('/customers', { method: 'POST', data: { first_name: 'Alex' } })).data;
  const noVehicle = (await api('/conversations', { method: 'POST', data: { customer_id: customer.id, message: 'Is it available?' } })).data;
  assert.equal((await api(`/conversations/${noVehicle.id}/ai-suggestion`, { method: 'POST', data: {} })).error.code, 'VEHICLE_REQUIRED');
  const noQuestion = (await api('/conversations', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id } })).data;
  assert.equal((await api(`/conversations/${noQuestion.id}/ai-suggestion`, { method: 'POST', data: {} })).error.code, 'NO_CUSTOMER_MESSAGE');
  assert.equal((await api('/conversations', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, channel: 'carrier-pigeon' } })).status, 422);
  assert.equal((await api('/conversations', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, message: 'Hello', unknown: true } })).status, 422);
  assert.equal((await api(`/conversations/${noQuestion.id}`, { method: 'PATCH', data: { status: 'closed' } })).status, 428);
  assert.equal((await api(`/conversations/${noVehicle.id}/ai-suggestion`, { method: 'POST', data: { unknown: true } })).status, 422);

  const conversation = (await api('/conversations', { method: 'POST', data: { customer_id: customer.id, vehicle_id: car.id, message: 'How many miles?' } })).data;
  assert.equal((await api(`/conversations/${conversation.id}/messages`, { method: 'POST', data: { body: 'sideways', direction: 'sideways' } })).status, 422);

  const facts = buildVehicleFacts({ year: 2022, make: 'Honda', model: 'Accord', mileage: 34500, list_price: 24995, purchase_cost: 19000, minimum_price: 22000, internal_notes: 'secret' });
  assert.equal(facts.price_usd, 24995);
  assert.equal(facts.mileage, 34500);
  assert.equal('purchase_cost' in facts, false);
  assert.equal('minimum_price' in facts, false);
  assert.equal('internal_notes' in facts, false);
  const soldVehicle = fallbackReply({ vehicleFacts: buildVehicleFacts({ year: 2022, make: 'Honda', model: 'Accord', status: 'sold' }), question: 'Is it available?' });
  assert.match(soldVehicle.draft.toLowerCase(), /sold/);
  assert.equal(soldVehicle.provider, 'local');
});
