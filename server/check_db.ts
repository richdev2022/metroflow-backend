import "dotenv/config";
import { query } from "./db";

async function checkEpics() {
  try {
    console.log("Checking epics in database...");
    const result = await query("SELECT * FROM epics");
    console.log(`Total epics found: ${result.rows.length}`);
    console.log(JSON.stringify(result.rows, null, 2));

    // Also check businesses to see what business IDs exist
    const businesses = await query("SELECT id, name FROM businesses");
    console.log(`Total businesses found: ${businesses.rows.length}`);
    console.log(JSON.stringify(businesses.rows, null, 2));
    
  } catch (error) {
    console.error("Error checking epics:", error);
  }
}

checkEpics();
