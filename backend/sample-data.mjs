const SAMPLE_DATE = '2026-08-20';

export function seedSampleData(store) {
  if (['0', 'false', 'off'].includes(String(process.env.DEALER_SEED_SAMPLE_DATA || '').toLowerCase())) return null;
  const owner = store.db.prepare(`SELECT id, organization_id, role FROM users
    WHERE role = 'owner' AND status = 'active' AND active = 1
    ORDER BY created_at, rowid LIMIT 1`).get();
  if (!owner) return null;
  if (['vehicles', 'customers', 'leads'].some(kind => store.all(kind, owner).length)) return null;

  const camry = store.save('vehicles', {
    stock_number: 'SAMPLE-1001',
    vin: '4T1B11HK5KU123456',
    year: 2019,
    make: 'Toyota',
    model: 'Camry',
    trim: 'SE',
    body_type: 'Sedan',
    condition: 'used',
    status: 'available',
    mileage: 48500,
    mileage_source: 'CARFAX',
    mileage_reported_at: SAMPLE_DATE,
    list_price: 18900,
    exterior_color: 'Silver',
    interior_color: 'Black',
    transmission: 'Automatic',
    drivetrain: 'FWD',
    fuel_type: 'Gasoline',
    location: 'Front lot',
    description: 'One-owner local trade-in. Clean interior. Ask our team for the full CARFAX report.',
    title_status: 'No title problems reported',
    accident_count: 0,
    service_record_count: 12,
    last_service_date: SAMPLE_DATE,
    history_summary: `CARFAX report dated Aug 20, 2026: 1 owner, 12 service records; no accidents reported; no title problems.`,
    history_report_date: SAMPLE_DATE,
  }, owner);

  const crv = store.save('vehicles', {
    stock_number: 'SAMPLE-1002',
    vin: '2HKRW2H87LH123456',
    year: 2020,
    make: 'Honda',
    model: 'CR-V',
    trim: 'EX',
    body_type: 'SUV',
    condition: 'used',
    status: 'available',
    mileage: 52700,
    mileage_source: 'Dealer',
    list_price: 21800,
    exterior_color: 'Blue',
    interior_color: 'Gray',
    transmission: 'CVT',
    drivetrain: 'AWD',
    fuel_type: 'Gasoline',
    location: 'Front lot',
    description: 'Two-owner SUV with service records on file. Ask our team for details.',
  }, owner);

  const mazda = store.save('vehicles', {
    stock_number: 'SAMPLE-1003',
    vin: 'JM1BPABL4M1234567',
    year: 2021,
    make: 'Mazda',
    model: 'Mazda3',
    trim: 'Select',
    body_type: 'Sedan',
    condition: 'used',
    status: 'reserved',
    mileage: 18400,
    mileage_source: 'Dealer',
    list_price: 19500,
    exterior_color: 'Red',
    interior_color: 'Black',
    transmission: 'Automatic',
    drivetrain: 'FWD',
    fuel_type: 'Gasoline',
    location: 'Showroom',
    description: 'Low-mileage sedan currently reserved; ask our team about similar availability.',
  }, owner);

  const alex = store.save('customers', {
    first_name: 'Alex',
    last_name: 'Rivera',
    email: 'alex.rivera@example.com',
    phone: '+15550101001',
    preferred_contact: 'email',
    lead_source: 'Website',
    status: 'new',
    interested_vehicle_id: camry.id,
    assigned_user_id: owner.id,
  }, owner);

  const jordan = store.save('customers', {
    first_name: 'Jordan',
    last_name: 'Lee',
    email: 'jordan.lee@example.com',
    phone: '+15550101002',
    preferred_contact: 'phone',
    lead_source: 'Walk-in',
    status: 'contacted',
    interested_vehicle_id: crv.id,
    assigned_user_id: owner.id,
  }, owner);

  const taylor = store.save('customers', {
    first_name: 'Taylor',
    last_name: 'Morgan',
    email: 'taylor.morgan@example.com',
    phone: '+15550101003',
    preferred_contact: 'email',
    lead_source: 'Phone',
    status: 'qualified',
    interested_vehicle_id: mazda.id,
    assigned_user_id: null,
  }, owner);

  const alexLead = store.save('leads', {
    customer_id: alex.id,
    vehicle_id: camry.id,
    source: 'Website',
    external_lead_id: 'SAMPLE-INQ-1001',
    status: 'new',
    priority: 'normal',
    assigned_user_id: owner.id,
    message: "Is the Camry still available? What's the out-the-door price for ZIP 91731?",
  }, owner);

  const jordanLead = store.save('leads', {
    customer_id: jordan.id,
    vehicle_id: crv.id,
    source: 'Walk-in',
    external_lead_id: 'SAMPLE-WALK-1002',
    status: 'new',
    priority: 'normal',
    assigned_user_id: owner.id,
    message: 'Can I schedule a test drive this weekend?',
  }, owner);

  const taylorLead = store.save('leads', {
    customer_id: taylor.id,
    vehicle_id: mazda.id,
    source: 'Phone',
    external_lead_id: 'SAMPLE-CALL-1003',
    status: 'new',
    priority: 'high',
    assigned_user_id: null,
    message: 'Do you offer financing with $2,000 down?',
  }, owner);

  store.createConversation({
    customer_id: alex.id,
    vehicle_id: camry.id,
    lead_id: alexLead.id,
    channel: 'web',
    assigned_user_id: null,
    message: alexLead.message,
  }, owner);

  store.createConversation({
    customer_id: jordan.id,
    vehicle_id: crv.id,
    lead_id: jordanLead.id,
    channel: 'phone',
    assigned_user_id: owner.id,
    message: jordanLead.message,
  }, owner);

  store.createConversation({
    customer_id: taylor.id,
    vehicle_id: mazda.id,
    lead_id: taylorLead.id,
    channel: 'sms',
    assigned_user_id: null,
    message: taylorLead.message,
  }, owner);

  return { vehicles: 3, customers: 3, leads: 3, conversations: 3 };
}
