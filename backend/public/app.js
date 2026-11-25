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
const mileageLabel = value => Number.isFinite(value) ? `${value.toLocaleString()} mi` : 'Mileage unknown';
const fullName = row => [row?.first_name, row?.last_name].filter(Boolean).join(' ');
const vehicleName = row => row ? [row.year, row.make, row.model, row.trim].filter(Boolean).join(' ') : '—';
const conversationName = conversation => conversation.inquiry_name || fullName(conversation.customer) || 'Unknown customer';
const initials = row => `${row?.first_name?.[0] || ''}${row?.last_name?.[0] || ''}`.toUpperCase() || '?';
const nameInitials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
const avatarTone = value => ['av-blue', 'av-pink', 'av-green', 'av-img'][Math.abs([...String(value || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % 4];
const statuses = { vehicles: ['draft', 'available', 'pending', 'reserved', 'in_transit', 'sold'], customers: ['new', 'contacted', 'qualified', 'appointment', 'won', 'lost'], leads: ['new', 'working', 'qualified', 'won', 'lost'] };
const moduleNames = { vehicles: 'Inventory', customers: 'Customers', leads: 'Leads', conversations: 'Conversations', users: 'Users' };
const singular = { vehicles: 'vehicle', customers: 'customer', leads: 'lead', users: 'user' };
const vehicleMakes = ['Acura','Audi','BMW','Buick','Cadillac','Chevrolet','Chrysler','Dodge','Ferrari','Fiat','Ford','Genesis','GMC','Honda','Hummer','Hyundai','Infiniti','Isuzu','Jaguar','Jeep','Kia','Land Rover','Lexus','Lincoln','Lotus','Lucid','Maserati','Mazda','McLaren','Mercedes-Benz','MG','MINI','Mitsubishi','Nissan','Other','Pagani','Porsche','Ram','Rivian','Rolls-Royce','Subaru','Suzuki','Tesla','Toyota','Volkswagen','Volvo'];
const transmissions = ['Automatic', 'Manual', 'CVT', 'eCVT', 'Other', 'Unknown'];
const mileageSources = ['CARFAX', 'Dealer', 'Other', 'Unknown'];
const hybridBatteryStatuses = [['unknown', 'Unknown'], ['inspected_good', 'Inspected — good condition'], ['needs_attention', 'Needs attention'], ['replaced', 'Replaced']];
const smogStatuses = [['unknown', 'Unknown'], ['passed', 'Passed'], ['not_passed', 'Not passed']];
const acStatuses = [['unknown', 'Unknown'], ['works', 'Works / blows cold'], ['not_working', 'Not working / needs attention']];
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
const thumbnailUrls = new Set();
function clearThumbnails() {
  for (const url of thumbnailUrls) URL.revokeObjectURL(url);
  thumbnailUrls.clear();
}
async function loadThumbnail(img) {
  try {
    const blob = await api(img.dataset.photo, { raw: true });
    if (!img.isConnected || !actor || kind !== 'vehicles') return;
    const url = URL.createObjectURL(blob);
    thumbnailUrls.add(url);
    img.src = url;
  } catch { if (img.isConnected) img.alt = 'Photo unavailable'; }
}
const conversationState = { items: [], selectedId: null, detail: null, page: 1, totalPages: 1, total: 0, filter: 'all', search: '', channel: '', assignee: '', counts: { total: 0, open: 0, closed: 0, unread: 0 }, users: null };
const replyDrafts = new Map();
let threadRequest = 0, listRequest = 0;
function draftFor(id) {
  if (!replyDrafts.has(id)) replyDrafts.set(id, { body: '', ai: null, aiUsed: false, sendKey: null, sending: false, generating: false });
  return replyDrafts.get(id);
}
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let noticeTimer;
function notify(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 8000 : 4000);
}
$('#notice').addEventListener('click', () => {
  clearTimeout(noticeTimer);
  $('#notice').hidden = true;
});
async function api(path, { method = 'GET', data, version, form, raw = false, idempotencyKey } = {}) {
  const headers = {};
  if (token && !path.startsWith('/public/')) headers.Authorization = `Bearer ${token}`;
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
    if (response.status === 401 && path !== '/auth/login' && headers.Authorization === `Bearer ${token}`) signOut();
    const error = new Error([result.error.message, ...Object.entries(result.error.field_errors || {}).map(([key, value]) => `${title(key)}: ${value}`)].join('\n'));
    error.code = result.error.code; error.candidates = result.error.duplicate_candidates; throw error;
  }
  return result;
}
function signOut() {
  clearThumbnails();
  generation++; token = null; actor = null; sessionStorage.removeItem('dealer-token');
  conversationState.items = []; conversationState.selectedId = null; conversationState.detail = null; replyDrafts.clear(); threadRequest++; listRequest++; $('#message-input').value = ''; conversationState.users = null; conversationState.filter = 'all'; conversationState.search = '';
  closeDialog(); $('#catalog').hidden = true; $('#workspace').hidden = true; $('#accept').hidden = true; $('#inquiry').hidden = true; $('#login').hidden = false; $('#login-form').elements.password.value = '';
}
const acceptParams = () => {
  const [path, query] = location.hash.slice(1).split('?');
  return path === 'accept' ? new URLSearchParams(query || '') : null;
};
const inquiryParams = () => {
  const [path, query] = location.hash.slice(1).split('?');
  return path === 'inquiry' ? new URLSearchParams(query || '') : null;
};
let catalogRequest = 0;
async function showCatalog(params) {
  const request = ++catalogRequest;
  if ($('#editor').open) closeDialog();
  $('#workspace').hidden = true; $('#accept').hidden = true; $('#inquiry').hidden = true; $('#login').hidden = true;
  $('#catalog').hidden = false;
  const results = $('#catalog-results');
  const pages = $('#catalog-pages');
  pages.hidden = true;
  results.innerHTML = '<p class="muted">Loading vehicles…</p>';
  const page = Number(params.get('page') || 1);
  try {
    const { data, meta } = await api(`/public/vehicles?page=${Number.isInteger(page) && page > 0 ? page : 1}`);
    if (request !== catalogRequest || $('#catalog').hidden) return;
    if (meta.page > Math.max(1, meta.total_pages)) {
      location.replace(`#browse?page=${Math.max(1, meta.total_pages)}`);
      return;
    }
    results.innerHTML = data.length ? `<ul class="catalog-list">${data.map(vehicle => {
      const details = [mileageLabel(vehicle.mileage), vehicle.body_type, vehicle.fuel_type].filter(Boolean);
      return `<li><div><h2>${esc(vehicleName(vehicle))}</h2><p class="muted">${esc(details.join(' · '))}</p></div>
        <strong class="catalog-price">${esc(money(vehicle.list_price))}</strong>
        <a class="secondary-btn" href="#inquiry?vehicle_id=${encodeURIComponent(vehicle.id)}" aria-label="View ${esc(vehicleName(vehicle))} and ask a question">View &amp; inquire</a></li>`;
    }).join('')}</ul>` : '<p class="empty">There are no available vehicles at the moment.</p>';
    if (meta.total_pages > 1) {
      pages.innerHTML = `${meta.page > 1 ? `<a href="#browse?page=${meta.page - 1}">Previous</a>` : ''}
        <span>Page ${meta.page} of ${meta.total_pages}</span>
        ${meta.page < meta.total_pages ? `<a href="#browse?page=${meta.page + 1}">Next</a>` : ''}`;
      pages.hidden = false;
    }
  } catch (error) {
    if (request !== catalogRequest || $('#catalog').hidden) return;
    results.innerHTML = '<p class="empty">Unable to load available vehicles. <button type="button" class="secondary-btn">Try again</button></p>';
    results.querySelector('button').addEventListener('click', () => showCatalog(params));
  }
}
function showAccept(params) {
  closeDialog();
  $('#login').hidden = true; $('#workspace').hidden = true; $('#inquiry').hidden = true; $('#accept').hidden = false;
  $('#accept-form').elements.token.value = params.get('token') || '';
  $('#accept-form').elements.name.focus();
}
function currentInquiry(submissionId) {
  return inquiryParams() !== null && $('#inquiry-form').elements.submission_id.value === submissionId;
}
async function showInquiry(params) {
  closeDialog();
  $('#login').hidden = true; $('#accept').hidden = true; $('#workspace').hidden = true; $('#inquiry').hidden = false;
  const vehicleId = params.get('vehicle_id') || '';
  const form = $('#inquiry-form');
  const success = $('#inquiry-success');
  form.reset();
  form.elements.vehicle_id.value = vehicleId;
  const submissionId = uuid();
  form.elements.submission_id.value = submissionId;
  form.querySelector('[type="submit"]').disabled = false;
  form.hidden = false;
  success.hidden = true;
  form.querySelector('.form-error').textContent = '';
  const summary = $('#inquiry-vehicle');
  summary.innerHTML = '<p class="muted">Loading vehicle…</p>';
  if (!vehicleId) {
    summary.innerHTML = '<p class="empty">This inquiry link is missing a vehicle.</p>';
    form.hidden = true;
    return;
  }
  try {
    const result = await api(`/public/vehicles/${encodeURIComponent(vehicleId)}`);
    if (!currentInquiry(submissionId)) return;
    const vehicle = result.data;
    summary.innerHTML = `<span class="vehicle-title">${esc(vehicleName(vehicle))}</span><span class="sub">${esc([money(vehicle.list_price), mileageLabel(vehicle.mileage), title(vehicle.status)].filter(Boolean).join(' · '))}</span><p class="muted">${esc(vehicle.description || 'Ask our team about this vehicle.')}</p>`;
  } catch (error) {
    if (!currentInquiry(submissionId)) return;
    summary.innerHTML = '<p class="empty">This inquiry link is invalid or the vehicle is no longer available.</p>';
    form.hidden = true;
    notify(error.message, true);
  }
}
async function start() {
  const session = token;
  const result = await api('/me');
  if (session !== token) return;
  actor = result.data;
  if (['browse', 'inquiry', 'accept'].includes(location.hash.slice(1).split('?')[0])) return;
  if (location.hash === '#login') history.replaceState(null, '', `${location.pathname}#vehicles`);
  $('#login').hidden = true; $('#accept').hidden = true; $('#inquiry').hidden = true; $('#workspace').hidden = false;
  $('#user-label').innerHTML = `<strong>${esc(actor.name)}</strong><span class="user-role">${esc(roleLabel(actor.role))}</span><span class="user-email">${esc(actor.email)}</span>`;
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
$('#inquiry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const errorArea = form.querySelector('.form-error');
  errorArea.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  data.consent = form.elements.consent.checked;
  if (!data.email && !data.phone) { errorArea.textContent = 'Enter an email or phone number.'; return; }
  if (data.preferred_contact === 'email' && !data.email) { errorArea.textContent = 'Enter an email for your preferred contact.'; return; }
  if (data.preferred_contact === 'phone' && !data.phone) { errorArea.textContent = 'Enter a phone number for your preferred contact.'; return; }
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api('/public/inquiries', { method: 'POST', data });
    if (!currentInquiry(data.submission_id)) return;
    form.hidden = true;
    const success = $('#inquiry-success');
    success.hidden = false;
    success.innerHTML = `<h2>Thank you, ${esc(data.name.trim())}</h2><p>We received your question. Reference: <strong>${esc(result.data.reference)}</strong>.</p><p class="muted">Our team will follow up using your preferred contact. This does not confirm availability or an appointment.</p>`;
  } catch (error) { if (currentInquiry(data.submission_id)) errorArea.textContent = error.message; }
  finally { if (currentInquiry(data.submission_id)) button.disabled = false; }
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
  generation++; threadRequest++; listRequest++; clearThumbnails();
  closeDialog();
  const [module, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  $('#list-search').value = params.get('q') || '';
  $('#list-search').placeholder = `Search ${(moduleNames[module] || 'Inventory').toLowerCase()}`;
  $('#standard-view').hidden = false;
  $('#conversation-view').hidden = true;
  if (module === 'users') {
    if (!manager()) { location.hash = '#vehicles'; return; }
    kind = 'users';
    page = Math.max(1, Number(params.get('page')) || 1); params.delete('page'); filters = Object.fromEntries(params);
    $('#page-title').textContent = 'Users'; $('#add').textContent = '+ Invite user'; $('#add').hidden = false;
    $('#description').textContent = 'Manage staff roles, invitations and account status.';
    document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.hash === '#users'));
    $('#filters').innerHTML = `<div class="filter-grid">${filterField('role', 'Role', userRoles.map(role => [role, roleLabel(role)])) + filterField('status', 'Status', userStatuses)}<button class="filter-btn" type="submit">Apply filters</button><button class="filter-btn" type="button" id="reset">Reset</button></div>`;
    await loadUsers();
    return;
  }
  if (module === 'conversations') {
    conversationState.search = params.get('q') || '';
    conversationState.channel = params.get('channel') || '';
    conversationState.assignee = params.get('assignee') || '';
    conversationState.filter = params.get('filter') || 'all';
    conversationState.page = Math.max(1, Number(params.get('page')) || 1);
    $('#conversation-search').value = conversationState.search;
    $('#channel-filter').value = conversationState.channel;
    showConversationView();
    await loadConversations();
    return;
  }
  kind = Object.hasOwn(moduleNames, module) ? module : 'vehicles';
  page = Math.max(1, Number(params.get('page')) || 1); params.delete('page'); filters = Object.fromEntries(params);
  $('#page-title').textContent = moduleNames[kind]; $('#add').textContent = `+ Add ${singular[kind]}`;
  $('#add').hidden = kind === 'vehicles' ? !canWriteInventory() : !canWriteRecords();
  $('#description').textContent = { vehicles: 'Manage vehicles, pricing and availability.', customers: 'Keep customer identity, interests and notes together.', leads: 'Track purchase opportunities and their next stage.' }[kind];
  document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.hash === `#${kind}`));
  const moreFilters = kind === 'vehicles'
    ? filterField('model', 'Model') + filterField('year', 'Year') + filterField('body_type', 'Body type', ['Sedan', 'SUV', 'Truck', 'Coupe', 'Van / Minivan', 'Convertible']) + filterField('price_min', 'Min price') + filterField('price_max', 'Max price')
    : '';
  const advancedActive = ['model', 'year', 'body_type', 'price_min', 'price_max'].some(key => filters[key]);
  const commonFilters = filterField('status', 'Status', statuses[kind])
    + (kind === 'vehicles' ? filterField('make', 'Make', vehicleMakes) : filterField('source', 'Source'))
    + (kind === 'leads' ? filterField('priority', 'Priority', ['low', 'normal', 'high']) : '');
  $('#filters').innerHTML = `<div class="filter-grid">${commonFilters}<button class="filter-btn" type="submit">Apply</button><button class="filter-btn" type="button" id="reset">Reset</button></div>
    ${moreFilters ? `<details class="extra-filters" ${advancedActive ? 'open' : ''}><summary>More filters</summary><div class="filter-grid">${moreFilters}</div></details>` : ''}`;
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
function renderLocation() {
  const [path, query] = location.hash.slice(1).split('?');
  if (path === 'browse' || (!path && !token)) { showCatalog(new URLSearchParams(query)); return; }
  $('#catalog').hidden = true;
  const accept = acceptParams();
  if (accept !== null) { showAccept(accept); return; }
  const inquiry = inquiryParams();
  if (inquiry !== null) { showInquiry(inquiry); return; }
  $('#accept').hidden = true; $('#inquiry').hidden = true;
  if (actor) {
    $('#login').hidden = true; $('#workspace').hidden = false;
    route().catch(error => notify(error.message, true));
  } else if (token) start().catch(error => { signOut(); notify(error.message, true); });
  else { $('#workspace').hidden = true; $('#login').hidden = false; }
}
window.addEventListener('hashchange', renderLocation);
const badgeTone = { available: 'green', won: 'green', active: 'green', open: 'green', qualified: 'blue', invited: 'blue', contacted: 'blue', appointment: 'blue', new: 'blue', reserved: 'blue', pending: 'orange', working: 'orange', in_transit: 'orange', high: 'red', normal: 'blue', low: 'gray', lost: 'gray', sold: 'gray', disabled: 'gray', draft: 'gray', closed: 'gray' };
const badge = status => `<span class="badge ${badgeTone[status] || 'blue'}">${esc(title(status))}</span>`;
async function load() {
  const sequence = ++generation;
  clearThumbnails();
  $('#results').innerHTML = '<p class="empty">Loading…</p>'; $('#previous').disabled = $('#next').disabled = true;
  try {
    const params = new URLSearchParams({ ...filters, page, page_size: 10 });
    const [result, summary] = await Promise.all([api(`/${kind}?${params}`), api('/summary')]);
    if (sequence !== generation) return;
    rows = result.data; totalPages = result.meta.total_pages;
    if (page > Math.max(1, totalPages)) { navigate(filters, Math.max(1, totalPages)); return; }
    const counts = summary.data[kind];
    const highlights = kind === 'vehicles'
      ? [['Available', counts.by_status.available || 0], ['Pending', counts.by_status.pending || 0], ['Sold', counts.by_status.sold || 0]]
      : kind === 'customers'
        ? [['New', counts.by_status.new || 0], ['Qualified', counts.by_status.qualified || 0], ['Won', counts.by_status.won || 0]]
        : [['Working', counts.by_status.working || 0], ['Qualified', counts.by_status.qualified || 0], ['Won', counts.by_status.won || 0]];
    $('#stats').innerHTML = [['Total', counts.total], ...highlights].map(([label, value]) => `<div class="stat"><h3>${label}</h3><strong>${value}</strong></div>`).join('');
    const headings = kind === 'vehicles' ? ['Photo', 'Vehicle', 'Stock #', 'Mileage', 'Price', 'Status'] : kind === 'customers' ? ['Customer', 'Contact', 'Interested Vehicle', 'Source', 'Last Updated', 'Status'] : ['Customer', 'Vehicle', 'Source', 'Priority', 'Stage'];
    $('#results').innerHTML = rows.length ? `<table class="data-table"><thead><tr>${[...headings, 'Actions'].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
      const cells = kind === 'vehicles' ? [
        row.primary_photo ? `<img class="photo" data-photo="${esc(row.primary_photo)}" alt="${esc(vehicleName(row))} primary photo">` : '<span class="muted">No photo</span>',
        `<span class="vehicle-title">${esc(vehicleName(row))}</span><span class="sub">${esc([row.body_type, row.condition, row.fuel_type].filter(Boolean).join(' · ') || 'Vehicle')}</span>`,
        `<span>${esc(row.stock_number)}</span><span class="sub">${esc(row.vin || 'Draft — no VIN')}</span>`,
        mileageLabel(row.mileage),
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
        `<button class="icon-btn" data-action="view" data-id="${row.id}" title="View details" aria-label="View details">View</button>`,
        canEditRow ? `<button class="icon-btn" data-action="edit" data-id="${row.id}" title="Edit" aria-label="Edit">Edit</button>` : '',
        canWriteInventory() ? `<button class="icon-btn danger" data-action="archive" data-id="${row.id}" title="Archive" aria-label="Archive">Archive</button>` : ''
      ].join('');
      return `<tr>${cells.map((value, index) => `<td data-label="${headings[index]}">${value}</td>`).join('')}<td>${actions}</td></tr>`;
    }).join('')}</tbody></table>` : `<p class="empty">${Object.values(filters).some(Boolean) ? 'No matching records. Adjust your filters or select Reset.' : `No ${moduleNames[kind].toLowerCase()} records yet.${$('#add').hidden ? '' : ' Select Add ' + singular[kind] + ' to get started.'}`}</p>`;
    $('#page-info').textContent = `${result.meta.total} records · Page ${page} of ${Math.max(1, totalPages)}`;
    if (kind === 'vehicles') document.querySelectorAll('#results img[data-photo]').forEach(loadThumbnail);
    $('#previous').disabled = page <= 1; $('#next').disabled = page >= totalPages;
  } catch (error) {
    if (sequence !== generation) return;
    $('#stats').replaceChildren(); $('#page-info').textContent = '';
    $('#results').innerHTML = '<p class="empty">Unable to load records. <button class="secondary-btn" data-action="retry">Retry</button></p>'; notify(error.message, true);
  }
}
async function loadUsers() {
  const sequence = ++generation;
  clearThumbnails();
  $('#results').innerHTML = '<p class="empty">Loading…</p>'; $('#previous').disabled = $('#next').disabled = true;
  try {
    const params = new URLSearchParams({ ...filters, page, page_size: 10 });
    const result = await api(`/users?${params}`);
    if (sequence !== generation) return;
    rows = result.data; totalPages = result.meta.total_pages;
    if (page > Math.max(1, totalPages)) { navigate(filters, Math.max(1, totalPages)); return; }
    const counts = result.meta.counts || { total: 0, by_status: {} };
    $('#stats').innerHTML = [['Total', counts.total], ['Active', counts.by_status.active || 0], ['Invited', counts.by_status.invited || 0], ['Disabled', counts.by_status.disabled || 0]].map(([label, value]) => `<div class="stat"><h3>${label}</h3><strong>${value}</strong></div>`).join('');
    $('#results').innerHTML = rows.length ? `<table class="data-table"><thead><tr>${['Name', 'Role', 'Status', 'Last sign-in', 'Actions'].map(heading => `<th>${heading}</th>`).join('')}</tr></thead><tbody>${rows.map(row => {
      const editable = actor.role === 'owner' || row.role !== 'owner';
      const actions = [];
      if (editable) actions.push(`<button class="icon-btn" data-action="edit-user" data-id="${row.id}" title="Edit user" aria-label="Edit user">Edit</button>`);
      if (editable && row.status === 'invited' && row.invitation) actions.push(`<button class="icon-btn danger" data-action="revoke-invite" data-id="${row.invitation.id}" title="Revoke invitation" aria-label="Revoke invitation">Revoke</button>`);
      return `<tr><td data-label="Name"><div class="customer-cell"><span class="avatar ${avatarTone(row.id || row.name)}">${esc(nameInitials(row.name))}</span><div><span class="name">${esc(row.name)}${row.is_self ? ' (you)' : ''}</span><span class="sub">${esc(row.email)}</span></div></div></td><td data-label="Role">${roleBadge(row.role)}</td><td data-label="Status">${badge(row.status)}</td><td data-label="Last sign-in">${row.last_login_at ? `${esc(formatDate(row.last_login_at))}<span class="sub">${esc(formatTime(row.last_login_at))}</span>` : '—'}</td><td>${actions.join('')}</td></tr>`;
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
  $('#description').textContent = 'Review inquiries and record replies.';
  $('#add').hidden = true;
  $('#standard-view').hidden = true;
  $('#conversation-view').hidden = false;
  document.querySelectorAll('nav a').forEach(link => link.classList.toggle('active', link.hash === '#conversations'));
  if (location.hash.split('?')[0] !== '#conversations') history.replaceState(null, '', `${location.pathname}#conversations`);
}
async function loadConversationUsers() {
  if (!manager() || conversationState.users) return;
  const user = actor;
  const users = await choices('users', '&status=active');
  if (actor === user) conversationState.users = users;
}
async function loadConversations() {
  if (kind !== 'conversations') return;
  try {
    await loadConversationUsers();
    if (kind !== 'conversations' || !actor) return;
    const assignees = (conversationState.users || [actor]).map(user => [user.id, user.name]);
    if (actor.role !== 'sales') assignees.unshift(['unassigned', 'Unassigned']);
    $('#assignee-filter').innerHTML = selectOptions(assignees, conversationState.assignee, 'All assignees');
    const currentThread = threadRequest;
    if (!await refreshConversationList() || currentThread !== threadRequest) return;
    const selected = conversationState.items.find(item => item.id === conversationState.selectedId);
    if (selected) await openConversation(selected.id);
    else { threadRequest++; conversationState.selectedId = null; conversationState.detail = null; renderConversationEmpty(); }
  } catch (error) { notify(error.message, true); }
}
async function refreshConversationList() {
  const request = ++listRequest;
  const params = new URLSearchParams({ page: conversationState.page, page_size: 20 });
  if (conversationState.filter === 'open' || conversationState.filter === 'closed') params.set('status', conversationState.filter);
  if (conversationState.filter === 'unread') params.set('unread_only', '1');
  if (conversationState.search) params.set('q', conversationState.search);
  if (conversationState.channel) params.set('channel', conversationState.channel);
  if (conversationState.assignee) params.set('assigned_user_id', conversationState.assignee);
  const result = await api(`/conversations?${params}`);
  if (!actor || kind !== 'conversations' || request !== listRequest) return false;
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
  return true;
}
function renderConversationList() {
  const list = $('#conversation-list');
  if (!conversationState.items.length) {
    list.innerHTML = '<p class="empty">No conversations match these filters.</p>';
    return;
  }
  list.innerHTML = conversationState.items.map(item => {
    const customer = item.customer;
    const name = conversationName(item);
    const lastAt = item.last_message_at ? new Date(item.last_message_at) : null;
    const time = lastAt ? (lastAt.toDateString() === new Date().toDateString() ? formatTime(lastAt) : formatDate(lastAt)) : '';
    const preview = item.last_message_preview || 'No messages yet';
    return `<button class="conversation-person ${item.id === conversationState.selectedId ? 'active' : ''}" type="button" data-conversation-id="${item.id}">
      <span class="avatar ${avatarTone(customer?.id || name)}">${esc(nameInitials(name))}</span>
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
  const request = ++threadRequest;
  conversationState.selectedId = id;
  conversationState.detail = null;
  renderConversationEmpty();
  try {
    const result = await api(`/conversations/${id}`);
    if (request !== threadRequest || kind !== 'conversations' || !actor) return;
    conversationState.detail = result.data;
    const item = conversationState.items.find(row => row.id === id);
    if (item?.unread_count) {
      item.unread_count = 0;
      conversationState.counts.unread = Math.max(0, conversationState.counts.unread - 1);
    }
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
  const name = conversationName(c);
  $('#conversation-title').textContent = name;
  $('#conversation-subtitle').textContent = `${vehicleName(vehicle)} · ${title(c.status)} · ${title(c.channel)}`;
  $('#conversation-actions').innerHTML = `<button class="${c.status === 'open' ? 'outline-danger' : 'soft-button'}" type="button" id="toggle-conversation">${c.status === 'open' ? 'Close conversation' : 'Reopen conversation'}</button>`;
  $('#conversation-messages').innerHTML = c.messages.length ? c.messages.map(renderMessage).join('') : '<p class="empty">No messages yet.</p>';
  const messages = $('#conversation-messages');
  messages.scrollTop = messages.scrollHeight;
  const draft = draftFor(c.id);
  const blocked = Boolean(customer?.do_not_contact);
  const open = c.status === 'open';
  $('#conversation-composer').hidden = false;
  $('#message-input').value = draft.body;
  $('#message-input').disabled = !open || blocked || draft.sending;
  $('#send-reply-btn').disabled = !open || blocked || draft.sending;
  const hasQuestion = c.messages.some(message => message.direction === 'inbound');
  $('#ai-reply-btn').disabled = !hasQuestion || !open || blocked || !vehicle || draft.generating || draft.sending;
  $('#ai-reply-btn').textContent = draft.generating ? 'Generating…' : 'AI suggested reply';

  $('#composer-status').textContent = blocked
    ? 'This customer is marked do not contact. Sending and AI drafts are blocked.'
    : !open
      ? 'This conversation is closed. Reopen it to reply.'
      : !hasQuestion
        ? 'You can write the first message. AI replies become available after a customer inquiry.'
      : !vehicle
        ? 'Link a vehicle to use AI replies. Messages are recorded in the CRM; external delivery is not configured.'
        : 'AI suggestions require staff review. Messages are recorded in the CRM; external delivery is not configured.';
  renderConversationContext();
  renderAiPanel();
}
function renderMessage(message) {
  const c = conversationState.detail;
  const incoming = message.direction === 'inbound';
  const who = incoming ? conversationName(c) : (message.sender_name || 'Staff');
  const ai = message.ai_generated ? '<span class="message-ai">AI-assisted</span>' : '';
  const recorded = !incoming && message.delivery_status === 'recorded' ? ' · recorded' : '';
  return `<div class="message-group ${incoming ? 'incoming' : 'outgoing'}">
    <div class="message-row">
      ${incoming ? `<span class="mini-avatar ${avatarTone(c.customer?.id || who)}">${esc(nameInitials(who))}</span>` : ''}
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
    ? `<div class="vehicle-summary"><div class="vehicle-placeholder">${esc(vehicle.make || 'Vehicle')}<br>${esc(vehicle.model || '')}</div><div><strong>${esc(vehicleName(vehicle))}</strong><b>${money(vehicle.list_price)}</b><small>${mileageLabel(vehicle.mileage)}</small><small>${badge(vehicle.status)}</small></div></div>`
    : '<p class="muted">No vehicle linked. Link a vehicle to use AI replies.</p>';
  const leadBlock = lead
    ? `<div><strong>${esc(title(lead.status))}</strong> · ${esc(title(lead.priority || 'normal'))}</div><div class="sub">${esc(lead.source || '—')} · ${lead.assigned_user_id ? 'Assigned' : 'Unassigned'}</div><p><a class="details-link" href="#leads?customer_id=${encodeURIComponent(customer?.id || '')}">Open customer leads</a></p>`
    : '<p class="muted">No linked lead.</p>';
  $('#conversation-context').innerHTML = `<h2>Customer Details</h2>
    <div class="customer-profile-row"><span class="large-avatar ${avatarTone(customer?.id || name)}">${esc(initials(customer))}</span><div><h3>${esc(name)}</h3><small>${esc(customer?.phone || '—')}</small><small>${esc(customer?.email || '—')}</small>${customer?.do_not_contact ? '<small class="do-not-contact">Do not contact</small>' : ''}</div></div>
    <div class="customer-info-block"><label>Preferred contact</label><strong>${esc(title(customer?.preferred_contact) || 'Unspecified')}</strong></div>
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
  const ai = conversationState.detail && draftFor(conversationState.detail.id).ai;
  if (!ai || conversationState.detail.status !== 'open' || conversationState.detail.customer?.do_not_contact) { panel.hidden = true; panel.innerHTML = ''; return; }
  const notes = Array.isArray(ai.verification_notes) && ai.verification_notes.length
    ? `<ul>${ai.verification_notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>`
    : '';
  const source = ai.provider && !['local', 'policy'].includes(ai.provider)
    ? `Generated with ${esc(ai.model || 'AI')}.`
    : ai.provider === 'policy'
      ? 'Generated from dealership policy and recorded vehicle facts; staff review required.'
      : 'Generated locally from recorded vehicle facts.';
  panel.hidden = false;
  panel.innerHTML = `<h3>✦ AI draft — review before sending</h3>${ai.warning ? `<p class="ai-warning" role="status">${esc(ai.warning)}</p>` : ''}<div class="ai-draft">${esc(ai.draft)}</div>${notes}<div class="ai-note">${source}</div><div class="ai-actions"><button class="secondary-btn" type="button" data-ai="regenerate">Regenerate</button><button class="blue-btn" type="button" data-ai="use">Use draft</button></div>`;
}
async function requestAiSuggestion() {
  const c = conversationState.detail;
  if (!c) return;
  const draft = draftFor(c.id);
  if (draft.generating || draft.sending || c.status !== 'open' || c.customer?.do_not_contact || !c.messages.some(message => message.direction === 'inbound')) return;
  draft.generating = true;
  renderConversationChat();
  try {
    const result = await api(`/conversations/${c.id}/ai-suggestion`, { method: 'POST', data: { language: c.reply_language || 'en' } });
    if (conversationState.detail === c) draft.ai = result.data;
  } catch (error) { if (conversationState.detail === c) notify(error.message, true); }
  finally {
    draft.generating = false;
    if (conversationState.detail?.id === c.id) renderConversationChat();
  }
}
async function sendReply() {
  const c = conversationState.detail;
  if (!c) return;
  const draft = draftFor(c.id);
  if (draft.sending) return;
  const body = draft.body.trim();
  if (!body) { notify('Enter a reply before sending.', true); return; }
  draft.sending = true;
  draft.sendKey ||= uuid();
  renderConversationChat();
  try {
    await api(`/conversations/${c.id}/messages`, { method: 'POST', data: { body, direction: 'outbound', ai_generated: draft.aiUsed }, idempotencyKey: draft.sendKey });
    draft.body = ''; draft.ai = null; draft.aiUsed = false; draft.sendKey = null;
    if (kind === 'conversations' && conversationState.detail?.id === c.id) {
      await openConversation(c.id);
      await refreshConversationList();
      notify('Reply recorded.');
    }
  } catch (error) { if (conversationState.detail?.id === c.id) notify(error.message, true); }
  finally {
    draft.sending = false;
    if (conversationState.detail?.id === c.id) renderConversationChat();
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
    if (conversationState.detail?.id === c.id) await openConversation(c.id);
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
    if (conversationState.detail?.id === c.id) await openConversation(c.id);
    await refreshConversationList();
    notify('Assignment updated.');
  } catch (error) { notify(error.message, true); renderConversationContext(); }
}
async function newConversationForm(prefill = {}) {
  const [customers, vehicles] = await Promise.all([choices('customers'), prefill.vehicle ? [prefill.vehicle] : choices('vehicles')]);
  if (!customers.length) throw new Error('Create a customer first.');
  const customerOptions = customers.map(customer => [customer.id, `${fullName(customer)}${customer.email ? ` · ${customer.email}` : ''}`]);
  const vehicleOptions = vehicles.map(vehicle => [vehicle.id, `${vehicleName(vehicle)} · ${vehicle.stock_number}`]);
  const selectedVehicle = prefill.vehicle?.id || '';
  const selectedCustomer = customers.some(customer => customer.id === prefill.customer_id) ? prefill.customer_id : '';
  dialogContext = {};
  showDialog('New conversation', `<form id="conversation-form"><div class="editor-grid">
    <label>Customer<select name="customer_id" required>${selectOptions(customerOptions, selectedCustomer, 'Choose a customer')}</select></label>
    ${prefill.vehicle
      ? `<div class="linked-vehicle"><span>Vehicle</span><strong>${esc(vehicleName(prefill.vehicle))}</strong><input type="hidden" name="vehicle_id" value="${esc(selectedVehicle)}"></div>`
      : `<label>Vehicle<select name="vehicle_id">${selectOptions(vehicleOptions, selectedVehicle, 'No vehicle linked')}</select></label>`}
    <label>Channel<select name="channel">${selectOptions([['web', 'Web'], ['email', 'Email'], ['phone', 'Phone'], ['sms', 'SMS'], ['facebook', 'Facebook'], ['whatsapp', 'WhatsApp']], 'web')}</select></label>
  </div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Start conversation</button></div></form>`);
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
function navigateInbox(page = 1) {
  const params = new URLSearchParams();
  if ($('#conversation-search').value.trim()) params.set('q', $('#conversation-search').value.trim());
  if ($('#channel-filter').value) params.set('channel', $('#channel-filter').value);
  if ($('#assignee-filter').value) params.set('assignee', $('#assignee-filter').value);
  if (conversationState.filter !== 'all') params.set('filter', conversationState.filter);
  if (page > 1) params.set('page', page);
  location.hash = params.size ? `conversations?${params}` : 'conversations';
}
$('#conversation-search').addEventListener('input', () => {
  clearTimeout(conversationSearchTimer);
  conversationSearchTimer = setTimeout(() => { if (kind === 'conversations') navigateInbox(); }, 250);
});
for (const selector of ['#channel-filter', '#assignee-filter']) $(selector).addEventListener('change', () => navigateInbox());
$('#conversation-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-filter]');
  if (!tab) return;
  conversationState.filter = tab.dataset.filter;
  navigateInbox();
});
$('#conversation-list').addEventListener('click', event => {
  const item = event.target.closest('[data-conversation-id]');
  if (item) openConversation(item.dataset.conversationId);
});
$('#conversation-pagination').addEventListener('click', event => {
  const button = event.target.closest('[data-conv-page]');
  if (!button || button.disabled) return;
  navigateInbox(Number(button.dataset.convPage));
});
$('#conversation-actions').addEventListener('click', event => {
  if (event.target.closest('#toggle-conversation')) toggleConversation();
});
$('#ai-suggestion-panel').addEventListener('click', event => {
  const button = event.target.closest('[data-ai]');
  if (!button) return;
  if (button.dataset.ai === 'regenerate') { requestAiSuggestion(); return; }
  const ai = conversationState.detail && draftFor(conversationState.detail.id).ai;
  if (!ai || $('#message-input').disabled) return;
  const draft = draftFor(conversationState.detail.id);
  const input = $('#message-input');
  input.value = ai.draft;
  input.focus();
  draft.body = ai.draft; draft.aiUsed = true; draft.sendKey = null;
  $('#ai-suggestion-panel').hidden = true;
  $('#composer-status').textContent = 'AI-assisted draft. Review and edit before sending.';
});
$('#ai-reply-btn').addEventListener('click', () => requestAiSuggestion());
$('#send-reply-btn').addEventListener('click', () => sendReply());
$('#message-input').addEventListener('input', event => {
  if (!conversationState.detail) return;
  const draft = draftFor(conversationState.detail.id);
  draft.body = event.target.value;
  draft.sendKey = null;
});
$('#conversation-context').addEventListener('change', event => {
  if (event.target.id === 'conversation-assignee') changeConversationAssignee(event.target.value);
});
$('#dialog-content').addEventListener('click', async event => {
  const existing = event.target.closest('[data-existing-customer]');
  if (existing) {
    try { await detail(existing.dataset.existingCustomer); } catch (error) { notify(error.message, true); }
    return;
  }
  const copy = event.target.closest('[data-action="copy-inquiry-link"]');
  if (copy) {
    const url = `${location.origin}${location.pathname}#inquiry?vehicle_id=${encodeURIComponent(copy.dataset.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      notify('Customer inquiry link copied.');
    } catch {
      showDialog('Customer inquiry link', `<p class="muted">Share this link with the customer. They do not need an account.</p><label>Inquiry link<textarea readonly rows="3">${esc(url)}</textarea></label><div class="dialog-actions"><button class="blue-btn" type="button" data-close>Done</button></div>`);
    }
    return;
  }
  const button = event.target.closest('[data-action="start-conversation"]');
  if (!button) return;
  const vehicle = dialogContext.record;
  if (vehicle?.id === button.dataset.id) newConversationForm({ vehicle }).catch(error => notify(error.message, true));
});
function closeDialog() { $('#editor').close(); for (const url of photoUrls) URL.revokeObjectURL(url); photoUrls = []; }
$('#editor').addEventListener('close', () => { for (const url of photoUrls) URL.revokeObjectURL(url); photoUrls = []; });
function showDialog(heading, content) {
  $('#dialog-content').innerHTML = `<header class="dialog-header"><h2 id="dialog-title">${esc(heading)}</h2><button class="secondary-btn" data-close aria-label="Close dialog">Close</button></header>${content}`;
  if (!$('#editor').open) $('#editor').showModal();
}
$('#editor').addEventListener('click', event => { if (event.target.closest('[data-close]')) closeDialog(); });
async function choices(type, filter = '') {
  const records = []; let number = 1;
  do { const result = await api(`/${type}?page_size=100&page=${number}${filter}`); records.push(...result.data); if (number >= result.meta.total_pages) break; number++; } while (true);
  return records;
}
const field = (name, label, type = 'text', required = false, options) => ({ name, label, type, required, options });
async function edit(id) {
  const editKind = kind;
  if (editKind === 'vehicles' && !canWriteInventory()) throw new Error('Inventory changes require manager access.');
  const record = id ? (await api(`/${editKind}/${id}`)).data : {};
  let fields;
  if (editKind === 'vehicles') {
    fields = [field('vin', 'VIN (required unless draft)'), field('stock_number', 'Stock number', 'text', true), field('year', 'Year', 'number', true), field('make', 'Make', 'select', true, vehicleMakes), field('model', 'Model', 'text', true), field('trim', 'Trim'), field('status', 'Status', 'select', true, [...statuses.vehicles]), field('body_type', 'Body type', 'select', false, ['Sedan', 'SUV', 'Truck', 'Coupe', 'Van / Minivan', 'Convertible']), field('mileage', 'Mileage (mi, required unless draft)', 'number'), field('list_price', 'List price ($)', 'money', true), field('condition', 'Condition', 'select', true, ['used', 'new', 'certified']), field('fuel_type', 'Fuel type', 'select', false, ['Gasoline', 'Hybrid', 'Electric', 'Diesel', 'Plug-in Hybrid']), field('transmission', 'Transmission', 'select', true, transmissions), field('drivetrain', 'Drivetrain'), field('exterior_color', 'Exterior color'), field('interior_color', 'Interior color'), field('body_style', 'Body style'), field('acquired_at', 'Acquisition date', 'date'), field('acquisition_source', 'Acquisition source'), field('location', 'Location'), field('description', 'Description', 'textarea'), field('mileage_source', 'Mileage source', 'select', false, mileageSources), field('mileage_reported_at', 'Mileage reported on', 'date'), field('mileage_conflict', 'Mileage needs verification / conflict', 'checkbox'), field('title_status', 'Title status'), field('accident_count', 'Reported accident/damage events', 'number'), field('accident_summary', 'Accident / damage summary', 'textarea'), field('service_record_count', 'Service record count', 'number'), field('last_service_date', 'Last service date', 'date'), field('history_summary', 'History summary', 'textarea'), field('history_report_date', 'History report date', 'date'), field('history_report_url', 'History report URL'), field('hybrid_battery_status', 'Hybrid battery status', 'select', false, hybridBatteryStatuses), field('smog_status', 'Smog status', 'select', false, smogStatuses), field('ac_status', 'A/C status', 'select', false, acStatuses), field('inspection_notes', 'Inspection notes', 'textarea'), field('inspection_conflict', 'Inspection conflicts with report', 'checkbox')];
    if (manager()) fields.push(field('purchase_cost', 'Purchase cost ($)', 'money'), field('minimum_price', 'Minimum price ($)', 'money'), field('internal_notes', 'Internal notes', 'textarea'), field('test_current_mileage', 'Test-only current mileage (never sent to customers)', 'number'), field('test_mileage_note', 'Test-only mileage note', 'text'));
  } else {
    const [vehicles, users] = await Promise.all([choices('vehicles'), manager() ? choices('users', '&status=active') : []]);
    const vehicleOptions = vehicles.map(v => [v.id, `${vehicleName(v)} · ${title(v.status)}`]);
    const userOptions = users.map(u => [u.id, u.name]);
    const assignment = manager() ? [field('assigned_user_id', 'Assigned salesperson', 'select', false, userOptions)] : [];
    if (editKind === 'customers') fields = [field('first_name', 'First name', 'text', true), field('last_name', 'Last name'), field('email', 'Email', 'email'), field('phone', 'Phone', 'tel'), field('preferred_contact', 'Preferred contact', 'select', false, [['email', 'Email'], ['phone', 'Phone']]), field('preferred_language', 'Preferred language'), field('lead_source', 'Source'), field('status', 'Status', 'select', true, [...statuses.customers]), field('interested_vehicle_id', 'Interested vehicle', 'select', false, vehicleOptions), ...assignment, field('do_not_contact', 'Do not contact', 'checkbox')];
    else {
      const customers = await choices('customers');
      if (record.customer && !customers.some(customer => customer.id === record.customer.id)) customers.push(record.customer);
      const transitions = { new: ['new', 'working', 'lost'], working: ['working', 'qualified', 'lost'], qualified: ['qualified', 'working', 'lost'], won: ['won'], lost: ['lost', ...(['owner', 'manager'].includes(actor.role) ? ['working'] : [])] };
      fields = [field('customer_id', 'Customer', 'select', true, customers.map(c => [c.id, `${fullName(c)}${c.email ? ` · ${c.email}` : ''}`])), field('vehicle_id', 'Interested vehicle', 'select', false, vehicleOptions), field('source', 'Source', 'text', true), field('status', 'Stage', 'select', true, id ? transitions[record.status] : ['new']), field('priority', 'Priority', 'select', true, ['normal', 'high', 'low']), ...assignment, field('external_lead_id', 'External lead ID'), field('message', 'Customer message', 'textarea'), field('lost_reason', 'Lost reason (required when lost)', 'textarea'), field('reopen_reason', 'Reopen reason (required when reopening lost)', 'textarea')];
    }
  }
  const defaults = { status: editKind === 'vehicles' ? 'available' : 'new', preferred_language: 'en', condition: 'used', priority: 'normal', transmission: 'Unknown', mileage_source: 'Unknown', hybrid_battery_status: 'unknown', smog_status: 'unknown', ac_status: 'unknown' };
  for (const f of fields) if (f.type === 'select' && record[f.name] && !f.options.some(o => (Array.isArray(o) ? o[0] : o) === record[f.name])) f.options.push([record[f.name], `${record[f.name]} (current / archived)`]);
  if (kind !== editKind || !actor) return;
  dialogContext = { kind: editKind, record, fields };
  function renderField(f) {
    const value = record[f.name] ?? defaults[f.name] ?? ''; const attrs = `name="${f.name}" ${f.required ? 'required' : ''}`;
    const control = f.type === 'select' ? `<select ${attrs}>${selectOptions(f.options, value, f.required ? 'Select…' : 'None')}</select>` : f.type === 'textarea' ? `<textarea ${attrs}>${esc(value)}</textarea>` : f.type === 'checkbox' ? `<input type="checkbox" ${attrs} ${value ? 'checked' : ''}>` : `<input ${attrs} type="${f.type === 'money' ? 'number' : f.type}" value="${esc(value)}" ${['number', 'money'].includes(f.type) ? `min="${f.name === 'year' ? 1900 : 0}" step="${f.type === 'money' ? '0.01' : '1'}"` : ''}>`;
    return `<label class="${f.type === 'textarea' ? 'wide' : ''}">${esc(f.label)}${f.required ? ' *' : ''}${control}</label>`;
  }
  let controls;
  if (editKind === 'vehicles') {
    const mainNames = ['stock_number', 'status', 'vin', 'year', 'make', 'model', 'trim', 'mileage', 'list_price'];
    const main = mainNames.map(name => fields.find(f => f.name === name));
    const inspectionNames = ['mileage_source', 'mileage_reported_at', 'mileage_conflict', 'title_status', 'accident_count', 'accident_summary', 'service_record_count', 'last_service_date', 'history_summary', 'history_report_date', 'history_report_url', 'hybrid_battery_status', 'smog_status', 'ac_status', 'inspection_notes', 'inspection_conflict', 'test_current_mileage', 'test_mileage_note'];
    const internalNames = ['purchase_cost', 'minimum_price', 'internal_notes', 'acquired_at', 'acquisition_source'];
    const groups = [
      ['Vehicle details', fields.filter(f => !mainNames.includes(f.name) && !inspectionNames.includes(f.name) && !internalNames.includes(f.name))],
      ['History and inspection', fields.filter(f => inspectionNames.includes(f.name))],
      ['Acquisition and internal notes', fields.filter(f => internalNames.includes(f.name))],
    ];
    controls = `<div class="editor-grid">${main.map(renderField).join('')}</div>` + groups.filter(([, items]) => items.length).map(([label, items]) =>
      `<details class="field-section"><summary>${label}</summary><div class="editor-grid">${items.map(renderField).join('')}</div></details>`).join('');
  } else controls = `<div class="editor-grid">${fields.map(renderField).join('')}</div>`;
  showDialog(`${id ? 'Edit' : 'Add'} ${singular[editKind]}`, `<form id="record-form">${controls}<p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="blue-btn" type="submit">Save ${singular[editKind]}</button></div></form>`);
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
$('#editor').addEventListener('invalid', event => {
  const section = event.target.closest('details');
  if (section) section.open = true;
}, true);
$('#editor').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
  const errorArea = event.target.querySelector('.form-error'); if (errorArea) errorArea.textContent = '';
  try {
    if (event.target.id === 'record-form') {
      const context = dialogContext; const formData = new FormData(event.target); const data = {};
      for (const f of context.fields) {
        const value = formData.get(f.name);
        if (f.type === 'checkbox') data[f.name] = formData.has(f.name);
        else if (['money', 'number'].includes(f.type)) { if (value !== '') data[f.name] = Number(value); else if (context.record.id && !f.required) data[f.name] = null; }
        else if ((f.name.endsWith('_id') || f.name === 'preferred_contact' || f.type === 'date') && value === '') data[f.name] = null;
        else if (value !== '' || !f.options || context.record[f.name]) data[f.name] = value;
      }
      if (event.submitter?.name === 'duplicate_review') data.duplicate_review = JSON.parse(event.submitter.value);
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
      conversationState.search = ''; conversationState.channel = ''; conversationState.assignee = '';
      $('#channel-filter').value = ''; $('#assignee-filter').value = '';
      history.replaceState(null, '', `${location.pathname}#conversations`);
      conversationState.page = 1;
      $('#conversation-search').value = '';
      showConversationView();
      await refreshConversationList();
      await openConversation(result.data.id);
    } else if (event.target.id === 'note-form') {
      const id = dialogContext.record.id;
      await api(`/customers/${id}/notes`, { method: 'POST', data: { note_text: event.target.elements.note_text.value, is_pinned: event.target.elements.is_pinned.checked } }); notify('Note added.'); await detail(id);
    } else if (event.target.id === 'photo-form') {
      const file = event.target.elements.file.files[0];
      if (!file || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG or PNG image of at most 10 MB.');
      const form = new FormData(); form.append('file', file);
      const id = dialogContext.record.id; await api(`/vehicles/${id}/media`, { method: 'POST', form }); notify('Photo uploaded.'); await detail(id); await load();
    }
  } catch (error) {
    if (error.code === 'DUPLICATE_REVIEW' && errorArea && error.candidates?.length) {
      const ids = error.candidates.map(c => c.id);
      errorArea.innerHTML = `<p>${esc(error.message)}</p>${error.candidates.map(c => `<button type="button" class="secondary-btn" data-existing-customer="${esc(c.id)}">Use ${esc(fullName(c))}</button>`).join(' ')}
        <button class="secondary-btn" type="submit" name="duplicate_review" value="${esc(JSON.stringify(ids))}">Create a separate profile</button>`;
    } else if (errorArea) errorArea.textContent = error.message;
    else notify(error.message, true);
  }
  finally { if (button) button.disabled = false; }
});
function activityValue(key, value) {
  if (value == null || value === '') return '—';
  if (['list_price', 'purchase_cost', 'minimum_price'].includes(key) && typeof value === 'number') return money(value);
  if (key === 'mileage') return mileageLabel(value);
  if (Array.isArray(value)) return value.join(', ');
  return displayValue(key, value);
}
function activityTimeline(events, recordKind) {
  const names = { created: `${title(singular[recordKind])} created`, updated: `${title(singular[recordKind])} updated`,
    photo_added: 'Photo uploaded', photos_reordered: 'Photos reordered', photo_deleted: 'Photo removed',
    note_added: 'Note added', public_inquiry_received: 'Website inquiry received', public_inquiry_customer_created: 'Customer created from website inquiry' };
  const items = events.map(event => {
    const changes = Object.entries(event.changes || {});
    const rows = changes.map(([key, change]) => {
      const pair = change && typeof change === 'object' && Object.hasOwn(change, 'after');
      const before = pair && change.before != null && change.before !== ''
        ? `<span class="previous-value">${esc(activityValue(key, change.before))}</span> <span aria-label="changed to">→</span> ` : '';
      return `<div><dt>${esc(title(key))}</dt><dd>${before}${esc(activityValue(key, pair ? change.after : change))}</dd></div>`;
    }).join('');
    const heading = event.action === 'updated' && changes.length === 1
      ? `${title(changes[0][0])} changed` : names[event.action] || title(event.action);
    return `<li><div class="event-heading"><strong>${esc(heading)}</strong>
      <time datetime="${esc(event.created_at)}">${esc(formatDateTime(event.created_at))}</time></div>
      ${rows ? `<details class="event-detail"><summary>Details (${changes.length})</summary><dl>${rows}</dl></details>` : ''}</li>`;
  });
  return `<section class="activity-panel"><h3>Activity</h3>${items.length ? `<ol class="activity-list">${items.join('')}</ol>` : '<p class="muted">No activity yet.</p>'}</section>`;
}
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
  let actions = '';
  let extra = '';
  if (detailKind === 'customers') {
    const candidates = record.duplicate_candidates || [];
    extra = `${candidates.length ? `<h3>Possible matching customers</h3><p>Review the shared contact details before following up.</p><ul>${candidates.map(c => `<li>${esc(fullName(c))}</li>`).join('')}</ul>` : ''}<h3>Notes</h3>${record.notes.length ? record.notes.map(note => `<div class="note">${note.is_pinned ? '📌 ' : ''}${esc(note.note_text)}<small>${esc(note.author_name || 'Unknown author')} · ${esc(formatDateTime(note.created_at))}</small></div>`).join('') : '<p class="muted">No notes yet.</p>'}${writable ? '<form id="note-form"><label>Add a note<textarea name="note_text" required maxlength="10000"></textarea></label><label><input type="checkbox" name="is_pinned">Pin note</label><p class="form-error" role="alert"></p><button class="blue-btn">Add note</button></form>' : ''}<p><a href="#leads?customer_id=${record.id}">View all ${record.lead_count} linked leads</a></p>`;
  } else if (detailKind === 'vehicles') {
    extra = `<h3>Photos (${record.media.length}/10)</h3><div id="photos" class="photos"></div>${writable ? '<form id="photo-form"><label>JPEG or PNG · up to 10 MB<input name="file" type="file" accept="image/jpeg,image/png" required></label><p class="form-error" role="alert"></p><button class="blue-btn">Upload photo</button></form>' : ''}`;
    actions = `<div class="vehicle-actions">
      ${record.status !== 'available' ? '' : `<div class="action-group"><h3>Customer inquiry</h3><div class="action-buttons">
        <a class="secondary-btn" href="#inquiry?vehicle_id=${record.id}" target="_blank" rel="noopener">Preview customer inquiry</a>
        <button type="button" class="secondary-btn" data-action="copy-inquiry-link" data-id="${record.id}">Copy inquiry link</button>
      </div></div>`}
      <div class="action-group"><h3>Staff follow-up</h3><div class="action-buttons">
        <a class="secondary-btn" href="#leads?vehicle_id=${record.id}">View linked leads</a>
        <button class="blue-btn" type="button" data-action="start-conversation" data-id="${record.id}">Start conversation</button>
      </div></div></div>`;
  }
  const renderFields = pairs => `<dl class="record-fields">${pairs.map(([key, value]) => `<div><dt>${esc(title(key))}</dt><dd>${esc(activityValue(key, value))}</dd></div>`).join('')}</dl>`;
  let facts;
  if (detailKind === 'vehicles') {
    const main = ['stock_number', 'vin', 'status', 'list_price', 'mileage', 'location'];
    facts = renderFields(main.map(key => [key, record[key]]))
      + `<details class="vehicle-more"><summary>More vehicle details</summary>${renderFields(fields.filter(([key]) => !main.includes(key)))}</details>`;
  } else facts = renderFields(fields);
  showDialog(detailKind === 'vehicles' ? vehicleName(record) : detailKind === 'customers' ? fullName(record) : 'Lead details', `${actions}${facts}${extra}${activityTimeline(history.data, detailKind)}`);
  if (detailKind === 'vehicles') {
    for (const [index, media] of record.media.entries()) {
      try {
        const blob = await api(`/vehicles/${id}/media/${media.id}`, { raw: true });
        if (!$('#editor').open || dialogContext.record.id !== id) return;
        const url = URL.createObjectURL(blob); photoUrls.push(url);
        const figure = document.createElement('figure'); const img = document.createElement('img'); img.src = url; img.alt = `${vehicleName(record)} photo`; figure.append(img);
        if (media.is_primary) {
          const label = document.createElement('figcaption');
          label.textContent = 'Primary photo';
          figure.append(label);
        }
        if (writable) {
          const moves = [];
          if (index > 0) moves.push(['Make primary', 0]);
          if (index > 1) moves.push(['Move earlier', index - 1]);
          if (index < record.media.length - 1) moves.push(['Move later', index + 1]);
          for (const [label, position] of moves) {
            const move = document.createElement('button');
            move.type = 'button'; move.className = 'secondary-btn'; move.textContent = label;
            move.addEventListener('click', async () => {
              move.disabled = true;
              const ids = record.media.map(m => m.id);
              ids.splice(index, 1); ids.splice(position, 0, media.id);
              try {
                await api(`/vehicles/${id}/media`, { method: 'PATCH', version: record.version, data: { media_ids: ids } });
                await detail(id); await load();
              } catch (error) { notify(error.message, true); move.disabled = false; }
            });
            figure.append(move);
          }
        }
        if (writable) { const remove = document.createElement('button'); remove.className = 'secondary-btn danger'; remove.textContent = 'Remove photo'; remove.addEventListener('click', async () => { if (!confirm('Remove this photo?')) return; remove.disabled = true; try { await api(`/vehicles/${id}/media/${media.id}`, { method: 'DELETE' }); await detail(id); await load(); } catch (error) { notify(error.message, true); remove.disabled = false; } }); figure.append(remove); }
        $('#photos').append(figure);
      } catch (error) { notify(`Photo could not be loaded: ${error.message}`, true); }
    }
  }
}
renderLocation();
