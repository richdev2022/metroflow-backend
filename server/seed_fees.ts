import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars from root .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// import { query, pool } from "./db";

const fees = [
    {
        name: "Standard Transfer Fee",
        fee_type: "transfer",
        config_type: "range",
        config: {
            ranges: [
                { min: 0, max: 5000, fee: 10 },
                { min: 5001, max: 50000, fee: 25 },
                { min: 50001, max: 999999999, fee: 50 }
            ]
        }
    },
    {
        name: "Card Funding Fee",
        fee_type: "funding_card",
        config_type: "percentage_cap",
        config: {
            percentage: 1.5,
            cap: 2000
        }
    },
    {
        name: "Account Funding Fee",
        fee_type: "funding_account",
        config_type: "flat",
        config: {
            amount: 50
        }
    },
    {
        name: "OTP SMS Fee",
        fee_type: "otp_sms",
        config_type: "flat",
        config: {
            amount: 4
        }
    },
    {
        name: "Stamp Duty",
        fee_type: "stamp_duty",
        config_type: "flat_conditional",
        config: {
            conditions: [
                { operator: ">=", threshold: 10000, fee: 50 }
            ]
        }
    }
];

async function seedFees() {
    const { query, pool } = await import("./db");
    console.log("Seeding Fees...");
    try {
        for (const fee of fees) {
            // Check if exists
            const check = await query(`SELECT id FROM fee_configurations WHERE fee_type = $1`, [fee.fee_type]);
            
            if (check.rows.length > 0) {
                console.log(`Updating existing fee: ${fee.name} (${fee.fee_type})`);
                await query(
                    `UPDATE fee_configurations 
                     SET name = $1, config_type = $2, config = $3, updated_at = CURRENT_TIMESTAMP
                     WHERE fee_type = $4`,
                    [fee.name, fee.config_type, fee.config, fee.fee_type]
                );
            } else {
                console.log(`Creating new fee: ${fee.name} (${fee.fee_type})`);
                await query(
                    `INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
                     VALUES ($1, $2, $3, $4, 'NGN')`,
                    [fee.name, fee.fee_type, fee.config_type, fee.config]
                );
            }
        }
        console.log("Fees seeded successfully.");
    } catch (error) {
        console.error("Error seeding fees:", error);
    } finally {
        pool.end();
    }
}

seedFees();
