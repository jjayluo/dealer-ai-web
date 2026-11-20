import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, ROLES } from './domain.mjs';
import { passwordHash, verifyPassword } from './passwords.mjs';

export { passwordHash } from './passwords.mjs';

export function createUser(store, { organization_id, email, name, role = 'manager', password }) {
  if (!ROLES.includes(role)) throw new ApiError(422, 'VALIDATION_ERROR', `Allowed roles: ${ROLES.join(', ')}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  const normalized = email.toLowerCase();
  store.db.prepare(`INSERT INTO users (id, organization_id, email, name, role, password_hash, active, status, auth_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'active', 0, ?, ?)`).run(id, organization_id, normalized, name, role, passwordHash(password), now, now);
  return { id, organization_id, email: normalized, name, role, status: 'active' };
}
export class Auth {
  constructor(store, secret = randomBytes(32).toString('hex')) { this.store = store; this.secret = secret; this.attempts = new Map(); }
  sign(value) { return createHmac('sha256', this.secret).update(value).digest('base64url'); }
  login(input, address) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const limit = this.attempts.get(address) || { count: 0, until: now + 60000 };
    if (limit.count >= 10) throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts. Try again in a minute.');
    limit.count++; this.attempts.set(address, limit);
    if (typeof input?.email !== 'string' || typeof input?.password !== 'string' || input.password.length > 1024) throw new ApiError(400, 'INVALID_LOGIN', 'Email and password are required');
    const user = this.store.db.prepare('SELECT * FROM users WHERE email = ?').get(input.email.trim().toLowerCase());
    if (!user || user.status !== 'active' || !user.active || !verifyPassword(input.password, user.password_hash)) throw new ApiError(401, 'INVALID_LOGIN', 'Incorrect email or password');
    const loginAt = new Date().toISOString();
    this.store.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(loginAt, user.id);
    return this.issueToken({ ...user, last_login_at: loginAt });
  }
  publicUser({ password_hash, auth_version, active, ...user }) { return user; }
  issueToken(user) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: user.id, ver: user.auth_version ?? 0, exp: Math.floor(Date.now() / 1000) + 28800 })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    return { access_token: `${unsigned}.${this.sign(unsigned)}`, expires_in: 28800, user: this.publicUser(user) };
  }
  authenticate(header) {
    try {
      if (!header?.startsWith('Bearer ')) throw Error();
      const parts = header.slice(7).split('.');
      if (parts.length !== 3) throw Error();
      const [h, p, signature] = parts;
      const expected = Buffer.from(this.sign(`${h}.${p}`));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || JSON.parse(Buffer.from(h, 'base64url')).alg !== 'HS256') throw Error();
      const payload = JSON.parse(Buffer.from(p, 'base64url'));
      if (!Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) throw Error();
      const user = this.store.db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (!user || user.status !== 'active' || !user.active || Number(payload.ver ?? 0) !== user.auth_version) throw Error();
      return this.publicUser(user);
    } catch { throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again'); }
  }
}
