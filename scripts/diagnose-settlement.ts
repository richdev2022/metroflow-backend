
import dotenv from "dotenv";
dotenv.config();

console.log("DB URL loaded:", process.env.DATABASE_URL ? "Yes" : "No");
if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    console.log("DB URL starts with:", url.substring(0, 15));
    console.log("Contains '@':", url.includes('@'));
    const parts = url.split('://');
    if (parts.length > 1) {
        const afterProtocol = parts[1];
        const authSplit = afterProtocol.split('@');
        if (authSplit.length > 1) {
            const auth = authSplit[0];
            const [user, pass] = auth.split(':');
            console.log("User length:", user ? user.length : 0);
            console.log("Pass length:", pass ? pass.length : 0);
            console.log("Pass is empty string:", pass === '');
        } else {
            console.log("No auth info found in URL (no @)");
        }
    }
}

const { pool } = await import("../server/db");

async function diagnose(reference: string) {
    console.log(`Diagnosing reference: ${reference}`);
    const client = await pool.connect();
    try {
        // 1. Fetch Transaction
        const txRes = await client.query(`SELECT * FROM transactions WHERE reference = $1`, [reference]);
        if (txRes.rows.length === 0) {
            console.log("Transaction NOT FOUND");
            return;
        }
        const tx = txRes.rows[0];
        console.log("Transaction:", tx);

        // 2. Fetch Platform Wallet
        const platformWalletRes = await client.query(`SELECT * FROM wallets WHERE business_id IS NULL AND user_id IS NULL`);
        let platformWalletId;
        if (platformWalletRes.rows.length === 0) {
            console.log("Platform Wallet NOT FOUND");
        } else {
            const pw = platformWalletRes.rows[0];
            platformWalletId = pw.id;
            console.log("Platform Wallet:", pw);
        }

        let newCheckRows: any[] = [];
        if (platformWalletId) {
            // 3. Check for Platform Debits (Old and New patterns)
            const oldPatternRef = reference;
            const newPatternRef = `${reference}-PLATFORM`;

            const oldCheck = await client.query(
                `SELECT * FROM transactions WHERE reference = $1 AND wallet_id = $2 AND type = 'debit'`,
                [oldPatternRef, platformWalletId]
            );
            console.log(`Platform Debit (Ref: ${oldPatternRef}): Found ${oldCheck.rows.length}`, oldCheck.rows);

            const newCheck = await client.query(
                `SELECT * FROM transactions WHERE reference = $1 AND wallet_id = $2 AND type = 'debit'`,
                [newPatternRef, platformWalletId]
            );
            console.log(`Platform Debit (Ref: ${newPatternRef}): Found ${newCheck.rows.length}`, newCheck.rows);
            newCheckRows = newCheck.rows;
        }

        // 4. Check User Wallet
        if (tx.wallet_id) {
            const walletRes = await client.query(`SELECT * FROM wallets WHERE id = $1`, [tx.wallet_id]);
            if (walletRes.rows.length > 0) {
                console.log("User Wallet:", walletRes.rows[0]);

                // Check for stale wallet logic
                const transaction = txRes.rows[0];
                const userWallet = walletRes.rows[0];
                const platDebit = newCheckRows;

                if (transaction.status === 'success' && platDebit.length > 0) {
                    console.log("\n--- Logic Check ---");
                    const txCreated = new Date(transaction.created_at);
                    const walletUpdated = userWallet ? new Date(userWallet.updated_at) : null;
                    
                    console.log(`Tx Created: ${txCreated.toISOString()}`);
                    console.log(`Wallet Updated: ${walletUpdated?.toISOString()}`);

                    if (userWallet && walletUpdated && walletUpdated < txCreated) {
                        console.log("RESULT: Stale wallet detected. Logic would trigger 'user_credit_only'.");
                    } else {
                        console.log("RESULT: Wallet is up to date (or newer). Logic would return 'Already fully settled'.");
                    }
                }
            } else {
                console.log("User Wallet NOT FOUND for id:", tx.wallet_id);
            }
        } else {
            console.log("Transaction has NO wallet_id");
        }

    } catch (e) {
        console.error("Error:", e);
    } finally {
        client.release();
        pool.end();
    }
}

const REF_TO_CHECK = 'FUND-user-1767003494300-756f12b2';

diagnose(REF_TO_CHECK);
