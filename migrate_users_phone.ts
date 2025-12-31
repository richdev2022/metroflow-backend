
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

async function migrate() {
  try {
    console.log("Starting migration: Add phone_number to users table...");
    
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)`);
    
    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await pool.end();
  }
}

migrate();
