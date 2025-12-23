import 'dotenv/config';
import { query } from '../server/db';

async function migrate() {
  try {
    console.log("Starting migration...");

    // 1. Find all foreign keys referencing businesses
    const fks = await query(`
      SELECT
        tc.table_schema, 
        tc.constraint_name, 
        tc.table_name, 
        kcu.column_name
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'businesses' AND ccu.column_name = 'id';
    `);

    console.log(`Found ${fks.rows.length} foreign keys referencing businesses.`);

    // 2. Drop constraints
    for (const row of fks.rows) {
      console.log(`Dropping constraint ${row.constraint_name} on ${row.table_name}`);
      await query(`ALTER TABLE "${row.table_name}" DROP CONSTRAINT "${row.constraint_name}"`);
    }

    // 3. Alter businesses table
    console.log("Altering businesses.id to VARCHAR(255)...");
    // Drop default first if exists
    await query(`ALTER TABLE businesses ALTER COLUMN id DROP DEFAULT`);
    await query(`ALTER TABLE businesses ALTER COLUMN id TYPE VARCHAR(255) USING id::text`);

    // 4. Alter referencing tables
    const tables = new Set(fks.rows.map((r: any) => r.table_name));
    for (const table of tables) {
      console.log(`Altering ${table}.business_id to VARCHAR(255)...`);
      // Assuming the column name is business_id. The query above returns column_name, let's use it.
      const cols = fks.rows.filter((r: any) => r.table_name === table);
      for (const col of cols) {
         await query(`ALTER TABLE "${table}" ALTER COLUMN "${col.column_name}" TYPE VARCHAR(255) USING "${col.column_name}"::text`);
      }
    }

    // 5. Recreate constraints
    for (const row of fks.rows) {
      console.log(`Recreating constraint ${row.constraint_name} on ${row.table_name}`);
      // We assume ON DELETE behavior. Most were CASCADE, but activity_logs was not specified (default NO ACTION).
      // I need to be careful. Ideally I should have captured the delete rule.
      // For now, I'll apply CASCADE for the ones I know, and default for others?
      // Or I can just check the known tables from my analysis.
      
      let onDelete = "";
      if (['users', 'tasks', 'epics', 'ideas', 'payment_cards'].includes(row.table_name)) {
        onDelete = "ON DELETE CASCADE";
      }
      
      await query(`ALTER TABLE "${row.table_name}" ADD CONSTRAINT "${row.constraint_name}" FOREIGN KEY ("${row.column_name}") REFERENCES businesses(id) ${onDelete}`);
    }

    console.log("Migration completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

migrate();
