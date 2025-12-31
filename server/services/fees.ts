import { query } from "../db";

export interface FeeConfig {
    id: string;
    name: string;
    fee_type: string;
    config_type: 'percentage_cap' | 'flat' | 'flat_conditional' | 'range';
    config: any;
    currency: string;
}

export async function getFeeConfiguration(feeType: string): Promise<FeeConfig | null> {
    const res = await query(
        `SELECT * FROM fee_configurations WHERE fee_type = $1 LIMIT 1`,
        [feeType]
    );
    return res.rows[0] || null;
}

export async function calculateFee(amount: number, feeType: string): Promise<number> {
    const feeConfig = await getFeeConfiguration(feeType);
    if (!feeConfig) return 0;

    const { config_type, config } = feeConfig;

    switch (config_type) {
        case 'percentage_cap':
            // config: { percentage: number, cap: number }
            const percentageFee = amount * (config.percentage / 100);
            return config.cap ? Math.min(percentageFee, config.cap) : percentageFee;

        case 'flat':
            // config: { amount: number }
            return Number(config.amount);

        case 'flat_conditional':
            // config: { conditions: [{ operator: '>' | '<' | '>=' | '<=', threshold: number, fee: number }] }
            if (Array.isArray(config.conditions)) {
                for (const cond of config.conditions) {
                    if (cond.operator === '>' && amount > cond.threshold) return Number(cond.fee);
                    if (cond.operator === '<' && amount < cond.threshold) return Number(cond.fee);
                    if (cond.operator === '>=' && amount >= cond.threshold) return Number(cond.fee);
                    if (cond.operator === '<=' && amount <= cond.threshold) return Number(cond.fee);
                }
            }
            return 0; // Default if no condition met

        case 'range':
            // config: { ranges: [{ min: number, max: number, fee: number }] }
            if (Array.isArray(config.ranges)) {
                for (const range of config.ranges) {
                    if (amount >= range.min && amount <= range.max) {
                        return Number(range.fee);
                    }
                }
            }
            return 0;

        default:
            return 0;
    }
}

export async function getAllFees() {
    const res = await query(`SELECT * FROM fee_configurations ORDER BY created_at DESC`);
    return res.rows;
}

export async function createFee(data: any) {
    const { name, fee_type, config_type, config, currency } = data;
    const res = await query(
        `INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [name, fee_type, config_type, config, currency || 'NGN']
    );
    return res.rows[0];
}

export async function updateFee(id: string, data: any) {
    const { name, fee_type, config_type, config, currency } = data;
    const res = await query(
        `UPDATE fee_configurations 
         SET name = $1, fee_type = $2, config_type = $3, config = $4, currency = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6
         RETURNING *`,
        [name, fee_type, config_type, config, currency, id]
    );
    return res.rows[0];
}

export async function deleteFee(id: string) {
    await query(`DELETE FROM fee_configurations WHERE id = $1`, [id]);
}

export async function creditPlatformWallet(amount: number, currency: string = 'NGN') {
    if (amount === 0) return;
    
    // Ensure wallet exists
    let walletRes = await query(`SELECT id FROM platform_wallet WHERE currency = $1 LIMIT 1`, [currency]);
    if (walletRes.rows.length === 0) {
        // Create if not exists (though migration should have handled NGN)
        const newWallet = await query(
            `INSERT INTO platform_wallet (balance, currency) VALUES (0, $1) RETURNING id`, 
            [currency]
        );
        walletRes = newWallet;
    }
    
    const walletId = walletRes.rows[0].id;
    
    await query(
        `UPDATE platform_wallet SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [amount, walletId]
    );
}

export async function debitPlatformWallet(amount: number, currency: string = 'NGN') {
    if (amount <= 0) return;
    await creditPlatformWallet(-amount, currency);
}
