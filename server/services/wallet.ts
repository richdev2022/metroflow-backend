import { query } from "../db";

export async function createWallet(entityId: string, type: 'business' | 'user', currency: string = 'NGN') {
    try {
        const column = type === 'business' ? 'business_id' : 'user_id';

        // Check if wallet exists (per currency — users own an NGN and a USD
        // wallet side by side for the Personal app swap).
        const check = await query(
            `SELECT id FROM wallets WHERE ${column} = $1 AND currency = $2`,
            [entityId, currency],
        );
        if (check.rows.length > 0) {
            return check.rows[0];
        }

        // Create wallet
        const res = await query(
            `INSERT INTO wallets (${column}, balance, currency, status)
             VALUES ($1, 0.00, $2, 'active')
             RETURNING *`,
            [entityId, currency],
        );

        console.log(`Created wallet for ${type} ${entityId} (${currency})`);
        return res.rows[0];
    } catch (error) {
        console.error("Create wallet error:", error);
        throw error;
    }
}
