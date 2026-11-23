import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOutTheDoor, policyReply } from '../policy.mjs';
import { buildVehicleFacts, generateReply } from '../ai.mjs';

const baseFacts = (overrides = {}) => ({
  vin: 'JTDKN3DU7D5683039',
  year: 2013,
  make: 'Toyota',
  model: 'Prius',
  trim: 'Two',
  price_usd: 10000,
  availability: 'available',
  mileage: 163099,
  mileage_source: 'CARFAX',
  mileage_reported_at: '2025-07-11',
  mileage_conflict: false,
  title_status: 'No title problems reported',
  accident_count: 0,
  accident_summary: null,
  service_record_count: 24,
  last_service_date: '2025-07-11',
  history_summary: 'CARFAX report dated Sep 16, 2026: 3 owners, 24 service records, no accident issues reported, no title problems.',
  history_report_date: '2026-09-16',
  report_available: true,
  hybrid_battery_status: 'inspected_good',
  smog_status: 'unknown',
  ac_status: 'unknown',
  inspection_notes: 'Our mechanic recently inspected the hybrid battery and noted it was in good condition.',
  inspection_conflict: false,
  test_current_mileage: null,
  test_mileage_note: null,
  ...overrides,
});

test('out-the-door test estimate follows the approved formula', () => {
  const standard = estimateOutTheDoor({ price: 10000 });
  assert.equal(standard.tax, 1000);
  assert.equal(standard.title, 50);
  assert.equal(standard.registration, 200);
  assert.equal(standard.total, 11250);
  assert.equal(standard.test_only, true);

  const cash = estimateOutTheDoor({ price: 10000, cashDiscount: 200 });
  assert.equal(cash.discounted_price, 9800);
  assert.equal(cash.tax, 980);
  assert.equal(cash.total, 11030);

  const prius = estimateOutTheDoor({ price: 7720 });
  assert.equal(prius.total, 8742);
  assert.equal(estimateOutTheDoor({ price: null }), null);
});

test('policy replies cover availability, VIN, mileage and the CARFAX mileage rule', () => {
  const available = policyReply({ vehicleFacts: baseFacts(), question: 'Is this car still available?' });
  assert.equal(available.provider, 'policy');
  assert.match(available.draft, /listed as available/);

  const unclear = policyReply({ vehicleFacts: baseFacts({ availability: 'draft' }), question: 'Is this car still available?' });
  assert.match(unclear.draft, /check availability/i);

  const vinMiles = policyReply({ vehicleFacts: baseFacts(), question: "What's the VIN, and how many miles are on it?" });
  assert.match(vinMiles.draft, /JTDKN3DU7D5683039/);
  assert.match(vinMiles.draft, /last mileage reported on CARFAX was 163,099 miles as of Jul 11, 2025/i);
  assert.match(vinMiles.draft, /confirm the current reading/i);

  const datedOnly = policyReply({ vehicleFacts: baseFacts({ test_current_mileage: 164200 }), question: 'How many miles are on it?', testMode: false });
  assert.match(datedOnly.draft, /163,099/);
  assert.equal(datedOnly.draft.includes('164,200'), false);

  const testOnly = policyReply({ vehicleFacts: baseFacts({ test_current_mileage: 164200 }), question: 'How many miles are on it?', testMode: true });
  assert.match(testOnly.draft, /current mileage on file is 164,200 miles/i);
  assert.match(testOnly.verification_notes.join(' '), /Test-only current mileage/i);

  const missing = policyReply({ vehicleFacts: baseFacts({ mileage: null, mileage_reported_at: null }), question: 'How many miles are on it?' });
  assert.match(missing.draft, /verified current mileage/i);

  const conflict = policyReply({ vehicleFacts: baseFacts({ mileage_conflict: true }), question: 'How many miles are on it?' });
  assert.match(conflict.draft, /need verification/i);
});

