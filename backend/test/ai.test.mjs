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

test('mileage attribution follows the recorded source and conflicts require verification', () => {
  for (const source of ['Dealer', 'Other', 'Unknown', null]) {
    const facts = baseFacts({ mileage_source: source });
    const reply = policyReply({ vehicleFacts: facts, question: 'How many miles?' });
    assert.match(reply.draft, /163,099 miles/);
    assert.doesNotMatch(reply.draft, /CARFAX/i);
  }
  const reply = policyReply({ vehicleFacts: baseFacts({ mileage_conflict: true, test_current_mileage: 169999 }), question: 'How many miles?', testMode: true });
  assert.doesNotMatch(reply.draft, /169,999|163,099/);
  assert.match(reply.draft, /verification/);
});

test('follow-ups use the buyer’s terms and separate every requested topic', () => {
  const ask = (question, history = [], facts = {}) => policyReply({ vehicleFacts: baseFacts(facts), question, history });
  const history = [{ direction: 'inbound', body: 'Can I get an out-the-door quote for ZIP 10001?' },
    { direction: 'outbound', body: 'I will check the fees.' }];
  assert.match(ask('What about cash?', history).draft, /verify taxes and fees for ZIP 10001/);
  assert.doesNotMatch(ask('What about cash?', history).draft, /\$/);
  const prior = [{ direction: 'inbound', body: 'What is the out-the-door total for 91731 if I pay cash?' }];
  assert.match(ask('What about cash?', prior).draft, /\$11,030/);
  const noCash = ask("What if I'm not paying cash? And is there a warranty?", prior);
  assert.match(noCash.draft, /\$11,250/);
  assert.match(noCash.draft, /optional three-month/);
  assert.doesNotMatch(noCash.draft, /cash discount/i);
  assert.doesNotMatch(ask('Where is your dealership?').draft, /discount|best price/i);
  assert.match(ask('Can I test drive it Saturday at 2?').draft, /check Saturday at 2/);
  const visit = [{ direction: 'outbound', body: 'When would you like a test drive?' }];
  assert.match(ask('Tomorrow at 3 pm', visit).draft, /check Tomorrow at 3 pm/);
  assert.doesNotMatch(ask('Can I test drive it Saturday?', [], { availability: 'sold' }).draft, /confirm the appointment/);
  assert.doesNotMatch(ask('Does the A/C work?', [], { ac_status: 'works', inspection_conflict: true }).draft, /blows cold/i);
  assert.doesNotMatch(ask('Can I finance it?').draft, /2,000/);
  assert.equal(estimateOutTheDoor({ price: 10000, zip: '10001' }), null);
});

