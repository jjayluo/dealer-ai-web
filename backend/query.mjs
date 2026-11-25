import { ApiError, schemas } from './domain.mjs';

function integer(value, name, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || +value < 1 || +value > max) throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${name}`, { [name]: `Use an integer between 1 and ${max}` });
  return +value;
}
export function listRecords(store, kind, params, actor) {
  const page = integer(params.get('page'), 'page', 1, 1000000);
  const page_size = integer(params.get('page_size'), 'page_size', 20, 100);
  let rows = store.all(kind, actor);
  rows = rows.map(row => kind === 'leads' ? { ...row, customer: store.related('customers', row.customer_id, actor), vehicle: store.related('vehicles', row.vehicle_id, actor) } : kind === 'customers' ? { ...row, interested_vehicle: store.related('vehicles', row.interested_vehicle_id, actor) } : row);
  for (const field of ['status', 'make', 'model', 'year', 'body_type', 'fuel_type', 'priority', 'assigned_user_id', 'customer_id', 'vehicle_id', 'interested_vehicle_id']) {
    const value = params.get(field);
    if (value) {
      if (!schemas[kind][field]) throw new ApiError(422, 'VALIDATION_ERROR', `Unsupported filter: ${field}`);
      if (schemas[kind][field].values && !schemas[kind][field].values.includes(value)) throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${field}`);
      rows = rows.filter(row => String(row[field] ?? '').toLowerCase() === value.toLowerCase());
    }
  }
  if (params.get('source')) rows = rows.filter(row => String(row[kind === 'customers' ? 'lead_source' : 'source'] ?? '').toLowerCase() === params.get('source').toLowerCase());
  if (params.get('assignee')) rows = rows.filter(row => row.assigned_user_id === params.get('assignee'));
  const q = params.get('q')?.trim().toLowerCase();
  if (q) rows = rows.filter(row => {
    const values = kind === 'vehicles' ? [row.vin, row.stock_number, row.make, row.model, row.trim, row.year, row.description] : kind === 'customers' ? [row.first_name, row.last_name, `${row.first_name} ${row.last_name || ''}`, row.email, row.phone] : [row.customer?.first_name, row.customer?.last_name, `${row.customer?.first_name} ${row.customer?.last_name || ''}`, row.vehicle?.make, row.vehicle?.model, row.source, row.external_lead_id, row.message];
    return values.some(value => String(value ?? '').toLowerCase().includes(q));
  });
  for (const [name, compare] of [['price_min', (a, b) => a >= b], ['price_max', (a, b) => a <= b]]) {
    if (params.has(name)) {
      const value = params.get(name);
      if (kind !== 'vehicles' || value.trim() === '' || !Number.isFinite(+value) || +value < 0) throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${name}`);
      rows = rows.filter(row => compare(row.list_price, +value));
    }
  }
  if (params.has('price_min') && params.has('price_max') && +params.get('price_min') > +params.get('price_max')) throw new ApiError(422, 'VALIDATION_ERROR', 'Minimum price exceeds maximum price');
  for (const name of ['date_from', 'date_to']) if (params.has(name)) {
    const value = Date.parse(params.get(name));
    if (!Number.isFinite(value)) throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${name}`);
    rows = rows.filter(row => name === 'date_from' ? Date.parse(row.created_at) >= value : Date.parse(row.created_at) <= value);
  }
  const total = rows.length;
  return { data: rows.slice((page - 1) * page_size, page * page_size).map(row => {
    const result = store.project(kind, row, actor);
    if (kind === 'vehicles') result.primary_photo = store.media(row.id, actor)[0]?.url ?? null;
    return result;
  }), pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) } };
}
