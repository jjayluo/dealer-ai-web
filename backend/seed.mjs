import { randomUUID } from 'node:crypto';
import { createUser } from './auth.mjs';

export function seed(store, { email, password } = {}) {
  const existing = store.db.prepare('SELECT id, email, role, status FROM users ORDER BY rowid').all();
  if (existing.length) {
    // Upgrade a legacy single bootstrap account to owner when one exists.
    if (email && existing.length === 1 && existing[0].email === email.toLowerCase() && existing[0].role === 'manager' && existing[0].status === 'active') {
      store.db.prepare("UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing[0].id);
    }
    return false;
  }
  if (!email || !password) return 'unconfigured';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('DEALER_ADMIN_EMAIL must be a valid email address');
  if (String(password).length < 10) throw new Error('DEALER_ADMIN_PASSWORD must be at least 10 characters');
  createUser(store, { organization_id: randomUUID(), email, password, name: 'Administrator', role: 'owner' });
  return true;
}
