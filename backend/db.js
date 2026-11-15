import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL');
export const db = new pg.Pool({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:5000, max:5});