test('policy replies cover CARFAX, accidents and title without overclaiming', () => {
  const withDamage = policyReply({ vehicleFacts: baseFacts({ accident_count: 2, accident_summary: '2 reported minor damage events; impact: front, left-front' }), question: 'Can you send me the CARFAX? Has the car had any accidents? Does it have a clean title?' });
  assert.match(withDamage.draft, /CARFAX report on file/i);
  assert.match(withDamage.draft, /2 reported minor damage events/i);
  assert.match(withDamage.draft, /no title problems/i);
  assert.match(withDamage.draft, /front, left-front/i);

  const noAccidents = policyReply({ vehicleFacts: baseFacts(), question: 'Has the car had any accidents?' });
  assert.match(noAccidents.draft, /does not report any accidents/i);
  assert.match(noAccidents.draft, /no title problems/i);

  const noReport = policyReply({ vehicleFacts: baseFacts({ report_available: false, accident_count: 0, title_status: null }), question: 'Has the car had any accidents? Does it have a clean title?' });
  assert.match(noReport.draft, /don’t have a CARFAX report/i);
  assert.equal(noReport.draft.includes('does not report any accidents'), false);
  assert.match(noReport.draft, /can’t verify the title status/i);

  const conflict = policyReply({ vehicleFacts: baseFacts({ inspection_conflict: true, hybrid_battery_status: 'inspected_good' }), question: 'Has the hybrid battery been tested?' });
  assert.match(conflict.draft, /records conflict/i);
});

test('policy replies cover out-the-door, cash discount, registration and financing', () => {
  const otd = policyReply({ vehicleFacts: baseFacts(), question: "What's the out-the-door price for ZIP code 91731?" });
  assert.match(otd.draft, /Vehicle price: \$10,000/);
  assert.match(otd.draft, /Estimated tax \(10%\): \$1,000/);
  assert.match(otd.draft, /Title: \$50/);
  assert.match(otd.draft, /Registration: \$200/);
  assert.match(otd.draft, /Estimated out-the-door total: \$11,250/);
  assert.match(otd.draft, /test estimate only/i);

  const cashOtd = policyReply({ vehicleFacts: baseFacts(), question: "What's the out-the-door total for 91731 if I pay cash?" });
  assert.match(cashOtd.draft, /Cash discount: -\$200/);
  assert.match(cashOtd.draft, /Discounted vehicle price: \$9,800/);
  assert.match(cashOtd.draft, /Estimated out-the-door total: \$11,030/);

  const registration = policyReply({ vehicleFacts: baseFacts(), question: 'Can I handle my own registration?' });
  assert.match(registration.draft, /normally handles title and registration/i);
  assert.match(registration.draft, /ask my manager/i);

  const under = policyReply({ vehicleFacts: baseFacts({ price_usd: 7720 }), question: 'Do you offer financing? What are my options with $2,000 down?' });
  assert.match(under.draft, /recommend paying in full/i);

  const over = policyReply({ vehicleFacts: baseFacts({ price_usd: 10000 }), question: 'Do you offer financing? What are my options with $2,000 down?' });
  assert.match(over.draft, /We offer financing/i);
  assert.match(over.draft, /\$2,000 down/);
  assert.match(over.draft, /low credit or no SSN/i);
  assert.match(over.draft, /subject to lender requirements and approval/i);
});

