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

/**
 * Best-effort provider attribution from a payment reference prefix.
 * Platform mirror rows (which never carry payment_provider explicitly) use
 * this so the admin ledger shows the gateway that actually processed the
 * money instead of a stale column default.
 */
export function inferProviderFromReference(reference?: string | null): string | null {
    if (!reference) return null;
    const ref = String(reference).toUpperCase();
    if (ref.startsWith('FLW') || ref.includes('FLUTTERWAVE')) return 'flutterwave';
    if (ref.startsWith('MNFY') || ref.includes('MONNIFY')) return 'monnify';
    if (ref.startsWith('SB-') || ref.startsWith('SQUAD') || ref.includes('SQUAD')) return 'squad';
    return null;
}

async function getOrCreateInternalWallet(currency: string): Promise<string> {
    // Operational/Platform Wallet (intermediary funds) - business_id & user_id NULL
    const walletRes = await query(`SELECT id FROM wallets WHERE business_id IS NULL AND user_id IS NULL AND currency = $1 LIMIT 1`, [currency]);
    if (walletRes.rows.length > 0) return walletRes.rows[0].id;
    const newWallet = await query(
        `INSERT INTO wallets (balance, currency, status) VALUES (0, $1, 'active') RETURNING id`,
        [currency]
    );
    return newWallet.rows[0].id;
}

/**
 * Record a platform-ledger movement in `transactions` so the admin Platform
 * Ledger history shows EVERY credit/debit (previously only balances moved and
 * the ledger looked like it "only shows fee debits"). Idempotent by reference.
 */
async function recordPlatformTransaction(
    walletId: string,
    amount: number,
    currency: string,
    reference: string | undefined,
    description: string,
    provider?: string | null,
): Promise<void> {
    if (amount === 0) return;
    const direction = amount > 0 ? 'credit' : 'debit';
    const ref = reference || `platform-${direction}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const resolvedProvider = provider || inferProviderFromReference(ref);

    const existing = await query(
        `SELECT id FROM transactions WHERE reference = $1 AND wallet_id = $2 AND transaction_type = 'platform' LIMIT 1`,
        [ref, walletId]
    );
    if (existing.rows.length > 0) return;

    await query(
        `INSERT INTO transactions
         (amount, currency, status, reference, type, description, transaction_type, wallet_id, direction, payment_provider)
         VALUES ($1, $2, 'success', $3, $4, $5, 'platform', $6, $7, $8)`,
        [Math.abs(amount), currency, ref, direction, description, walletId, direction, resolvedProvider]
    );
}

export async function creditPlatformWallet(
    amount: number,
    currency: string = 'NGN',
    reference?: string,
    description?: string,
    provider?: string | null,
) {
    // This is the Operational Wallet (Intermediary funds)
    if (amount === 0) return;

    const walletId = await getOrCreateInternalWallet(currency);

    await query(
        `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [amount, walletId]
    );

    await recordPlatformTransaction(
        walletId,
        amount,
        currency,
        reference,
        description || (amount > 0 ? 'Platform Wallet Credit' : 'Platform Wallet Debit'),
        provider,
    );
}

export async function debitPlatformWallet(
    amount: number,
    currency: string = 'NGN',
    reference?: string,
    description?: string,
    provider?: string | null,
) {
    if (amount <= 0) return;
    await creditPlatformWallet(-amount, currency, reference, description, provider);
}

export async function creditRevenueWallet(
    amount: number,
    currency: string = 'NGN',
    reference?: string,
    description?: string,
    provider?: string | null,
    mirrorDescription?: string,
) {
    // This is the Revenue Wallet (platform_wallet table)
    if (amount === 0) return;

    const sign = amount >= 0 ? 1 : -1;
    const absAmount = Math.abs(amount);
    const resolvedProvider = provider || inferProviderFromReference(reference);

    // 1. Move the fee in/out of the operational platform wallet - WITH a
    //    ledger row so the Platform Ledger shows the fee movement too.
    const platformWalletId = await getOrCreateInternalWallet(currency);
    await query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [amount, platformWalletId]
    );
    await recordPlatformTransaction(
        platformWalletId,
        -amount,
        currency,
        reference,
        mirrorDescription || (sign > 0 ? 'Platform Wallet Debit for Revenue' : 'Platform Wallet Credit (Revenue Reversal)'),
        resolvedProvider,
    );

    // 2. Mirror the movement into the revenue wallet balance.
    let walletRes = await query(`SELECT id FROM platform_wallet WHERE currency = $1 LIMIT 1`, [currency]);

    if (walletRes.rows.length === 0) {
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

    // 3. Record the revenue movement itself as a transaction row so the
    //    Revenue Ledger history reflects fee credits (type 'fee' keeps it
    //    consistent with the admin revenue balance aggregation).
    const revenueRef = reference
        ? `${reference}-REVENUE-CREDIT`
        : `revenue-credit-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const existingRevenue = await query(
        `SELECT id FROM transactions WHERE reference = $1 AND transaction_type = 'fee' AND type = 'credit' LIMIT 1`,
        [revenueRef]
    );
    if (existingRevenue.rows.length === 0) {
        await query(
            `INSERT INTO transactions
             (amount, currency, status, reference, type, description, transaction_type, direction, payment_provider)
             VALUES ($1, $2, 'success', $3, 'credit', $4, 'fee', 'credit', $5)`,
            [absAmount, currency, revenueRef, description || 'Revenue Credit (fee)', resolvedProvider]
        );
    }
}

export async function debitRevenueWallet(
    amount: number,
    currency: string = 'NGN',
    reference?: string,
    description?: string,
    provider?: string | null,
) {
    if (amount <= 0) return;
    await creditRevenueWallet(-amount, currency, reference, description || 'Revenue Debit (refund/reversal)', provider);
}