test('provider drafts preserve verified terms and reject unsupported claims before display', async t => {
  const config = { AI_PROVIDER: 'openai', AI_API_STYLE: 'responses', AI_API_KEY: 'test-fixture', AI_MODEL: 'fixture' };
  for (const [key, value] of Object.entries(config)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let draft = '[[verified_reply]]\nWhat else would you like to know?';
  let received;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    received = JSON.parse(JSON.parse(init.body).input);
    return Response.json({ status: 'completed', output_text: JSON.stringify({ draft, verificationNotes: [] }) });
  });
  const facts = baseFacts({ price_usd: 7720, availability: 'reserved' });
  for (const prose of ['It’s listed at 163,099 miles.', 'The odometer is listed at 262,480 km.',
    'It is currently reserved.', 'The records show scheduled maintenance.', 'Maintenance is scheduled for Saturday.', 'The appointment is not yet confirmed.']) {
    draft = prose;
    const response = await generateReply({ vehicleFacts: facts, question: 'How many miles?' });
    assert.equal(response.draft, prose);
    assert.equal(response.provider, 'openai');
  }
  for (const prose of ['It is listed at 7,720.', 'It is listed at 163,099 miles and priced at $7,720.',
    'It’s reserved for you.', 'We scheduled your appointment.', 'Your test drive is booked.']) {
    draft = prose;
    assert.match((await generateReply({ vehicleFacts: facts, question: 'How many miles?' })).warning, /withheld/);
  }
  for (const [question, expected] of [
    ['What does it cost?', /listed price is \$7,720/], ['How much does it cost?', /listed price is \$7,720/],
    ['What are you asking?', /listed price is \$7,720/], ['What would I pay after tax?', /Estimated out-the-door total: \$8,742/],
    ['How much is the sales tax?', /Estimated tax/], ['What would I pay after tax for ZIP 10001?', /verify taxes and fees for ZIP 10001/],
  ]) {
    draft = '[[verified_reply]]';
    const response = await generateReply({ vehicleFacts: facts, question });
    assert.match(received.verifiedReply, expected);
    assert.equal(response.provider, 'openai');
    assert.equal(response.draft, received.verifiedReply);
  }
  assert.equal(policyReply({ question: 'How much does it cost to replace the tires?', vehicleFacts: facts }), null);
  draft = '[[verified_reply]]\nWhat else would you like to know?';
  const history = [{ direction: 'inbound', body: 'What is the OTD price for ZIP 91731?' }];
  const input = { question: 'What about cash?', vehicleFacts: baseFacts(), history };
  const result = await generateReply(input);
  assert.deepEqual(received.recentMessages, history);
  assert.equal(received.buyerMessage, input.question);
  assert.match(result.draft, /11,030/);
  assert.match(result.draft, /What else/);
  assert.doesNotMatch(result.draft, /\[\[/);
  assert.equal(result.provider, 'openai');
  for (const [bad, reason] of [
    ['[[verified_reply]] The listed price is $12,000.', /financial terms/],
    ['[[verified_reply]] Your Saturday appointment is confirmed.', /booking/],
    ['I can help with that.', /did not preserve/],
  ]) {
    draft = bad;
    const blocked = await generateReply(input);
    assert.match(blocked.warning, reason);
    assert.equal(blocked.provider, 'policy');
    assert.doesNotMatch(blocked.draft, /12,000|appointment is confirmed|I can help with that/);
  }
  draft = '[[verified_reply]]\nThe A/C blows cold.';
  const conflict = await generateReply({ question: 'Does the A/C work?', vehicleFacts: baseFacts({ inspection_conflict: true }) });
  assert.match(conflict.warning, /inspection records conflict/);
  assert.doesNotMatch(conflict.draft, /blows cold/i);
  draft = 'Your appointment is booked.';
  const unrelated = await generateReply({ vehicleFacts: baseFacts(), question: 'Any photos?' });
  assert.match(unrelated.warning, /booking/);
  assert.doesNotMatch(unrelated.draft, /booked/);
});

test('provider finish reasons distinguish truncation, malformed JSON and other stops', async t => {
  const config = { AI_PROVIDER: 'openai', AI_API_KEY: 'fixture', AI_MODEL: 'fixture', AI_API_STYLE: 'chat' };
  for (const [key, value] of Object.entries(config)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const requests = [];
  const diagnostics = [];
  let replies = [];
  t.mock.method(console, 'warn', (_label, metadata) => diagnostics.push(metadata));
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  const input = { question: 'How many miles?', vehicleFacts: baseFacts() };
  const valid = JSON.stringify({ draft: 'It is listed at 163,099 miles.', verificationNotes: [] });
  const bad = '{"draft":"partial","verificationNotes":["one" "two"]}';
  const styles = [
    ['chat', 'length', 'stop', (reason, raw) => ({ choices: [{ finish_reason: reason, message: { content: raw } }] })],
    ['anthropic', 'max_tokens', 'end_turn', (reason, raw) => ({ stop_reason: reason, content: [{ type: 'text', text: raw }] })],
    ['responses', 'max_output_tokens', 'completed', (reason, raw) => reason === 'completed'
      ? { status: reason, output_text: raw } : { status: 'incomplete', incomplete_details: { reason }, output_text: raw }],
  ];
  for (const [style, limit, done, wrap] of styles) {
    process.env.AI_API_STYLE = style;
    requests.length = 0;
    replies = [wrap(limit, valid), wrap(done, valid)];
    const recovered = await generateReply(input);
    assert.equal(recovered.draft, 'It is listed at 163,099 miles.');
    assert.equal(requests.length, 2);
    const budget = style === 'responses' ? 'max_output_tokens' : 'max_tokens';
    assert.ok(requests[1][budget] > requests[0][budget]);
    assert.deepEqual(diagnostics.at(-1), { apiStyle: style, attempt: 1, kind: 'truncated', stopReason: limit });
    requests.length = 0;
    replies = [wrap(done, bad), wrap(done, bad)];
    const failed = await generateReply(input);
    assert.equal(requests.length, 2);
    assert.equal(requests[1][budget], requests[0][budget]);
    assert.match(JSON.stringify(requests[1]), /separate array entries/);
    assert.equal(failed.provider, 'policy');
    assert.match(failed.warning, /invalid draft JSON/);
    assert.deepEqual(diagnostics.at(-1), { apiStyle: style, attempt: 2, kind: 'format', stopReason: done });
    replies = [wrap(limit, bad), wrap(limit, bad)];
    assert.match((await generateReply(input)).warning, /token limit/);
  }
  process.env.AI_API_STYLE = 'chat';
  requests.length = 0;
  replies = [{ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }];
  assert.match((await generateReply(input)).warning, /stopped/);
  assert.equal(requests.length, 1);
});
