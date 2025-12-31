
import dotenv from "dotenv";
dotenv.config();

// Ensure pool is imported AFTER dotenv config
import { Pool } from "pg";
import { randomUUID } from "crypto";

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Mock verification function since we don't want to call external APIs in test
const mockVerifyPayment = async (ref: string) => {
    return { success: true, data: { transaction_status: 'success' } };
};

// We will use the actual admin route logic but adapted for a script run
// This allows us to "simulate" the route handler
async function runTest() {
    const client = await pool.connect();
    try {
        console.log("Setting up test environment...");
        
        // 1. Create a Test User and Wallet
        const userId = randomUUID();
        const walletId = randomUUID();
        const businessId = randomUUID(); // Fake business ID for constraint

        // Create a dummy business first
        await client.query(`INSERT INTO businesses (id, name, email) VALUES ($1, 'Test Biz', $2)`, [businessId, `biz-${businessId}@example.com`]);
        
        // Use a fixed timestamp for wallet creation (yesterday)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        
        await client.query(`INSERT INTO users (id, business_id, email, password_hash, name) VALUES ($1, $2, $3, 'hash', 'Test User')`, 
            [userId, businessId, `test-${userId}@example.com`]);
            
        await client.query(`INSERT INTO wallets (id, user_id, balance, currency, updated_at) VALUES ($1, $2, 0, 'NGN', $3)`,
            [walletId, userId, yesterday]);

        // 2. Create a Platform Wallet if not exists
        const platformWalletRes = await client.query(`SELECT * FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
        let platformWalletId;
        if (platformWalletRes.rows.length === 0) {
             const newWallet = await client.query(`INSERT INTO wallets (status, currency) VALUES ('active', 'NGN') RETURNING id`);
             platformWalletId = newWallet.rows[0].id;
        } else {
             platformWalletId = platformWalletRes.rows[0].id;
        }

        // 3. Create a "Zombie" Transaction
        // Status: Success
        // Created: TODAY (newer than wallet update)
        // Platform Debit: Exists
        // User Credit: Missing (Wallet balance is 0 and updated yesterday)
        const ref = `TEST-SETTLE-${Date.now()}`;
        const amount = 5000;
        
        await client.query(`
            INSERT INTO transactions (id, amount, currency, reference, status, wallet_id, user_id, type, direction, created_at)
            VALUES ($1, $2, 'NGN', $3, 'success', $4, $5, 'credit', 'credit', NOW())
        `, [randomUUID(), amount, ref, walletId, userId]);

        // Insert Platform Debit
        await client.query(`
            INSERT INTO transactions (id, amount, currency, reference, status, wallet_id, type, direction, created_at)
            VALUES ($1, $2, 'NGN', $3, 'success', $4, 'debit', 'debit', NOW())
        `, [randomUUID(), amount, `${ref}-PLATFORM`, platformWalletId]);

        console.log(`Test Data Created. Ref: ${ref}`);
        console.log("Condition: Transaction is SUCCESS, Platform is DEBITED, but User Wallet is STALE (0 balance, old timestamp).");

        // 4. Run the Settlement Logic (Simulated from admin.ts)
        console.log("\n--- Running Settlement Logic ---");
        
        await client.query('BEGIN');

        // [Logic copied/adapted from admin.ts]
        const txRes = await client.query(`SELECT * FROM transactions WHERE reference = $1 FOR UPDATE`, [ref]);
        const transaction = txRes.rows[0];
        
        // Fetch User Wallet
        let userWallet;
        if (transaction.wallet_id) {
            const userWalletRes = await client.query(`SELECT * FROM wallets WHERE id = $1 FOR UPDATE`, [transaction.wallet_id]);
            userWallet = userWalletRes.rows[0];
        }

        let settlementType = 'full';

        if (transaction.status === 'success') {
            const platTxCheck = await client.query(
                `SELECT id FROM transactions WHERE reference = $1 AND wallet_id = $2 AND type = 'debit'`,
                [`${ref}-PLATFORM`, platformWalletId]
            );

            if (platTxCheck.rows.length > 0) {
                 const txCreated = new Date(transaction.created_at);
                 const walletUpdated = userWallet ? new Date(userWallet.updated_at) : null;

                 if (userWallet && walletUpdated && walletUpdated < txCreated) {
                      console.log(`Manual Settlement: Detected stale wallet for ref ${ref}. Wallet updated: ${walletUpdated}, Tx created: ${txCreated}. Forcing credit.`);
                      settlementType = 'user_credit_only';
                 } else {
                      console.log("Error: Transaction already fully settled");
                      await client.query('ROLLBACK');
                      return;
                 }
            }
            
            if (settlementType !== 'user_credit_only') {
                settlementType = 'platform_debit_only';
            }
        }

        console.log(`Determined Settlement Type: ${settlementType}`);

        if (settlementType === 'full' || settlementType === 'user_credit_only') {
            if (transaction.wallet_id) {
                const creditRes = await client.query(
                    `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2 RETURNING balance`,
                    [transaction.amount, transaction.wallet_id]
                );
                console.log("User Wallet Credited. New Balance:", creditRes.rows[0].balance);
            }
            
            await client.query(
                `UPDATE transactions SET status = 'success', updated_at = NOW(), description = description || ' (Manual Settlement)' WHERE id = $1`,
                [transaction.id]
            );
        }

        if (settlementType !== 'user_credit_only') {
             // Platform debit logic (skipped for this test case as we expect user_credit_only)
             console.log("Debit Platform Wallet...");
        }

        await client.query('COMMIT');
        console.log("Settlement Completed Successfully.");

        // 5. Verification
        const finalWallet = await client.query(`SELECT * FROM wallets WHERE id = $1`, [walletId]);
        console.log("\n--- Final Verification ---");
        console.log("User Wallet Balance:", finalWallet.rows[0].balance);
        
        if (Number(finalWallet.rows[0].balance) === amount) {
            console.log("TEST PASSED: User wallet was correctly credited.");
        } else {
            console.log("TEST FAILED: User wallet balance is incorrect.");
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Test Error:", error);
    } finally {
        client.release();
        await pool.end();
    }
}

runTest();
