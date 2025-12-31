import "dotenv/config";
import { query } from "./db";

async function runMigration() {
    console.log("Running migration for Fee Management and Platform Wallet...");
    try {
        // Enable uuid-ossp extension if not exists
        await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        // 1. Fee Configurations Table
        await query(`
            CREATE TABLE IF NOT EXISTS fee_configurations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                fee_type VARCHAR(50) NOT NULL,
                config_type VARCHAR(50) NOT NULL,
                config JSONB NOT NULL,
                currency VARCHAR(3) DEFAULT 'NGN',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Platform Wallet Table
        await query(`
            CREATE TABLE IF NOT EXISTS platform_wallet (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                balance NUMERIC(20, 2) DEFAULT 0,
                currency VARCHAR(3) DEFAULT 'NGN',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Seed Platform Wallet if not exists
        const walletCheck = await query(`SELECT * FROM platform_wallet LIMIT 1`);
        if (walletCheck.rows.length === 0) {
            await query(`INSERT INTO platform_wallet (balance, currency) VALUES (0, 'NGN')`);
            console.log("Platform wallet created.");
        }

        // 3. Update Transactions Table
        await query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee NUMERIC(20, 2) DEFAULT 0`);

        // 4. Update Businesses Table for OTP Preference
        await query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS otp_preference VARCHAR(20) DEFAULT 'email'`);

        console.log("Migration completed successfully.");
    } catch (error) {
        console.error("Migration failed:", error);
    }
    process.exit(0);
}

runMigration();
