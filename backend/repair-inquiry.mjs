import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, validate } from './domain.mjs';

// Use the customer's confirmed name to separate a legacy website inquiry.
export function repairInquiry(store, conversationId, confirmedName) {
  const name = confirmedName?.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 160) throw new Error('Provide the confirmed full name (1–160 characters).');
  const [first, ...rest] = name.split(' ');
  const db = store.db;
  return store.transaction(() => {
    const row = db.prepare(`SELECT c.*, l.data AS lead_data, p.data AS profile,
        p.created_at AS profile_created_at, l.created_at AS lead_created_at
      FROM conversations c
      JOIN leads l ON l.id = c.lead_id AND l.organization_id = c.organization_id AND l.archived_at IS NULL
      JOIN customers p ON p.id = c.customer_id AND p.organization_id = c.organization_id AND p.archived_at IS NULL
      WHERE c.id = ?`).get(conversationId);
    if (!row) throw new Error('Conversation or linked records could not be found.');
    const lead = JSON.parse(row.lead_data);
    if (row.channel !== 'web' || lead.source !== 'Website' || lead.customer_id !== row.customer_id || lead.vehicle_id !== row.vehicle_id) {
      throw new Error('Expected a website inquiry with matching customer and vehicle links.');
    }
    const org = row.organization_id;
    if (row.inquiry_name === name) return false;
    const origin = db.prepare(`SELECT changes FROM activity WHERE organization_id = ? AND kind = 'conversations'
      AND record_id = ? AND action = 'public_inquiry_received' AND actor_id = 'public'`).get(org, conversationId);
    const shared = db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE organization_id = ? AND lead_id = ?').get(org, row.lead_id);
    const receipt = db.prepare('SELECT 1 FROM inquiry_receipts WHERE organization_id = ? AND submission_id = ?').get(org, lead.external_lead_id ?? null);
    if (row.inquiry_name || !origin || JSON.parse(origin.changes).lead_id !== row.lead_id || receipt ||
        row.profile_created_at >= row.created_at || row.lead_created_at !== row.created_at || shared.count !== 1) {
      throw new Error('This inquiry does not match the legacy shared-profile case.');
    }
    const old = JSON.parse(row.profile);
    const profile = validate('customers', { first_name: first, last_name: rest.join(' '), lead_source: 'Website',
      interested_vehicle_id: row.vehicle_id, assigned_user_id: lead.assigned_user_id || row.assigned_user_id,
      do_not_contact: Boolean(old.do_not_contact) });
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO customers (id, organization_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, org, JSON.stringify(profile), now, now);
    db.prepare("UPDATE leads SET data = json_set(data, '$.customer_id', ?), version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?")
      .run(id, now, row.lead_id, org);
    db.prepare('UPDATE conversations SET customer_id = ?, inquiry_name = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?')
      .run(id, name, now, conversationId, org);
    const actor = { id: 'local-admin', organization_id: org };
    const changes = { customer_id: { before: row.customer_id, after: id } };
    store.audit('customers', id, actor, 'inquiry_customer_restored', { conversation_id: conversationId });
    store.audit('leads', row.lead_id, actor, 'inquiry_customer_corrected', changes);
    store.audit('conversations', conversationId, actor, 'inquiry_customer_corrected', changes);
    return true;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , conversationId, name] = process.argv;
  const filename = process.env.DEALER_DB_PATH || fileURLToPath(new URL('./data/dealer.sqlite', import.meta.url));
  let store;
  try {
    if (!conversationId || !name) throw new Error('Usage: node backend/repair-inquiry.mjs <conversation-id> "Confirmed Name"');
    if (!existsSync(filename)) throw new Error('Database not found. Set DEALER_DB_PATH to the existing local database.');
    if (process.platform === 'win32' && resolve(filename).startsWith('\\\\')) throw new Error('Run this command inside WSL for a database on its filesystem.');
    store = new Store(filename);
    console.log(repairInquiry(store, conversationId, name) ? 'Inquiry and lead corrected.' : 'Inquiry already has the confirmed name.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
