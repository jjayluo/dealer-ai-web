import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../domain.mjs';
import { createUser } from '../auth.mjs';
import { seedSampleData } from '../sample-data.mjs';

function ownerFor(store) {
  return createUser(store, {
    organization_id: randomUUID(),
    email: `owner-${randomUUID()}@example.com`,
    password: 'sample-password',
    name: 'Sample Owner',
    role: 'owner',
  });
}

test('sample data seeds once into an empty database', () => {
  const previous = process.env.DEALER_SEED_SAMPLE_DATA;
  delete process.env.DEALER_SEED_SAMPLE_DATA;
  const store = new Store();
  try {
    const owner = ownerFor(store);
    const first = seedSampleData(store);
    assert.deepEqual(first, { vehicles: 3, customers: 3, leads: 3, conversations: 3 });
    assert.equal(store.all('vehicles', owner).length, 3);
    assert.equal(store.all('customers', owner).length, 3);
    assert.equal(store.all('leads', owner).length, 3);
    assert.equal(store.listConversations(owner).pagination.total, 3);
    assert.equal(store.publicVehicleList(new URLSearchParams()).pagination.total, 2);

    const camry = store.all('vehicles', owner).find(vehicle => vehicle.stock_number === 'SAMPLE-1001');
    const conversation = store.listConversations(owner).data.find(row => row.vehicle_id === camry.id);
    const detail = store.getConversation(conversation.id, owner);
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.messages[0].direction, 'inbound');
    assert.match(detail.messages[0].body, /out-the-door price/);

    assert.equal(seedSampleData(store), null);
    assert.equal(store.all('vehicles', owner).length, 3);
    assert.equal(store.listConversations(owner).pagination.total, 3);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.DEALER_SEED_SAMPLE_DATA;
    else process.env.DEALER_SEED_SAMPLE_DATA = previous;
  }
});

test('sample data can be disabled for an empty database', () => {
  const previous = process.env.DEALER_SEED_SAMPLE_DATA;
  process.env.DEALER_SEED_SAMPLE_DATA = '0';
  const store = new Store();
  try {
    const owner = ownerFor(store);
    assert.equal(seedSampleData(store), null);
    assert.equal(store.all('vehicles', owner).length, 0);
    assert.equal(store.all('customers', owner).length, 0);
    assert.equal(store.all('leads', owner).length, 0);
    assert.equal(store.listConversations(owner).pagination.total, 0);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.DEALER_SEED_SAMPLE_DATA;
    else process.env.DEALER_SEED_SAMPLE_DATA = previous;
  }
});