test('policy replies cover trade-in, hybrid battery and smog/A/C', () => {
  const trade = policyReply({ vehicleFacts: baseFacts(), question: 'Do you take trade-ins? I have a Honda Accord.' });
  assert.match(trade.draft, /Yes, we take trade-ins/i);
  assert.match(trade.draft, /your Accord/);
  assert.match(trade.draft, /estimate/i);

  const battery = policyReply({ vehicleFacts: baseFacts(), question: 'Has the Prius hybrid battery been tested or replaced?' });
  assert.match(battery.draft, /recently inspected the hybrid battery/i);
  assert.match(battery.draft, /good condition/i);
  assert.match(battery.draft, /replacement record/i);

  const batteryMissing = policyReply({ vehicleFacts: baseFacts({ hybrid_battery_status: 'unknown' }), question: 'Has the hybrid battery been tested?' });
  assert.match(batteryMissing.draft, /verified hybrid battery inspection/i);

  const smogAcUnknown = policyReply({ vehicleFacts: baseFacts(), question: 'Has it passed smog, and does the A/C work?' });
  assert.match(smogAcUnknown.draft, /verified smog record/i);
  assert.match(smogAcUnknown.draft, /\$100 smog arrangement/i);
  assert.match(smogAcUnknown.draft, /verified A\/C record/i);

  const smogAcKnown = policyReply({ vehicleFacts: baseFacts({ smog_status: 'passed', ac_status: 'works' }), question: 'Has it passed smog, and does the A/C work?' });
  assert.match(smogAcKnown.draft, /passed smog/i);
  assert.match(smogAcKnown.draft, /blows cold/i);
});

test('policy replies cover warranty, location, best price and fall back for other questions', () => {
  const warranty = policyReply({ vehicleFacts: baseFacts(), question: 'Does it come with a warranty?' });
  assert.match(warranty.draft, /optional three-month dealership warranty for \$700/i);
  assert.match(warranty.draft, /engine, transmission, and battery/i);

  const location = policyReply({ vehicleFacts: baseFacts(), question: 'Where are you located? Can I come in for a test drive?' });
  assert.match(location.draft, /3490 Valley Blvd, San Gabriel, CA/);
  assert.match(location.draft, /confirm the appointment/i);
  assert.match(location.draft, /10 - 6pm/);

  const best = policyReply({ vehicleFacts: baseFacts(), question: "What's your best price?" });
  assert.match(best.draft, /a little room on price/i);
  assert.match(best.draft, /best price/i);

  const cash = policyReply({ vehicleFacts: baseFacts(), question: 'Is it negotiable if I pay cash?' });
  assert.match(cash.draft, /\$200 off/i);

  assert.equal(policyReply({ vehicleFacts: baseFacts(), question: 'Do you have any photos of the interior?' }), null);
});

test('vehicle facts include the CARFAX history and gate test-only mileage by environment', async () => {
  const previous = process.env.DEALER_AI_TEST_MODE;
  const vehicle = {
    vin: 'JTDKN3DU7D5683039', year: 2013, make: 'Toyota', model: 'Prius', trim: 'Two',
    status: 'available', mileage: 163099, list_price: 7720, description: 'CARFAX report dated Sep 16, 2026: 3 owners, 2 reported minor damage events.',
    mileage_source: 'CARFAX', mileage_reported_at: '2025-07-11', title_status: 'No title problems reported',
    accident_count: 2, accident_summary: '2 reported minor damage events', service_record_count: 24,
    history_report_date: '2026-09-16', hybrid_battery_status: 'inspected_good',
    test_current_mileage: 164200, test_mileage_note: 'test only',
    purchase_cost: 5000, minimum_price: 7000, internal_notes: 'private',
  };
  try {
    process.env.DEALER_AI_TEST_MODE = '1';
    const testFacts = buildVehicleFacts(vehicle);
    assert.equal(testFacts.test_current_mileage, 164200);
    assert.match(testFacts.history_summary, /CARFAX report/);
    assert.equal('purchase_cost' in testFacts, false);
    assert.equal('minimum_price' in testFacts, false);
    assert.equal('internal_notes' in testFacts, false);

    process.env.DEALER_AI_TEST_MODE = '0';
    const productionFacts = buildVehicleFacts(vehicle);
    assert.equal(productionFacts.test_current_mileage, null);
    assert.equal(productionFacts.test_mileage_note, null);

    const reply = await generateReply({ vehicleFacts: productionFacts, question: 'Is this car still available?', testMode: false });
    assert.equal(reply.provider, 'policy');
  } finally {
    if (previous === undefined) delete process.env.DEALER_AI_TEST_MODE;
    else process.env.DEALER_AI_TEST_MODE = previous;
  }
});
