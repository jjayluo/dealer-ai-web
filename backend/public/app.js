'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const title = value => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, ch => ch.toUpperCase());
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const formatDate = value => {
  if (!value) return '—';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const formatTime = value => value ? new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
const formatDateTime = value => value ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const displayValue = (key, value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  }
  return value;
};
const fullName = row => [row?.first_name, row?.last_name].filter(Boolean).join(' ');
const vehicleName = row => row ? [row.year, row.make, row.model, row.trim].filter(Boolean).join(' ') : '—';
const initials = row => `${row?.first_name?.[0] || ''}${row?.last_name?.[0] || ''}`.toUpperCase() || '?';
const nameInitials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
const avatarTone = value => ['av-blue', 'av-pink', 'av-green', 'av-img'][Math.abs([...String(value || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % 4];
const statuses = { vehicles: ['draft', 'available', 'pending', 'reserved', 'in_transit', 'sold'], customers: ['new', 'contacted', 'qualified', 'appointment', 'won', 'lost'], leads: ['new', 'working', 'qualified', 'won', 'lost'] };
const moduleNames = { vehicles: 'Inventory', customers: 'Customers', leads: 'Leads', conversations: 'Conversations', users: 'Users' };
const singular = { vehicles: 'vehicle', customers: 'customer', leads: 'lead', users: 'user' };
const userRoles = ['owner', 'manager', 'sales', 'bdc'];
const userStatuses = ['invited', 'active', 'disabled'];
const roleLabel = role => ({ owner: 'Owner', manager: 'Manager', sales: 'Sales Rep', bdc: 'BDC' })[role] || title(role);
const roleBadge = role => `<span class="badge ${({ owner: 'purple', manager: 'blue', sales: 'green', bdc: 'gray' })[role] || 'blue'}">${esc(roleLabel(role))}</span>`;
const manager = () => ['owner', 'manager'].includes(actor?.role);
const canWriteInventory = () => ['owner', 'manager'].includes(actor?.role);
const canWriteRecords = () => ['owner', 'manager', 'sales', 'bdc'].includes(actor?.role);
let token = sessionStorage.getItem('dealer-token');
let actor, kind = 'vehicles', page = 1, totalPages = 0, rows = [], filters = {}, generation = 0, photoUrls = [];
let dialogContext;
const conversationState = { items: [], selectedId: null, detail: null, page: 1, totalPages: 1, total: 0, filter: 'all', search: '', counts: { total: 0, open: 0, closed: 0, unread: 0 }, users: null, ai: null, aiUsed: false, sendKey: null };
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function notify(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); $('#notice').hidden = false; }
async function api(path, { method = 'GET', data, version, form, raw = false, idempotencyKey } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (version !== undefined) headers['If-Match'] = String(version);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let response;
  try { response = await fetch(`/api/v1${path}`, { method, headers, body: form || (data === undefined ? undefined : JSON.stringify(data)) }); }
  catch { throw new Error('Cannot reach the server. Check the connection and try again.'); }
  if (response.status === 204) return {};
  if (raw && response.ok) return response.blob();
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') signOut();
    const error = new Error([result.error.message, ...Object.entries(result.error.field_errors || {}).map(([key, value]) => `${title(key)}: ${value}`)].join('\n'));
    error.code = result.error.code; throw error;
  }
  return result;
}
function signOut() {
  generation++; token = null; actor = null; sessionStorage.removeItem('dealer-token');
  conversationState.items = []; conversationState.selectedId = null; conversationState.detail = null; conversationState.ai = null; conversationState.aiUsed = false; conversationState.sendKey = null; conversationState.users = null; conversationState.filter = 'all'; conversationState.search = '';
  closeDialog(); $('#workspace').hidden = true; $('#accept').hidden = true; $('#login').hidden = false; $('#login-form').elements.password.value = '';
}
const acceptParams = () => {
  const [path, query] = location.hash.slice(1).split('?');
  return path === 'accept' ? new URLSearchParams(query || '') : null;
};
function showAccept(params) {
  closeDialog();
  $('#login').hidden = true; $('#workspace').hidden = true; $('#accept').hidden = false;
  $('#accept-form').elements.token.value = params.get('token') || '';
  $('#accept-form').elements.name.focus();
}
async function start() {
  actor = (await api('/me')).data;
  $('#login').hidden = true; $('#accept').hidden = true; $('#workspace').hidden = false;
  $('#user-label').innerHTML = `<span class="user-caption">Signed in as</span><strong>${esc(actor.name)}</strong><span class="user-role">${esc(roleLabel(actor.role))}</span><span class="user-email">${esc(actor.email)}</span>`;
  $('#users-nav').hidden = !manager();
  await route();
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const result = await api('/auth/login', { method: 'POST', data: Object.fromEntries(new FormData(event.target)) }); token = result.data.access_token; sessionStorage.setItem('dealer-token', token); $('#notice').hidden = true; await start(); }
  catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
$('#accept-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const result = await api('/auth/accept-invitation', { method: 'POST', data: Object.fromEntries(new FormData(event.target)) });
    token = result.data.access_token; sessionStorage.setItem('dealer-token', token); $('#accept').hidden = true; $('#notice').hidden = true;
    history.replaceState(null, '', `${location.pathname}#vehicles`); await start();
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
$('#logout').addEventListener('click', signOut);
function selectOptions(values, selected, blank = '') {
  return `${blank ? `<option value="">${esc(blank)}</option>` : ''}${values.map(value => { const [key, label] = Array.isArray(value) ? value : [value, title(value)]; return `<option value="${esc(key)}" ${key === selected ? 'selected' : ''}>${esc(label)}</option>`; }).join('')}`;
}
function filterField(name, label, values) {
  const control = values
    ? `<select id="${name}" name="${name}">${selectOptions(values, filters[name], 'All')}</select>`
    : `<input id="${name}" name="${name}" value="${esc(filters[name])}" ${name.startsWith('price_') ? 'type="number" min="0" step="0.01"' : ''}>`;
  return `<div class="filter-field"><label for="${name}">${label}</label>${control}</div>`;
}
async function route() {
  if (!actor) return;
  closeDialog();
  const [module, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  $('#standard-view').hidden = false;
  $('#conversation-view').hidden = true;
  if (module === 'users') {
    if (!manager()) { location.hash = '#vehicles'; return; }
    kind = 'users';
    page = Math.max(1, Number(params.get('page')) || 1); params.delete('page'); filters = Object.fromEntries(params);
    $('#page-title').textContent = 'Users'; $('#add').textContent = '+ Invite user'; $('#add').hidden = false;
    $('#description').textContent = 'Manage staff roles, invitations and account status.';
    document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.hash === '#users'));
    $('#filters').innerHTML = `<div class="filter-grid">${filterField('q', 'Search') + filterField('role', 'Role', userRoles.map(role => [role, roleLabel(role)])) + filterField('status', 'Status', userStatuses)}<button class="filter-btn" type="submit">Apply filters</button><button class="filter-btn" type="button" id="reset">Reset</button></div>`;
    await loadUsers();
    return;
  }
  if (module === 'conversations') {
    showConversationView();
    await loadConversations();
    return;
  }
  kind = Object.hasOwn(moduleNames, module) ? module : 'vehicles';
  page = Math.max(1, Number(params.get('page')) || 1); params.delete('page'); filters = Object.fromEntries(params);
  $('#page-title').textContent = kind === 'customers' ? 'Customer' : moduleNames[kind]; $('#add').textContent = `+ Add ${singular[kind]}`;
  $('#add').hidden = kind === 'vehicles' ? !canWriteInventory() : !canWriteRecords();
  $('#description').textContent = { vehicles: 'Manage vehicles, pricing and availability.', customers: 'Keep customer identity, interests and notes together.', leads: 'Track each purchase opportunity separately from the customer.' }[kind];
  document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.hash === `#${kind}`));
  $('#filters').innerHTML = `<div class="filter-grid">${filterField('q', 'Search') + filterField('status', 'Status', statuses[kind]) + (kind === 'vehicles' ? filterField('make', 'Make') + filterField('body_type', 'Type', ['Sedan', 'SUV', 'Truck', 'Coupe', 'Van / Minivan', 'Convertible']) + filterField('price_min', 'Min price') + filterField('price_max', 'Max price') : filterField('source', 'Source') + (kind === 'leads' ? filterField('priority', 'Priority', ['low', 'normal', 'high']) : ''))}<button class="filter-btn" type="submit">Apply filters</button><button class="filter-btn" type="button" id="reset">Reset</button></div>`;
  await load();
}
function navigate(nextFilters = filters, nextPage = 1) {
  const params = new URLSearchParams(nextFilters); params.set('page', nextPage);
  const hash = `#${kind}?${params}`;
  if (location.hash === hash) (kind === 'users' ? loadUsers() : load()); else location.hash = hash;
}
$('#filters').addEventListener('submit', event => { event.preventDefault(); navigate(Object.fromEntries([...new FormData(event.target)].filter(([, value]) => value.trim()))); });
$('#filters').addEventListener('click', event => { if (event.target.id === 'reset') navigate({}); });
$('#previous').addEventListener('click', () => navigate(filters, page - 1));
$('#next').addEventListener('click', () => navigate(filters, page + 1));
window.addEventListener('hashchange', () => {
  const params = acceptParams();
  if (params !== null) { showAccept(params); return; }
  $('#accept').hidden = true;
  if (actor) route().catch(error => notify(error.message, true));
  else { $('#workspace').hidden = true; $('#login').hidden = false; }
});
const badgeTone = { available: 'green', won: 'green', active: 'green', open: 'green', qualified: 'blue', invited: 'blue', contacted: 'blue', appointment: 'blue', new: 'blue', reserved: 'blue', pending: 'orange', working: 'orange', in_transit: 'orange', high: 'red', normal: 'blue', low: 'gray', lost: 'gray', sold: 'gray', disabled: 'gray', draft: 'gray', closed: 'gray' };
const badge = status => `<span class="badge ${badgeTone[status] || 'blue'}">${esc(title(status))}</span>`;
async function load() {
  const sequence = ++generation;
  $('#results').innerHTML = '<p class="empty">Loading…</p>'; $('#previous').disabled = $('#next').disabled = true;
  try {
    const params = new URLSearchParams({ ...filters, page, page_size: 10 });
    const [result, summary] = await Promise.all([api(`/${kind}?${params}`), api('/summary')]);
    if (sequence !== generation) return;
    rows = result.data; totalPages = result.meta.total_pages;
    if (page > Math.max(1, totalPages)) { navigate(filters, Math.max(1, totalPages)); return; }
    const counts = summary.data[kind];
    const highlights = kind === 'vehicles'
      ? [['Available', counts.by_status.available || 0, 'ready for sale'], ['Pending', counts.by_status.pending || 0, 'deals in progress'], ['Sold', counts.by_status.sold || 0, 'sold inventory']]
      : kind === 'customers'
        ? [['New', counts.by_status.new || 0, 'new profiles'], ['Qualified', counts.by_status.qualified || 0, 'ready to buy'], ['Won', counts.by_status.won || 0, 'converted']]
        : [['Working', counts.by_status.working || 0, 'in follow-up'], ['Qualified', counts.by_status.qualified || 0, 'ready to buy'], ['Won', counts.by_status.won || 0, 'closed won']];
    const totalSub = kind === 'vehicles' ? 'in inventory' : kind === 'customers' ? 'customer profiles' : 'sales opportunities';
    $('#stats').innerHTML = [['Total', counts.total, totalSub], ...highlights].map(([label, value, sub]) => `<div class="stat"><h3>${label}</h3><div><strong>${value}</strong><span>${sub}</span></div></div>`).join('');
    const headings = kind === 'vehicles' ? ['Photo', 'Vehicle', 'Stock #', 'Mileage', 'Price', 'Status'] : kind === 'customers' ? ['Customer', 'Contact', 'Interested Vehicle', 'Source', 'Last Updated', 'Status'] : ['Customer', 'Vehicle', 'Source', 'Priority', 'Stage'];
    $('#results').innerHTML = rows.length ? `<table class="data-table"><thead><tr>${[...headings, 'Actions'].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
      const cells = kind === 'vehicles' ? [
        '<span class="photo"></span>',
        `<span class="vehicle-title">${esc(vehicleName(row))}</span><span class="sub">${esc([row.body_type, row.condition, row.fuel_type].filter(Boolean).join(' · ') || 'Vehicle')}</span>`,
        `<span>${esc(row.stock_number)}</span><span class="sub">${esc(row.vin || 'Draft — no VIN')}</span>`,
        `${Number(row.mileage).toLocaleString()} mi`,
        `<b>${money(row.list_price)}</b>`,
        badge(row.status)
      ] : kind === 'customers' ? [
        `<div class="customer-cell"><span class="avatar ${avatarTone(row.id || fullName(row))}">${esc(initials(row))}</span><div><span class="name">${esc(fullName(row) || 'Customer')}</span><span class="sub">${esc(row.email || '—')}</span></div></div>`,
        `<div class="contact"><div>${esc(row.phone || '—')}</div>${row.do_not_contact ? '<span class="badge red">Do not contact</span>' : `<span class="sub">${esc(title(row.preferred_language || 'en'))}</span>`}</div>`,
        `<span class="vehicle-title">${esc(vehicleName(row.interested_vehicle))}</span>`,
        esc(row.lead_source || '—'),
        `${esc(formatDate(row.updated_at || row.created_at))}<span class="sub">last updated</span>`,
        badge(row.status)
      ] : [
        `<div class="customer-cell"><span class="avatar ${avatarTone(row.customer?.id || fullName(row.customer) || row.id)}">${esc(initials(row.customer))}</span><div><span class="name">${esc(fullName(row.customer) || 'Customer')}</span><span class="sub">${esc(row.customer?.email || '—')}</span></div></div>`,
        `<span class="vehicle-title">${esc(vehicleName(row.vehicle))}</span><span class="sub">${esc(row.message ? row.message.slice(0, 72) : 'No customer message')}</span>`,
        esc(row.source),
        badge(row.priority),
        badge(row.status)
      ];
      const canEditRow = kind === 'vehicles' ? canWriteInventory() : canWriteRecords();
      const actions = [
        `<button class="icon-btn" data-action="view" data-id="${row.id}" title="View details" aria-label="View details">⊙</button>`,
        canEditRow ? `<button class="icon-btn" data-action="edit" data-id="${row.id}" title="Edit" aria-label="Edit">✎</button>` : '',
        canWriteInventory() ? `<button class="icon-btn danger" data-action="archive" data-id="${row.id}" title="Archive" aria-label="Archive">♲</button>` : ''
      ].join('');
      return `<tr>${cells.map(value => `<td>${value}</td>`).join('')}<td>${actions}</td></tr>`;
    }).join('')}</tbody></table>` : '<p class="empty">No records found. Add a record or adjust your filters.</p>';
    $('#page-info').textContent = `${result.meta.total} records · Page ${page} of ${Math.max(1, totalPages)}`;
    $('#previous').disabled = page <= 1; $('#next').disabled = page >= totalPages;
  } catch (error) {
    if (sequence !== generation) return;
    $('#stats').replaceChildren(); $('#page-info').textContent = '';
    $('#results').innerHTML = '<p class="empty">Unable to load records. <button class="secondary-btn" data-action="retry">Retry</button></p>'; notify(error.message, true);
  }
}
async function loadUsers() {
  const sequence = ++generation;
  $('#results').innerHTML = '<p class="empty">Loading…</p>'; $('#previous').disabled = $('#next').disabled = true;
  try {
    const params = new URLSearchParams({ ...filters, page, page_size: 10 });
    const result = await api(`/users?${params}`);
    if (sequence !== generation) return;
    rows = result.data; totalPages = result.meta.total_pages;
    if (page > Math.max(1, totalPages)) { navigate(filters, Math.max(1, totalPages)); return; }
    const counts = result.meta.counts || { total: 0, by_status: {} };
    $('#stats').innerHTML = [['Total', counts.total, 'staff accounts'], ['Active', counts.by_status.active || 0, 'can sign in'], ['Invited', counts.by_status.invited || 0, 'pending acceptance'], ['Disabled', counts.by_status.disabled || 0, 'no access']].map(([label, value, sub]) => `<div class="stat"><h3>${label}</h3><div><strong>${value}</strong><span>${sub}</span></div></div>`).join('');
    $('#results').innerHTML = rows.length ? `<table class="data-table"><thead><tr>${['Name', 'Role', 'Status', 'Last sign-in', 'Actions'].map(heading => `<th>${heading}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
      const editable = actor.role === 'owner' || row.role !== 'owner';
      const actions = [];
      if (editable) actions.push(`<button class="icon-btn" data-action="edit-user" data-id="${row.id}" title="Edit user" aria-label="Edit user">✎</button>`);
      if (editable && row.status === 'invited' && row.invitation) actions.push(`<button class="icon-btn danger" data-action="revoke-invite" data-id="${row.invitation.id}" title="Revoke invitation" aria-label="Revoke invitation">♲</button>`);
      return `<tr><td><div class="customer-cell"><span class="avatar ${avatarTone(row.id || row.name)}">${esc(nameInitials(row.name))}</span><div><span class="name">${esc(row.name)}${row.is_self ? ' (you)' : ''}</span><span class="sub">${esc(row.email)}</span></div></div></td><td>${roleBadge(row.role)}</td><td>${badge(row.status)}</td><td>${row.last_login_at ? `${esc(formatDate(row.last_login_at))}<span class="sub">${esc(formatTime(row.last_login_at))}</span>` : '—'}</td><td>${actions.join('')}</td></tr>`;
    }).join('')}</tbody></table>` : '<p class="empty">No users match these filters.</p>';
    $('#page-info').textContent = `${result.meta.total} users · Page ${page} of ${Math.max(1, totalPages)}`;
    $('#previous').disabled = page <= 1; $('#next').disabled = page >= totalPages;
  } catch (error) {
    if (sequence !== generation) return;
    $('#stats').replaceChildren(); $('#page-info').textContent = '';
    $('#results').innerHTML = '<p class="empty">Unable to load users. <button class="secondary-btn" data-action="retry">Retry</button></p>'; notify(error.message, true);
  }
}
function showConversationView() {
  kind = 'conversations';
  $('#page-title').textContent = 'Conversations';
  $('#standard-view').hidden = true;
  $('#conversation-view').hidden = false;
  document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.hash === '#conversations'));
  if (location.hash !== '#conversations') history.replaceState(null, '', `${location.pathname}#conversations`);
}
async function loadConversationUsers() {
  if (!manager() || conversationState.users) return;
  try { conversationState.users = (await api('/users')).data; } catch { conversationState.users = []; }
}
async function loadConversations() {
  if (kind !== 'conversations') return;
  try {
    await loadConversationUsers();
    await refreshConversationList();
    if (kind !== 'conversations') return;
    const selected = conversationState.items.find(item => item.id === conversationState.selectedId) || conversationState.items[0];
    if (selected) await openConversation(selected.id);
    else { conversationState.selectedId = null; conversationState.detail = null; renderConversationEmpty(); }
  } catch (error) { notify(error.message, true); }
}
async function refreshConversationList() {
  const params = new URLSearchParams({ page: conversationState.page, page_size: 20 });
  if (conversationState.filter === 'open' || conversationState.filter === 'closed') params.set('status', conversationState.filter);
  if (conversationState.filter === 'unread') params.set('unread_only', '1');
  if (conversationState.search) params.set('q', conversationState.search);
  const result = await api(`/conversations?${params}`);
  const lastPage = Math.max(1, result.meta.total_pages);
  if (conversationState.page > lastPage) { conversationState.page = lastPage; return refreshConversationList(); }
  conversationState.items = result.data;
  conversationState.counts = result.meta.counts || conversationState.counts;
  conversationState.total = result.meta.total;
  conversationState.totalPages = lastPage;
  if (kind !== 'conversations') return;
  renderConversationList();
  renderConversationCounts();
  renderConversationPagination();
}
function renderConversationList() {
  const list = $('#conversation-list');
  if (!conversationState.items.length) {
    list.innerHTML = '<p class="empty">No conversations match these filters.</p>';
    return;
  }
  list.innerHTML = conversationState.items.map(item => {
    const customer = item.customer;
    const name = fullName(customer) || 'Unknown customer';
    const lastAt = item.last_message_at ? new Date(item.last_message_at) : null;
    const time = lastAt ? (lastAt.toDateString() === new Date().toDateString() ? formatTime(lastAt) : formatDate(lastAt)) : '';
    const preview = item.last_message_preview || 'No messages yet';
    return `<button class="conversation-person ${item.id === conversationState.selectedId ? 'active' : ''}" type="button" data-conversation-id="${item.id}">
      <span class="avatar ${avatarTone(customer?.id || name)}">${esc(initials(customer))}</span>
      <span class="conversation-person-copy"><strong>${esc(name)}</strong><small>${esc(vehicleName(item.vehicle))}</small><small>${esc(preview.slice(0, 90))}</small></span>
      <span class="conversation-person-meta"><small>${esc(time)}</small>${item.unread_count ? `<b>${item.unread_count}</b>` : ''}</span>
    </button>`;
  }).join('');
}
function renderConversationCounts() {
  $('#conv-count-all').textContent = conversationState.counts.total || 0;
  $('#conv-count-open').textContent = conversationState.counts.open || 0;
  $('#conv-count-unread').textContent = conversationState.counts.unread || 0;
  $('#conv-count-closed').textContent = conversationState.counts.closed || 0;
  document.querySelectorAll('#conversation-tabs [data-filter]').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === conversationState.filter));
}
function renderConversationPagination() {
  const el = $('#conversation-pagination');
  const total = conversationState.total;
  if (conversationState.totalPages <= 1) {
    el.innerHTML = `<span>${total} conversation${total === 1 ? '' : 's'}</span>`;
    return;
  }
  el.innerHTML = `<button type="button" data-conv-page="${conversationState.page - 1}" ${conversationState.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${conversationState.page} of ${conversationState.totalPages}</span><button type="button" data-conv-page="${conversationState.page + 1}" ${conversationState.page >= conversationState.totalPages ? 'disabled' : ''}>Next</button>`;
}
function renderConversationEmpty() {
  $('#conversation-title').textContent = 'Conversations';
  $('#conversation-subtitle').textContent = '';
  $('#conversation-actions').innerHTML = '';
  $('#conversation-messages').innerHTML = '<p class="empty">Select a conversation to view messages.</p>';
  $('#conversation-composer').hidden = true;
  $('#ai-suggestion-panel').hidden = true;
  $('#conversation-context').innerHTML = '<p class="empty">Customer and vehicle context appears here.</p>';
}
async function openConversation(id) {
  try {
    const result = await api(`/conversations/${id}`);
    if (kind !== 'conversations') return;
    conversationState.detail = result.data;
    conversationState.selectedId = id;
    conversationState.ai = null;
    conversationState.aiUsed = false;
    conversationState.sendKey = null;
    const item = conversationState.items.find(row => row.id === id);
    if (item?.unread_count) {
      item.unread_count = 0;
      conversationState.counts.unread = Math.max(0, conversationState.counts.unread - 1);
    }
    await loadConversationUsers();
    if (kind !== 'conversations') return;
    renderConversationList();
    renderConversationCounts();
    renderConversationChat();
  } catch (error) { notify(error.message, true); }
}
function renderConversationChat() {
  const c = conversationState.detail;
  if (!c) { renderConversationEmpty(); return; }
  const customer = c.customer;
  const vehicle = c.vehicle;
  const name = fullName(customer) || 'Unknown customer';
  $('#conversation-title').textContent = name;
  $('#conversation-subtitle').textContent = `${vehicleName(vehicle)} · ${title(c.status)} · ${title(c.channel)}`;
  $('#conversation-actions').innerHTML = `<button class="${c.status === 'open' ? 'outline-danger' : 'soft-button'}" type="button" id="toggle-conversation">${c.status === 'open' ? 'Close conversation' : 'Reopen conversation'}</button>`;
  $('#conversation-messages').innerHTML = c.messages.length ? c.messages.map(renderMessage).join('') : '<p class="empty">No messages yet.</p>';
  const messages = $('#conversation-messages');
  messages.scrollTop = messages.scrollHeight;
  const blocked = Boolean(customer?.do_not_contact);
  const open = c.status === 'open';
  $('#conversation-composer').hidden = false;
  $('#message-input').disabled = !open || blocked;
  $('#send-reply-btn').disabled = !open || blocked;
  $('#ai-reply-btn').disabled = blocked || !vehicle;
  $('#log-customer-message').disabled = !open;
  $('#composer-status').textContent = blocked
    ? 'This customer is marked do not contact. Sending and AI drafts are blocked.'
    : !open
      ? 'This conversation is closed. Reopen it to reply.'
      : !vehicle
        ? 'Link a vehicle to use AI replies. Messages are recorded in the CRM; external delivery is not configured.'
        : 'AI suggestions require staff review. Messages are recorded in the CRM; external delivery is not configured.';
  renderConversationContext();
  renderAiPanel();
}
function renderMessage(message) {
  const c = conversationState.detail;
  const incoming = message.direction === 'inbound';
  const who = incoming ? (fullName(c.customer) || 'Customer') : (message.sender_name || 'Staff');
  const ai = message.ai_generated ? '<span class="message-ai">AI-assisted</span>' : '';
  const recorded = !incoming && message.delivery_status === 'recorded' ? ' · recorded' : '';
  return `<div class="message-group ${incoming ? 'incoming' : 'outgoing'}">
    <div class="message-row">
      ${incoming ? `<span class="mini-avatar ${avatarTone(c.customer?.id || who)}">${esc(initials(c.customer))}</span>` : ''}
      <div class="message-bubble ${incoming ? 'incoming' : 'outgoing'}">${esc(message.body)}</div>
    </div>
    <div class="message-meta">${esc(who)} · ${esc(formatDateTime(message.created_at))}${ai}${recorded}</div>
    ${message.original_body && message.original_body !== message.body ? `<div class="message-original">Original: ${esc(message.original_body)}</div>` : ''}
  </div>`;
}
function renderConversationContext() {
  const c = conversationState.detail;
  if (!c) { $('#conversation-context').innerHTML = '<p class="empty">Customer and vehicle context appears here.</p>'; return; }
  const customer = c.customer;
  const vehicle = c.vehicle;
  const lead = c.lead;
  const name = fullName(customer) || 'Unknown customer';
  const users = [...(conversationState.users || [])];
  if (c.assigned_user && !users.some(user => user.id === c.assigned_user.id)) users.push(c.assigned_user);
  const assignee = manager()
    ? `<select id="conversation-assignee"><option value="">Unassigned</option>${users.map(user => `<option value="${user.id}" ${user.id === c.assigned_user_id ? 'selected' : ''}>${esc(user.name)} · ${esc(roleLabel(user.role))}</option>`).join('')}</select>`
    : `<strong>${esc(c.assigned_user?.name || 'Unassigned')}</strong>`;
  const vehicleBlock = vehicle
    ? `<div class="vehicle-summary"><div class="vehicle-placeholder">${esc(vehicle.make || 'Vehicle')}<br>${esc(vehicle.model || '')}</div><div><strong>${esc(vehicleName(vehicle))}</strong><b>${money(vehicle.list_price)}</b><small>${Number(vehicle.mileage || 0).toLocaleString()} miles</small><small>${badge(vehicle.status)}</small></div></div>`
    : '<p class="muted">No vehicle linked. Link a vehicle to use AI replies.</p>';
  const leadBlock = lead
    ? `<div><strong>${esc(title(lead.status))}</strong> · ${esc(title(lead.priority || 'normal'))}</div><div class="sub">${esc(lead.source || '—')} · ${lead.assigned_user_id ? 'Assigned' : 'Unassigned'}</div><p><a class="details-link" href="#leads?customer_id=${encodeURIComponent(customer?.id || '')}">Open customer leads</a></p>`
    : '<p class="muted">No linked lead.</p>';
  $('#conversation-context').innerHTML = `<h2>Customer Details</h2>
    <div class="customer-profile-row"><span class="large-avatar ${avatarTone(customer?.id || name)}">${esc(initials(customer))}</span><div><h3>${esc(name)}</h3><small>${esc(customer?.phone || '—')}</small><small>${esc(customer?.email || '—')}</small>${customer?.do_not_contact ? '<small class="do-not-contact">Do not contact</small>' : ''}</div></div>
    <div class="customer-info-block"><label>Language</label><strong>${esc(title(customer?.preferred_language || 'en'))}</strong></div>
    <div class="customer-info-block"><label>Lead source</label><strong>${esc(customer?.lead_source || '—')}</strong></div>
    <div class="customer-info-block"><h3>Interested Vehicle</h3>${vehicleBlock}</div>
    <div class="customer-info-block"><h3>Lead</h3>${leadBlock}</div>
    <div class="customer-info-block"><label>Conversation</label><div>${badge(c.status)}</div><div class="sub">Channel: ${esc(title(c.channel))} · ${esc(c.customer_language || 'en')} → ${esc(c.reply_language || 'en')}</div></div>
    <div class="customer-info-block"><label>Assigned to</label><div class="conversation-context-actions">${assignee}</div></div>
    <div class="customer-info-block"><h3>AI policy</h3><p class="muted">Assist mode only. Every AI draft requires staff review before sending.</p></div>`;
}
function renderAiPanel() {
  const panel = $('#ai-suggestion-panel');
  const ai = conversationState.ai;
  if (!ai) { panel.hidden = true; panel.innerHTML = ''; return; }
  const notes = Array.isArray(ai.verification_notes) && ai.verification_notes.length
    ? `<ul>${ai.verification_notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>`
    : '';
  const source = ai.provider === 'openai'
    ? `Generated with ${esc(ai.model || 'OpenAI')}.`
    : 'Generated locally from recorded vehicle facts; no live model configured.';
  panel.hidden = false;
  panel.innerHTML = `<h3>✦ AI draft — review before sending</h3><div class="ai-draft">${esc(ai.draft)}</div>${notes}<div class="ai-note">${source}${ai.warning ? ` ${esc(ai.warning)}` : ''}</div><div class="ai-actions"><button class="secondary-btn" type="button" data-ai="regenerate">Regenerate</button><button class="blue-btn" type="button" data-ai="use">Use draft</button></div>`;
}
async function requestAiSuggestion() {
  const c = conversationState.detail;
  if (!c) return;
  const button = $('#ai-reply-btn');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Generating…';
  try {
    const result = await api(`/conversations/${c.id}/ai-suggestion`, { method: 'POST', data: { language: c.reply_language || 'en' } });
    conversationState.ai = result.data;
    conversationState.aiUsed = false;
    renderAiPanel();
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
}
async function sendReply() {
  const c = conversationState.detail;
  if (!c) return;
  const input = $('#message-input');
  const body = input.value.trim();
  if (!body) { notify('Enter a reply before sending.', true); return; }
  const button = $('#send-reply-btn');
  button.disabled = true;
  conversationState.sendKey ||= uuid();
  try {
    await api(`/conversations/${c.id}/messages`, { method: 'POST', data: { body, direction: 'outbound', ai_generated: conversationState.aiUsed }, idempotencyKey: conversationState.sendKey });
    input.value = '';
    conversationState.ai = null;
    conversationState.aiUsed = false;
    conversationState.sendKey = null;
    await openConversation(c.id);
    await refreshConversationList();
    notify('Reply recorded.');
  } catch (error) { notify(error.message, true); }
  finally {
    const current = conversationState.detail;
    button.disabled = !current || current.status !== 'open' || Boolean(current.customer?.do_not_contact);
  }
}
async function toggleConversation() {
  const c = conversationState.detail;
  if (!c) return;
  const button = $('#toggle-conversation');
  if (button) button.disabled = true;
  try {
    const status = c.status === 'open' ? 'closed' : 'open';
    await api(`/conversations/${c.id}`, { method: 'PATCH', version: c.version, data: { status } });
    await openConversation(c.id);
    await refreshConversationList();
    notify(status === 'closed' ? 'Conversation closed.' : 'Conversation reopened.');
  } catch (error) { notify(error.message, true); }
  finally { const current = $('#toggle-conversation'); if (current) current.disabled = false; }
}
async function changeConversationAssignee(value) {
  const c = conversationState.detail;
  if (!c) return;
  try {
    await api(`/conversations/${c.id}`, { method: 'PATCH', version: c.version, data: { assigned_user_id: value || null } });
    await openConversation(c.id);
    await refreshConversationList();
    notify('Assignment updated.');
  } catch (error) { notify(error.message, true); renderConversationContext(); }
}
async function newConversationForm(prefill = {}) {
  const [customers, vehicles] = await Promise.all([choices('customers'), choices('vehicles')]);
  if (!customers.length) throw new Error('Create a customer first.');
  if (!vehicles.length) throw new Error('Add a vehicle first.');
  const customerOptions = customers.map(customer => [customer.id, `${fullName(customer)}${customer.email ? ` · ${customer.email}` : ''}`]);
  const vehicleOptions = vehicles.map(vehicle => [vehicle.id, `${vehicleName(vehicle)} · ${vehicle.stock_number}`]);
  const selectedVehicle = vehicles.some(vehicle => vehicle.id === prefill.vehicle_id) ? prefill.vehicle_id : vehicles[0].id;
  const selectedCustomer = customers.some(customer => customer.id === prefill.customer_id) ? prefill.customer_id : customers[0].id;
  dialogContext = {};
  showDialog('New conversation', `<form id="conversation-form"><div class="editor-grid">
    <label>Customer<select name="customer_id" required>${selectOptions(customerOptions, selectedCustomer)}</select></label>
    <label>Vehicle<select name="vehicle_id" required>${selectOptions(vehicleOptions, selectedVehicle)}</select></label>
    <label>Channel<select name="channel">${selectOptions([['web', 'Web'], ['email', 'Email'], ['phone', 'Phone'], ['sms', 'SMS'], ['facebook', 'Facebook'], ['whatsapp', 'WhatsApp']], 'web')}</select></label>
    <label class="wide">Customer question<textarea name="message" required maxlength="5000" placeholder="What did the customer ask about this vehicle?"></textarea></label>
  </div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Start conversation</button></div></form>`);
}
function openCustomerMessageForm() {
  const c = conversationState.detail;
  if (!c) return;
  dialogContext = { conversation: c };
  showDialog('Log customer question', `<form id="customer-message-form"><label>Customer question<textarea name="body" required maxlength="5000" placeholder="Paste or type the customer's latest question..."></textarea></label><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Log question</button></div></form>`);
}
$('#add').addEventListener('click', () => {
  if (kind === 'users') { inviteUser(); return; }
  edit().catch(error => notify(error.message, true));
});
$('#results').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  button.disabled = true;
  try {
    if (kind === 'users') {
      if (button.dataset.action === 'retry') await loadUsers();
      else if (button.dataset.action === 'edit-user') await editUser(button.dataset.id);
      else if (button.dataset.action === 'revoke-invite') {
        if (confirm('Revoke this invitation? The invited account will be disabled.')) {
          await api(`/users/invitations/${button.dataset.id}`, { method: 'DELETE' });
          notify('Invitation revoked.'); await loadUsers();
        }
      }
      return;
    }
    if (button.dataset.action === 'retry') await load();
    else if (button.dataset.action === 'view') await detail(button.dataset.id);
    else if (button.dataset.action === 'edit') await edit(button.dataset.id);
    else if (button.dataset.action === 'archive') {
      const row = rows.find(r => r.id === button.dataset.id);
      if (confirm(`Archive this ${singular[kind]}? It will leave active lists; its history will be retained.`)) { await api(`/${kind}/${row.id}`, { method: 'DELETE', version: row.version }); notify('Record archived.'); await load(); }
    }
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
$('#new-conversation').addEventListener('click', () => { newConversationForm().catch(error => notify(error.message, true)); });
let conversationSearchTimer;
$('#conversation-search').addEventListener('input', event => {
  clearTimeout(conversationSearchTimer);
  conversationSearchTimer = setTimeout(() => {
    if (kind !== 'conversations') return;
    conversationState.search = event.target.value.trim();
    conversationState.page = 1;
    loadConversations().catch(error => notify(error.message, true));
  }, 250);
});
$('#conversation-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-filter]');
  if (!tab) return;
  conversationState.filter = tab.dataset.filter;
  conversationState.page = 1;
  loadConversations().catch(error => notify(error.message, true));
});
$('#conversation-list').addEventListener('click', event => {
  const item = event.target.closest('[data-conversation-id]');
  if (item) openConversation(item.dataset.conversationId);
});
$('#conversation-pagination').addEventListener('click', event => {
  const button = event.target.closest('[data-conv-page]');
  if (!button || button.disabled) return;
  conversationState.page = Number(button.dataset.convPage);
  loadConversations().catch(error => notify(error.message, true));
});
$('#conversation-actions').addEventListener('click', event => {
  if (event.target.closest('#toggle-conversation')) toggleConversation();
});
$('#ai-suggestion-panel').addEventListener('click', event => {
  const button = event.target.closest('[data-ai]');
  if (!button) return;
  if (button.dataset.ai === 'regenerate') { requestAiSuggestion(); return; }
  const ai = conversationState.ai;
  if (!ai) return;
  const input = $('#message-input');
  input.value = ai.draft;
  input.focus();
  conversationState.aiUsed = true;
  conversationState.sendKey = null;
  $('#ai-suggestion-panel').hidden = true;
  $('#composer-status').textContent = 'AI-assisted draft. Review and edit before sending.';
});
$('#ai-reply-btn').addEventListener('click', () => requestAiSuggestion());
$('#send-reply-btn').addEventListener('click', () => sendReply());
$('#log-customer-message').addEventListener('click', openCustomerMessageForm);
$('#message-input').addEventListener('input', () => { conversationState.sendKey = null; });
$('#conversation-context').addEventListener('change', event => {
  if (event.target.id === 'conversation-assignee') changeConversationAssignee(event.target.value);
});
$('#dialog-content').addEventListener('click', event => {
  const button = event.target.closest('[data-action="start-conversation"]');
  if (!button) return;
  const vehicleId = button.dataset.id;
  closeDialog();
  showConversationView();
  loadConversations().catch(error => notify(error.message, true));
  newConversationForm({ vehicle_id: vehicleId }).catch(error => notify(error.message, true));
});
function closeDialog() { $('#editor').close(); for (const url of photoUrls) URL.revokeObjectURL(url); photoUrls = []; }
$('#editor').addEventListener('close', () => { for (const url of photoUrls) URL.revokeObjectURL(url); photoUrls = []; });
function showDialog(heading, content) {
  $('#dialog-content').innerHTML = `<header class="dialog-header"><h2 id="dialog-title">${esc(heading)}</h2><button class="secondary-btn" data-close aria-label="Close dialog">Close</button></header>${content}`;
  if (!$('#editor').open) $('#editor').showModal();
}
$('#editor').addEventListener('click', event => { if (event.target.closest('[data-close]')) closeDialog(); });
async function choices(type) {
  const records = []; let number = 1;
  do { const result = await api(`/${type}?page_size=100&page=${number}`); records.push(...result.data); if (number >= result.meta.total_pages) break; number++; } while (true);
  return records;
}
const field = (name, label, type = 'text', required = false, options) => ({ name, label, type, required, options });
async function edit(id) {
  const editKind = kind;
  if (editKind === 'vehicles' && !canWriteInventory()) throw new Error('Inventory changes require manager access.');
  const record = id ? (await api(`/${editKind}/${id}`)).data : {};
  let fields;
  if (editKind === 'vehicles') {
    fields = [field('vin', 'VIN (required unless draft)'), field('stock_number', 'Stock number', 'text', true), field('year', 'Year', 'number', true), field('make', 'Make', 'text', true), field('model', 'Model', 'text', true), field('trim', 'Trim'), field('status', 'Status', 'select', true, [...statuses.vehicles]), field('body_type', 'Body type', 'select', false, ['Sedan', 'SUV', 'Truck', 'Coupe', 'Van / Minivan', 'Convertible']), field('mileage', 'Mileage (mi)', 'number', true), field('list_price', 'List price ($)', 'money', true), field('condition', 'Condition', 'select', true, ['used', 'new', 'certified']), field('fuel_type', 'Fuel type', 'select', false, ['Gasoline', 'Hybrid', 'Electric', 'Diesel', 'Plug-in Hybrid']), field('transmission', 'Transmission'), field('drivetrain', 'Drivetrain'), field('exterior_color', 'Exterior color'), field('interior_color', 'Interior color'), field('body_style', 'Body style'), field('acquired_at', 'Acquisition date', 'date'), field('acquisition_source', 'Acquisition source'), field('location', 'Location'), field('description', 'Description', 'textarea')];
    if (['owner', 'manager'].includes(actor.role)) fields.push(field('purchase_cost', 'Purchase cost ($)', 'money'), field('minimum_price', 'Minimum price ($)', 'money'), field('internal_notes', 'Internal notes', 'textarea'));
  } else {
    const [vehicles, users] = await Promise.all([choices('vehicles'), manager() ? api('/users') : Promise.resolve({ data: [] })]);
    const vehicleOptions = vehicles.map(v => [v.id, `${vehicleName(v)} · ${title(v.status)}`]);
    const userOptions = users.data.map(u => [u.id, u.name]);
    const assignment = manager() ? [field('assigned_user_id', 'Assigned salesperson', 'select', false, userOptions)] : [];
    if (editKind === 'customers') fields = [field('first_name', 'First name', 'text', true), field('last_name', 'Last name'), field('email', 'Email', 'email'), field('phone', 'Phone', 'tel'), field('preferred_language', 'Preferred language'), field('lead_source', 'Source'), field('status', 'Status', 'select', true, [...statuses.customers]), field('interested_vehicle_id', 'Interested vehicle', 'select', false, vehicleOptions), ...assignment, field('do_not_contact', 'Do not contact', 'checkbox')];
    else {
      const customers = await choices('customers');
      if (record.customer && !customers.some(customer => customer.id === record.customer.id)) customers.push(record.customer);
      const transitions = { new: ['new', 'working', 'qualified', 'lost'], working: ['working', 'qualified', 'lost'], qualified: ['qualified', 'working', 'won', 'lost'], won: ['won'], lost: ['lost', ...(['owner', 'manager'].includes(actor.role) ? ['working'] : [])] };
      fields = [field('customer_id', 'Customer', 'select', true, customers.map(c => [c.id, `${fullName(c)}${c.email ? ` · ${c.email}` : ''}`])), field('vehicle_id', 'Interested vehicle', 'select', false, vehicleOptions), field('source', 'Source', 'text', true), field('status', 'Stage', 'select', true, id ? transitions[record.status] : ['new']), field('priority', 'Priority', 'select', true, ['normal', 'high', 'low']), ...assignment, field('external_lead_id', 'External lead ID'), field('message', 'Customer message', 'textarea'), field('lost_reason', 'Lost reason (required when lost)', 'textarea'), field('reopen_reason', 'Reopen reason (required when reopening lost)', 'textarea')];
    }
  }
  const defaults = { status: editKind === 'vehicles' ? 'available' : 'new', mileage: 0, preferred_language: 'en', condition: 'used', priority: 'normal' };
  for (const f of fields) if (f.type === 'select' && record[f.name] && !f.options.some(o => (Array.isArray(o) ? o[0] : o) === record[f.name])) f.options.push([record[f.name], `${record[f.name]} (current / archived)`]);
  if (kind !== editKind || !actor) return;
  dialogContext = { kind: editKind, record, fields };
  showDialog(`${id ? 'Edit' : 'Add'} ${singular[editKind]}`, `<form id="record-form"><div class="editor-grid">${fields.map(f => {
    const value = record[f.name] ?? defaults[f.name] ?? ''; const attrs = `name="${f.name}" ${f.required ? 'required' : ''}`;
    const control = f.type === 'select' ? `<select ${attrs}>${selectOptions(f.options, value, f.required ? 'Select…' : 'None')}</select>` : f.type === 'textarea' ? `<textarea ${attrs}>${esc(value)}</textarea>` : f.type === 'checkbox' ? `<input type="checkbox" ${attrs} ${value ? 'checked' : ''}>` : `<input ${attrs} type="${f.type === 'money' ? 'number' : f.type}" value="${esc(value)}" ${['number', 'money'].includes(f.type) ? `min="${f.name === 'year' ? 1900 : 0}" step="${f.type === 'money' ? '0.01' : '1'}"` : ''}>`;
    return `<label class="${f.type === 'textarea' ? 'wide' : ''}">${esc(f.label)}${f.required ? ' *' : ''}${control}</label>`;
  }).join('')}</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Save ${singular[editKind]}</button></div></form>`);
}
async function editUser(id) {
  const record = rows.find(row => row.id === id);
  if (!record) throw new Error('This user is no longer in the list. Reload and try again.');
  const roles = (actor.role === 'owner' ? [...userRoles] : userRoles.filter(role => role !== 'owner')).map(role => [role, roleLabel(role)]);
  const fields = [field('name', 'Name', 'text', true), field('role', 'Role', 'select', true, roles)];
  if (record.status !== 'invited') fields.push(field('status', 'Status', 'select', true, ['active', 'disabled']));
  dialogContext = { kind: 'users', record, fields };
  showDialog('Edit user', `<form id="record-form"><div class="editor-grid">${fields.map(f => {
    const value = record[f.name] ?? ''; const attrs = `name="${f.name}" ${f.required ? 'required' : ''}`;
    const control = f.type === 'select' ? `<select ${attrs}>${selectOptions(f.options, value, f.required ? 'Select…' : 'None')}</select>` : `<input ${attrs} type="${f.type}" value="${esc(value)}">`;
    return `<label>${esc(f.label)}${f.required ? ' *' : ''}${control}</label>`;
  }).join('')}</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Save user</button></div></form>`);
}
function inviteUser() {
  const roles = (actor.role === 'owner' ? [...userRoles] : userRoles.filter(role => role !== 'owner')).map(role => [role, roleLabel(role)]);
  dialogContext = {};
  showDialog('Invite user', `<form id="invite-form"><div class="editor-grid"><label>Email<input name="email" type="email" required></label><label>Name<input name="name"></label><label>Role<select name="role">${selectOptions(roles, 'sales')}</select></label></div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Create invitation</button></div></form>`);
}
function showInvitation(invitation) {
  dialogContext = {};
  const url = `${location.origin}${location.pathname}#accept?token=${encodeURIComponent(invitation.token)}`;
  showDialog('Invitation created', `<p class="muted">Send this link to ${esc(invitation.email)}. It expires ${esc(formatDateTime(invitation.expires_at))} and can be used once.</p><label>Invitation link<textarea readonly rows="2">${esc(url)}</textarea></label><label>Acceptance token<textarea readonly rows="2">${esc(invitation.token)}</textarea></label><div class="dialog-actions"><button class="blue-btn" type="button" data-close>Done</button></div>`);
}
$('#editor').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
  const errorArea = event.target.querySelector('.form-error'); if (errorArea) errorArea.textContent = '';
  try {
    if (event.target.id === 'record-form') {
      const context = dialogContext; const formData = new FormData(event.target); const data = {};
      for (const f of context.fields) {
        const value = formData.get(f.name);
        if (f.type === 'checkbox') data[f.name] = formData.has(f.name);
        else if (['money', 'number'].includes(f.type)) { if (value !== '') data[f.name] = Number(value); else if (context.record.id && f.type === 'money' && !f.required) data[f.name] = null; }
        else if ((f.name.endsWith('_id') || f.name === 'acquired_at') && value === '') data[f.name] = null;
        else if (value !== '' || !f.options || context.record[f.name]) data[f.name] = value;
      }
      const result = await api(`/${context.kind}${context.record.id ? `/${context.record.id}` : ''}`, { method: context.record.id ? 'PATCH' : 'POST', data, version: context.record.id ? context.record.version : undefined });
      closeDialog();
      if (context.kind === 'users') { notify('User updated.'); await loadUsers(); }
      else { notify(result.meta.duplicate_candidates?.length ? `Saved. Possible duplicate customers: ${result.meta.duplicate_candidates.map(fullName).join(', ')}. Review before contacting.` : 'Saved successfully.'); await load(); }
    } else if (event.target.id === 'invite-form') {
      const formData = new FormData(event.target);
      const name = String(formData.get('name') || '').trim();
      const result = await api('/users/invitations', { method: 'POST', data: { email: formData.get('email'), role: formData.get('role'), ...(name ? { name } : {}) } });
      closeDialog(); showInvitation(result.data); notify('Invitation created. Share the token securely.'); await loadUsers();
    } else if (event.target.id === 'conversation-form') {
      const data = Object.fromEntries(new FormData(event.target));
      const result = await api('/conversations', { method: 'POST', data });
      closeDialog();
      notify('Conversation started.');
      conversationState.filter = 'all';
      conversationState.search = '';
      conversationState.page = 1;
      $('#conversation-search').value = '';
      showConversationView();
      await refreshConversationList();
      await openConversation(result.data.id);
    } else if (event.target.id === 'customer-message-form') {
      const conversation = dialogContext.conversation;
      await api(`/conversations/${conversation.id}/messages`, { method: 'POST', data: { body: event.target.elements.body.value, direction: 'inbound' } });
      closeDialog();
      notify('Customer question logged.');
      await openConversation(conversation.id);
      await refreshConversationList();
    } else if (event.target.id === 'note-form') {
      const id = dialogContext.record.id;
      await api(`/customers/${id}/notes`, { method: 'POST', data: { note_text: event.target.elements.note_text.value, is_pinned: event.target.elements.is_pinned.checked } }); notify('Note added.'); await detail(id);
    } else if (event.target.id === 'photo-form') {
      const file = event.target.elements.file.files[0];
      if (!file || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG or PNG image of at most 10 MB.');
      const form = new FormData(); form.append('file', file);
      const id = dialogContext.record.id; await api(`/vehicles/${id}/media`, { method: 'POST', form }); notify('Photo uploaded.'); await detail(id);
    }
  } catch (error) { if (errorArea) errorArea.textContent = error.message; else notify(error.message, true); }
  finally { if (button) button.disabled = false; }
});
async function detail(id) {
  const detailKind = kind;
  const [result, history] = await Promise.all([api(`/${detailKind}/${id}`), api(`/${detailKind}/${id}/activity`)]);
  if (kind !== detailKind || !actor) return;
  const record = result.data; dialogContext = { kind: detailKind, record };
  for (const url of photoUrls) URL.revokeObjectURL(url); photoUrls = [];
  const writable = detailKind === 'vehicles' ? canWriteInventory() : canWriteRecords();
  const fields = Object.entries(record).filter(([key, value]) => !['organization_id', 'id', 'version', 'notes', 'media', 'archived_at', 'customer_id', 'vehicle_id', 'interested_vehicle_id', 'assigned_user_id'].includes(key) && typeof value !== 'object');
  if (record.customer) fields.unshift(['Customer', fullName(record.customer)]);
  if (record.vehicle || record.interested_vehicle) fields.unshift(['Interested vehicle', vehicleName(record.vehicle || record.interested_vehicle)]);
  if (record.assigned_user) fields.push(['Assigned salesperson', record.assigned_user.name]);
  let extra = '';
  if (detailKind === 'customers') {
    extra = `<h3>Notes</h3>${record.notes.length ? record.notes.map(note => `<div class="note">${note.is_pinned ? '📌 ' : ''}${esc(note.note_text)}<small>${esc(note.author_name || 'Unknown author')} · ${esc(formatDateTime(note.created_at))}</small></div>`).join('') : '<p class="muted">No notes yet.</p>'}${writable ? '<form id="note-form"><label>Add a note<textarea name="note_text" required maxlength="10000"></textarea></label><label><input type="checkbox" name="is_pinned">Pin note</label><p class="form-error" role="alert"></p><button class="blue-btn">Add note</button></form>' : ''}<p><a href="#leads?customer_id=${record.id}">View all ${record.lead_count} linked leads</a></p>`;
  } else if (detailKind === 'vehicles') {
    extra = `<h3>Photos (${record.media.length}/10)</h3><div id="photos" class="photos"></div>${writable ? '<form id="photo-form"><label>JPEG or PNG · up to 10 MB<input name="file" type="file" accept="image/jpeg,image/png" required></label><p class="form-error" role="alert"></p><button class="blue-btn">Upload photo</button></form>' : ''}<p><button class="secondary-btn" type="button" data-action="start-conversation" data-id="${record.id}">Start conversation</button> <a href="#leads?vehicle_id=${record.id}">View linked leads</a></p>`;
  }
  showDialog(detailKind === 'vehicles' ? vehicleName(record) : detailKind === 'customers' ? fullName(record) : 'Lead details', `<dl class="record-fields">${fields.map(([key, value]) => `<div><dt>${esc(title(key))}</dt><dd>${esc(displayValue(key, value))}</dd></div>`).join('')}</dl>${extra}<h3>Activity</h3><ol class="history">${history.data.map(item => `<li><strong>${esc(title(item.action))}</strong> · ${esc(formatDateTime(item.created_at))}<br>${esc(Object.entries(item.changes).map(([key, value]) => `${title(key)}: ${value && typeof value === 'object' ? `${value.before ?? '—'} → ${value.after ?? '—'}` : value}`).join('; '))}</li>`).join('')}</ol>`);
  if (detailKind === 'vehicles') {
    for (const media of record.media) {
      try {
        const blob = await api(`/vehicles/${id}/media/${media.id}`, { raw: true });
        if (!$('#editor').open || dialogContext.record.id !== id) return;
        const url = URL.createObjectURL(blob); photoUrls.push(url);
        const figure = document.createElement('figure'); const img = document.createElement('img'); img.src = url; img.alt = `${vehicleName(record)} photo`; figure.append(img);
        if (writable) { const remove = document.createElement('button'); remove.className = 'secondary-btn danger'; remove.textContent = 'Remove photo'; remove.addEventListener('click', async () => { if (!confirm('Remove this photo?')) return; remove.disabled = true; try { await api(`/vehicles/${id}/media/${media.id}`, { method: 'DELETE' }); await detail(id); } catch (error) { notify(error.message, true); remove.disabled = false; } }); figure.append(remove); }
        $('#photos').append(figure);
      } catch (error) { notify(`Photo could not be loaded: ${error.message}`, true); }
    }
  }
}
const initialAccept = acceptParams();
if (initialAccept !== null) showAccept(initialAccept);
else if (token) start().catch(error => { signOut(); notify(error.message, true); });
