import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, hash) {
  if (typeof hash !== 'string' || !hash.includes(':')) return false;
  const [salt, value] = hash.split(':');
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(value, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
