import "dotenv/config";
import { query, initializeDatabase } from "./db";

async function check() {
  try {
    console.log("Initializing database to apply migrations...");
    await initializeDatabase();
    console.log("Database initialized.");

    const res = await query(`
      SELECT conname, confdeltype 
      FROM pg_constraint 
      WHERE conname IN ('task_assignments_assigned_by_fkey', 'comments_user_id_fkey', 'attachments_uploaded_by_fkey')
    `);
    // 'c' = cascade, 'n' = set null, 'a' = no action/restrict, 'r' = restrict, 'd' = set default
    console.log("Constraints:", res.rows);
    
    const col = await query(`
      SELECT table_name, column_name, is_nullable 
      FROM information_schema.columns 
      WHERE (table_name = 'task_assignments' AND column_name = 'assigned_by')
         OR (table_name = 'comments' AND column_name = 'user_id')
         OR (table_name = 'attachments' AND column_name = 'uploaded_by')
    `);
    console.log("Columns:", col.rows);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}

check();
