import { query } from "../db";

export async function createWallet(entityId: string, type: 'business' | 'user') {
    try {
        const column = type === 'business' ? 'business_id' : 'user_id';
        
        // Check if wallet exists
        const check = await query(`SELECT id FROM wallets WHERE ${column} = $1`, [entityId]);
        if (check.rows.length > 0) {
            return check.rows[0];
        }

        // Create wallet
        const res = await query(
            `INSERT INTO wallets (${column}, balance, currency, status) 
             VALUES ($1, 0.00, 'NGN', 'active') 
             RETURNING *`,
            [entityId]
        );
        
        console.log(`Created wallet for ${type} ${entityId}`);
        return res.rows[0];
    } catch (error) {
        console.error("Create wallet error:", error);
        throw error;
    }
}
