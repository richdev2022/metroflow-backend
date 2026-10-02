import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../middleware/auth";
import { calculateFee, creditPlatformWallet, debitPlatformWallet, creditRevenueWallet } from "../services/fees";
import { createNotification } from "../services/notifications";

const router = express.Router();

/**
 * Savings Vaults — the fifth REVENUE feature (daily-use).
 *
 * Users create goal-based savings vaults, fund them from any of their wallets
 * and can switch on auto-save (daily/weekly/monthly) that pulls from a chosen
 * wallet — keeping them in the app every single day. Withdrawing before the
 * vault's target date charges an early-break fee (fee_configurations
 * 'savings_break' — 2% capped ₦5,000 by default, reduced by the plan-level
 * savings_break_fee_discount_percent) which lands in the platform revenue
 * wallet. Every money move is mirrored into the platform transactions table
 * (transaction_type 'savings_deposit' | 'savings_withdrawal') and the
 * double-entry platform ledger.
 *
 * Plan configuration (pricing_plans, admin-editable via /admin/pricing):
 *   - savings_enabled                    (feature toggle)
 *   - max_savings_vaults                 (NULL/999999+ = unlimited)
 *   - savings_break_fee_discount_percent
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
type Frequency = (typeof FREQUENCIES)[number];

function getPlanConfig(businessId: string) {
    return query(
        `SELECT p.savings_enabled, p.max_savings_vaults, p.savings_break_fee_discount_percent
         FROM businesses b JOIN pricing_plans p ON p.id = b.plan_id
         WHERE b.id = $1`,
        [businessId]
    ).then((r) => r.rows[0] || null);
}

function effectiveFee(baseFee: number, discountPercent: number): number {
    if (!(baseFee > 0)) return 0;
    const reduced = baseFee * (1 - Math.min(Math.max(discountPercent, 0), 100) / 100);
    return Math.max(0, Math.round(reduced * 100) / 100);
}

function nextRunAt(frequency: Frequency, from = new Date()): Date {
    const next = new Date(from);
    if (frequency === "daily") next.setDate(next.getDate() + 1);
    else if (frequency === "weekly") next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
    return next;
}

function randomReference(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Resolve an owned wallet (business wallet of this business, or personal wallet of this user). */
async function getOwnedWallet(walletId: string, businessId: string, userId: string) {
    const res = await query(
        `SELECT * FROM wallets WHERE id = $1 AND (business_id = $2 OR (user_id = $3 AND business_id IS NULL))`,
        [walletId, businessId, userId]
    );
    return res.rows[0] || null;
}

/** Insert the wallet-facing platform transaction row for a savings move. */
async function recordTransaction(opts: {
    businessId: string | null;
    userId: string;
    walletId: string;
    reference: string;
    type: "savings_deposit" | "savings_withdrawal" | "savings_break_fee";
    direction: "debit" | "credit";
    amount: number;
    currency: string;
    description: string;
    fee?: number;
}) {
    await query(
        `INSERT INTO transactions
         (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction, fee)
         VALUES ($1, $2, $3, $4, $5, 'success', $6, $7, $8, $9, $10, $11)`,
        [
            opts.businessId, opts.userId, opts.amount, opts.currency, opts.reference,
            opts.direction, opts.description, opts.type, opts.walletId, opts.direction, opts.fee ?? 0,
        ]
    );
}

// ---------------------------------------------------------------------------
// Vault endpoints
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /savings/vaults:
 *   get:
 *     summary: List the caller's savings vaults with progress + stats
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Vaults (newest first) with aggregate stats
 */
router.get("/vaults", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const vaults = await query(
            `SELECT v.*, w.currency AS auto_save_wallet_currency,
                    COALESCE((SELECT COUNT(*)::int FROM savings_transactions t WHERE t.vault_id = v.id AND t.type IN ('deposit', 'auto_save')), 0) AS deposit_count
             FROM savings_vaults v
             LEFT JOIN wallets w ON w.id = v.auto_save_wallet_id
             WHERE v.user_id = $1 OR v.business_id = $2
             ORDER BY v.created_at DESC
             LIMIT 100`,
            [userId, businessId]
        );
        const stats = await query(
            `SELECT COUNT(*)::int AS total_vaults,
                    COALESCE(SUM(balance), 0) AS total_saved,
                    COALESCE(SUM(CASE WHEN auto_save_enabled AND status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_auto_saves
             FROM savings_vaults WHERE user_id = $1 OR business_id = $2`,
            [userId, businessId]
        );
        res.json({ success: true, vaults: vaults.rows, stats: stats.rows[0] });
    } catch (error) {
        console.error("List vaults error:", error);
        res.status(500).json({ success: false, error: "Failed to load savings vaults" });
    }
});

/**
 * @openapi
 * /savings/vaults:
 *   post:
 *     summary: Create a savings vault (plan-gated)
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: New Shop Rent
 *               goal_amount:
 *                 type: number
 *               target_date:
 *                 type: string
 *                 format: date
 *                 description: Withdrawals before this date attract the early-break fee
 *               auto_save_enabled:
 *                 type: boolean
 *               auto_save_amount:
 *                 type: number
 *               auto_save_frequency:
 *                 type: string
 *                 enum: [daily, weekly, monthly]
 *               auto_save_wallet_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Vault created
 *       403:
 *         description: Savings disabled or vault limit reached on the current plan (PLAN_UPGRADE_REQUIRED)
 */
router.post("/vaults", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { userId, businessId } = req.user!;
        const {
            name, goal_amount, target_date,
            auto_save_enabled, auto_save_amount, auto_save_frequency, auto_save_wallet_id,
        } = req.body || {};

        const vaultName = String(name || "").trim();
        if (!vaultName) return res.status(400).json({ success: false, error: "Give your vault a name" });
        if (vaultName.length > 120) return res.status(400).json({ success: false, error: "Vault name is too long" });

        // ---- Plan gating ----
        const plan = await getPlanConfig(businessId);
        if (plan && plan.savings_enabled === false) {
            return res.status(403).json({
                success: false,
                error: "Savings vaults are not available on your current plan. Kindly upgrade your plan.",
                code: "PLAN_UPGRADE_REQUIRED",
            });
        }
        if (plan?.max_savings_vaults != null && plan.max_savings_vaults < 999999) {
            const countRes = await query(
                `SELECT COUNT(*)::int AS c FROM savings_vaults
                 WHERE business_id = $1 AND status IN ('active', 'paused')`,
                [businessId]
            );
            if (countRes.rows[0].c >= plan.max_savings_vaults) {
                return res.status(403).json({
                    success: false,
                    error: `Your plan allows up to ${plan.max_savings_vaults} savings vault(s). Kindly upgrade your plan for more vaults.`,
                    code: "PLAN_UPGRADE_REQUIRED",
                });
            }
        }

        // ---- Optional auto-save config ----
        const autoSave = auto_save_enabled === true;
        let autoSaveWalletId: string | null = null;
        let frequency: Frequency | null = null;
        let autoSaveAmount: number | null = null;
        if (autoSave) {
            frequency = FREQUENCIES.includes(auto_save_frequency) ? auto_save_frequency : null;
            autoSaveAmount = Math.round(Number(auto_save_amount) * 100) / 100;
            if (!frequency || !autoSaveAmount || autoSaveAmount <= 0) {
                return res.status(400).json({ success: false, error: "Choose an auto-save amount and frequency" });
            }
            const wallet = auto_save_wallet_id ? await getOwnedWallet(String(auto_save_wallet_id), businessId, userId) : null;
            if (!wallet) {
                return res.status(400).json({ success: false, error: "Pick one of your wallets for auto-save" });
            }
            autoSaveWalletId = wallet.id;
        }

        const goalAmount = goal_amount != null && Number(goal_amount) > 0 ? Math.round(Number(goal_amount) * 100) / 100 : null;
        const targetDate = target_date ? String(target_date).slice(0, 10) : null;

        const insertRes = await query(
            `INSERT INTO savings_vaults
             (business_id, user_id, name, goal_amount, target_date,
              auto_save_enabled, auto_save_amount, auto_save_frequency, auto_save_wallet_id, auto_save_next_run)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                businessId || null, userId, vaultName, goalAmount, targetDate,
                autoSave, autoSaveAmount, autoSave ? frequency : null, autoSaveWalletId,
                autoSave && frequency ? nextRunAt(frequency) : null,
            ]
        );
        res.json({ success: true, vault: insertRes.rows[0] });
    } catch (error) {
        console.error("Create vault error:", error);
        res.status(500).json({ success: false, error: "Failed to create savings vault" });
    }
});

/**
 * @openapi
 * /savings/vaults/{id}:
 *   get:
 *     summary: Vault detail with its transaction history
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Vault + transactions
 *       404:
 *         description: Vault not found
 */
router.get("/vaults/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const { userId, businessId } = req.user!;
        const vaultRes = await query(
            `SELECT v.*, w.currency AS auto_save_wallet_currency
             FROM savings_vaults v LEFT JOIN wallets w ON w.id = v.auto_save_wallet_id
             WHERE v.id = $1 AND (v.user_id = $2 OR v.business_id = $3)`,
            [id, userId, businessId]
        );
        const vault = vaultRes.rows[0];
        if (!vault) return res.status(404).json({ success: false, error: "Vault not found" });

        const history = await query(
            `SELECT * FROM savings_transactions WHERE vault_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [id]
        );
        res.json({ success: true, vault, transactions: history.rows });
    } catch (error) {
        console.error("Vault detail error:", error);
        res.status(500).json({ success: false, error: "Failed to load vault" });
    }
});

/**
 * @openapi
 * /savings/vaults/{id}:
 *   put:
 *     summary: Update a vault (name, goal, target date, auto-save settings, pause/resume)
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               goal_amount: { type: number }
 *               target_date: { type: string, format: date }
 *               status: { type: string, enum: [active, paused] }
 *               auto_save_enabled: { type: boolean }
 *               auto_save_amount: { type: number }
 *               auto_save_frequency: { type: string, enum: [daily, weekly, monthly] }
 *               auto_save_wallet_id: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated vault
 *       404:
 *         description: Vault not found
 */
router.put("/vaults/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const { userId, businessId } = req.user!;
        const vaultRes = await query(
            `SELECT * FROM savings_vaults WHERE id = $1 AND (user_id = $2 OR business_id = $3)`,
            [id, userId, businessId]
        );
        const vault = vaultRes.rows[0];
        if (!vault) return res.status(404).json({ success: false, error: "Vault not found" });
        if (vault.status === "closed") return res.status(400).json({ success: false, error: "This vault is closed" });

        const {
            name, goal_amount, target_date, status,
            auto_save_enabled, auto_save_amount, auto_save_frequency, auto_save_wallet_id,
        } = req.body || {};

        // Auto-save reconfiguration (only when the payload touches it)
        let autoSaveEnabled = vault.auto_save_enabled;
        let autoSaveAmount = vault.auto_save_amount;
        let autoSaveFrequency: string | null = vault.auto_save_frequency;
        let autoSaveWalletId: string | null = vault.auto_save_wallet_id;
        let autoSaveNextRun: Date | null = vault.auto_save_next_run;

        if (auto_save_enabled !== undefined || auto_save_amount !== undefined || auto_save_frequency !== undefined || auto_save_wallet_id !== undefined) {
            autoSaveEnabled = auto_save_enabled === true;
            if (autoSaveEnabled) {
                autoSaveAmount = auto_save_amount != null ? Math.round(Number(auto_save_amount) * 100) / 100 : autoSaveAmount;
                autoSaveFrequency = auto_save_frequency != null && FREQUENCIES.includes(auto_save_frequency) ? auto_save_frequency : autoSaveFrequency;
                if (auto_save_wallet_id) {
                    const wallet = await getOwnedWallet(String(auto_save_wallet_id), businessId, userId);
                    if (!wallet) return res.status(400).json({ success: false, error: "Pick one of your wallets for auto-save" });
                    autoSaveWalletId = wallet.id;
                }
                if (!autoSaveAmount || autoSaveAmount <= 0 || !autoSaveFrequency || !autoSaveWalletId) {
                    return res.status(400).json({ success: false, error: "Auto-save needs an amount, frequency and wallet" });
                }
                autoSaveNextRun = nextRunAt(autoSaveFrequency as Frequency);
            } else {
                autoSaveNextRun = null;
            }
        }

        const nextStatus = status === "paused" ? "paused" : status === "active" ? "active" : vault.status;
        const updated = await query(
            `UPDATE savings_vaults SET
                name = COALESCE($2, name),
                goal_amount = $3,
                target_date = COALESCE($4, target_date),
                status = $5,
                auto_save_enabled = $6,
                auto_save_amount = $7,
                auto_save_frequency = $8,
                auto_save_wallet_id = $9,
                auto_save_next_run = $10,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING *`,
            [
                id,
                name != null && String(name).trim() ? String(name).trim() : null,
                goal_amount != null ? (Number(goal_amount) > 0 ? Math.round(Number(goal_amount) * 100) / 100 : null) : vault.goal_amount,
                target_date != null ? String(target_date).slice(0, 10) : null,
                nextStatus,
                autoSaveEnabled, autoSaveAmount, autoSaveFrequency, autoSaveWalletId, autoSaveNextRun,
            ]
        );
        res.json({ success: true, vault: updated.rows[0] });
    } catch (error) {
        console.error("Update vault error:", error);
        res.status(500).json({ success: false, error: "Failed to update vault" });
    }
});

/**
 * @openapi
 * /savings/vaults/{id}:
 *   delete:
 *     summary: Delete a vault (only when its balance is zero)
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Vault deleted
 *       400:
 *         description: Vault still has funds
 */
router.delete("/vaults/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const { userId, businessId } = req.user!;
        const vaultRes = await query(
            `SELECT balance FROM savings_vaults WHERE id = $1 AND (user_id = $2 OR business_id = $3)`,
            [id, userId, businessId]
        );
        const vault = vaultRes.rows[0];
        if (!vault) return res.status(404).json({ success: false, error: "Vault not found" });
        if (Number(vault.balance) > 0) {
            return res.status(400).json({ success: false, error: "Withdraw the funds before deleting this vault" });
        }
        await query(`DELETE FROM savings_vaults WHERE id = $1`, [id]);
        res.json({ success: true, message: "Vault deleted" });
    } catch (error) {
        console.error("Delete vault error:", error);
        res.status(500).json({ success: false, error: "Failed to delete vault" });
    }
});

/**
 * @openapi
 * /savings/vaults/{id}/deposit:
 *   post:
 *     summary: Fund a vault from one of your wallets
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, wallet_id]
 *             properties:
 *               amount: { type: number }
 *               wallet_id: { type: string, format: uuid }
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Deposit settled into the vault
 *       400:
 *         description: Insufficient balance or invalid vault/wallet
 */
router.post("/vaults/:id/deposit", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const { userId, businessId } = req.user!;
        const { amount, wallet_id, note } = req.body || {};

        const depositAmount = Math.round(Number(amount) * 100) / 100;
        if (!depositAmount || depositAmount <= 0) {
            return res.status(400).json({ success: false, error: "Enter a valid amount" });
        }

        const vaultRes = await query(
            `SELECT * FROM savings_vaults WHERE id = $1 AND (user_id = $2 OR business_id = $3)`,
            [id, userId, businessId]
        );
        const vault = vaultRes.rows[0];
        if (!vault) return res.status(404).json({ success: false, error: "Vault not found" });
        if (vault.status === "closed") return res.status(400).json({ success: false, error: "This vault is closed" });

        const wallet = await getOwnedWallet(String(wallet_id || ""), businessId, userId);
        if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });

        const debit = await query(
            `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND balance >= $1 RETURNING balance`,
            [depositAmount, wallet.id]
        );
        if (debit.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Insufficient wallet balance", code: "INSUFFICIENT_BALANCE" });
        }

        const reference = randomReference("SAVD");
        const vaultUpdate = await query(
            `UPDATE savings_vaults
             SET balance = balance + $2, total_deposited = total_deposited + $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING balance`,
            [vault.id, depositAmount]
        );
        const balanceAfter = Number(vaultUpdate.rows[0].balance);

        await query(
            `INSERT INTO savings_transactions (vault_id, type, amount, fee, balance_after, wallet_id, reference, note)
             VALUES ($1, $2, $3, 0, $4, $5, $6, $7)`,
            [vault.id, "deposit", depositAmount, balanceAfter, wallet.id, reference, note ? String(note).slice(0, 300) : null]
        );
        await recordTransaction({
            businessId: (wallet.business_id as string) || null,
            userId,
            walletId: wallet.id,
            reference,
            type: "savings_deposit",
            direction: "debit",
            amount: depositAmount,
            currency: wallet.currency || "NGN",
            description: `Savings deposit — ${vault.name}`,
        });

        // Goal completion celebration
        if (vault.goal_amount && Number(vault.goal_amount) > 0 && balanceAfter >= Number(vault.goal_amount)) {
            try {
                await createNotification({
                    businessId,
                    userId,
                    type: "system",
                    title: "Goal reached 🎉",
                    message: `Congratulations! Your "${vault.name}" vault reached its ₦${Number(vault.goal_amount).toLocaleString()} goal.`,
                    actionUrl: "/savings",
                    actionType: "view_vault",
                    metadata: { vaultId: vault.id, balance: balanceAfter },
                    isActionable: false,
                    expiresInHours: 168,
                });
            } catch { /* notification is best-effort */ }
        }

        res.json({ success: true, vault_balance: balanceAfter, reference });
    } catch (error) {
        console.error("Vault deposit error:", error);
        res.status(500).json({ success: false, error: "Failed to fund vault" });
    }
});

/**
 * @openapi
 * /savings/vaults/{id}/withdraw:
 *   post:
 *     summary: Withdraw from a vault to a wallet (early withdrawal charges the break fee)
 *     tags: [Savings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, wallet_id]
 *             properties:
 *               amount: { type: number }
 *               wallet_id: { type: string, format: uuid }
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Withdrawal settled (fee included when breaking early)
 *       400:
 *         description: Amount exceeds balance or invalid vault/wallet
 */
router.post("/vaults/:id/withdraw", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const { userId, businessId } = req.user!;
        const { amount, wallet_id, note } = req.body || {};

        const withdrawAmount = Math.round(Number(amount) * 100) / 100;
        if (!withdrawAmount || withdrawAmount <= 0) {
            return res.status(400).json({ success: false, error: "Enter a valid amount" });
        }

        const vaultRes = await query(
            `SELECT * FROM savings_vaults WHERE id = $1 AND (user_id = $2 OR business_id = $3)`,
            [id, userId, businessId]
        );
        const vault = vaultRes.rows[0];
        if (!vault) return res.status(404).json({ success: false, error: "Vault not found" });
        if (vault.status === "closed") return res.status(400).json({ success: false, error: "This vault is closed" });
        if (withdrawAmount > Number(vault.balance)) {
            return res.status(400).json({ success: false, error: "Amount exceeds your vault balance", code: "INSUFFICIENT_BALANCE" });
        }

        const wallet = await getOwnedWallet(String(wallet_id || ""), businessId, userId);
        if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });

        // ---- Early-break fee (waived once the target date has passed) ----
        const isEarlyBreak = !!vault.target_date && new Date(vault.target_date) > new Date(new Date().toDateString());
        let fee = 0;
        if (isEarlyBreak) {
            const baseFee = await calculateFee(withdrawAmount, "savings_break");
            const plan = await getPlanConfig(businessId);
            fee = effectiveFee(baseFee, Number(plan?.savings_break_fee_discount_percent) || 0);
        }
        const payout = Math.max(0, Math.round((withdrawAmount - fee) * 100) / 100);

        // Claim the vault funds first (idempotency gate against double withdraw).
        const vaultUpdate = await query(
            `UPDATE savings_vaults
             SET balance = balance - $2, total_withdrawn = total_withdrawn + $2,
                 withdrawn_at = CASE WHEN balance - $2 <= 0 THEN CURRENT_TIMESTAMP ELSE withdrawn_at END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND balance >= $2 RETURNING balance`,
            [vault.id, withdrawAmount]
        );
        if (vaultUpdate.rows.length === 0) {
            return res.status(400).json({ success: false, error: "Amount exceeds your vault balance", code: "INSUFFICIENT_BALANCE" });
        }
        const balanceAfter = Number(vaultUpdate.rows[0].balance);

        // Credit the wallet the payout (amount minus fee)
        const credit = await query(
            `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING balance`,
            [payout, wallet.id]
        );

        const reference = randomReference("SAVW");
        await query(
            `INSERT INTO savings_transactions (vault_id, type, amount, fee, balance_after, wallet_id, reference, note)
             VALUES ($1, 'withdrawal', $2, $3, $4, $5, $6, $7)`,
            [vault.id, withdrawAmount, fee, balanceAfter, wallet.id, reference, note ? String(note).slice(0, 300) : (isEarlyBreak && fee > 0 ? "Early withdrawal" : null)]
        );
        await recordTransaction({
            businessId: (wallet.business_id as string) || null,
            userId,
            walletId: wallet.id,
            reference,
            type: "savings_withdrawal",
            direction: "credit",
            amount: payout,
            currency: wallet.currency || "NGN",
            description: `Savings withdrawal — ${vault.name}${fee > 0 ? ` (early-break fee: ${fee})` : ""}`,
            fee,
        });

        // Double-entry platform ledger + revenue for the break fee
        await creditPlatformWallet(withdrawAmount, wallet.currency || "NGN", reference, "Savings Withdrawal Received", "savings");
        await debitPlatformWallet(payout, wallet.currency || "NGN", `${reference}-PAYOUT`, "Platform Wallet Debit for Savings Payout", "savings");
        if (fee > 0) {
            await creditRevenueWallet(fee, wallet.currency || "NGN", reference, "Savings Early Withdrawal Fee", "savings");
        }

        res.json({
            success: true,
            vault_balance: balanceAfter,
            wallet_balance: Number(credit.rows[0].balance),
            fee,
            payout,
            early_break: isEarlyBreak && fee > 0,
            reference,
        });
    } catch (error) {
        console.error("Vault withdrawal error:", error);
        res.status(500).json({ success: false, error: "Failed to withdraw from vault" });
    }
});

// ---------------------------------------------------------------------------
// Auto-save engine — driven by a 5-minute cron in server/index.ts. Idempotent:
// each due vault claims its next_run slot BEFORE the money moves, so a crash
// can never double-charge a wallet.
// ---------------------------------------------------------------------------

export async function processDueAutoSaves(limit = 50): Promise<{ processed: number; succeeded: number; failed: number }> {
    const dueRes = await query(
        `SELECT v.*, u.business_id AS user_business_id
         FROM savings_vaults v
         LEFT JOIN users u ON u.id = v.user_id
         WHERE v.auto_save_enabled = TRUE AND v.status = 'active'
           AND v.auto_save_next_run IS NOT NULL AND v.auto_save_next_run <= CURRENT_TIMESTAMP
         ORDER BY v.auto_save_next_run ASC
         LIMIT $1`,
        [limit]
    );
    if (dueRes.rows.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;

    for (const vault of dueRes.rows) {
        const frequency = String(vault.auto_save_frequency || "daily") as Frequency;
        const amount = Number(vault.auto_save_amount);

        // Claim the next slot first — this is the idempotency gate.
        const claimed = await query(
            `UPDATE savings_vaults
             SET auto_save_next_run = $2, auto_save_last_run = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND auto_save_next_run = $3
             RETURNING id`,
            [vault.id, nextRunAt(frequency), vault.auto_save_next_run]
        );
        if (claimed.rows.length === 0) continue; // another worker took it

        if (!amount || amount <= 0 || !vault.auto_save_wallet_id) {
            failed++;
            continue;
        }

        const walletRes = await query(`SELECT * FROM wallets WHERE id = $1`, [vault.auto_save_wallet_id]);
        const wallet = walletRes.rows[0];
        const ownerId = vault.user_id || vault.user_business_id;

        if (!wallet) {
            await query(
                `UPDATE savings_vaults SET auto_save_failures = auto_save_failures + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [vault.id]
            );
            failed++;
            continue;
        }

        const debit = await query(
            `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND balance >= $1 RETURNING balance`,
            [amount, wallet.id]
        );
        if (debit.rows.length === 0) {
            // Wallet underfunded — count the miss; auto-save stays on for next cycle.
            await query(
                `UPDATE savings_vaults SET auto_save_failures = auto_save_failures + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [vault.id]
            );
            failed++;
            continue;
        }

        const reference = randomReference("SAVA");
        const vaultUpdate = await query(
            `UPDATE savings_vaults
             SET balance = balance + $2, total_deposited = total_deposited + $2, auto_save_failures = 0, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 RETURNING balance`,
            [vault.id, amount]
        );
        const balanceAfter = Number(vaultUpdate.rows[0].balance);

        await query(
            `INSERT INTO savings_transactions (vault_id, type, amount, fee, balance_after, wallet_id, reference, note)
             VALUES ($1, 'auto_save', $2, 0, $3, $4, $5, $6)`,
            [vault.id, amount, balanceAfter, wallet.id, reference, `Auto-save (${frequency})`]
        );
        await recordTransaction({
            businessId: (wallet.business_id as string) || vault.business_id || null,
            userId: ownerId,
            walletId: wallet.id,
            reference,
            type: "savings_deposit",
            direction: "debit",
            amount,
            currency: wallet.currency || "NGN",
            description: `Auto-save (${frequency}) — ${vault.name}`,
        });

        try {
            await createNotification({
                businessId: vault.business_id || vault.user_business_id,
                userId: ownerId,
                type: "debit",
                title: "Auto-save complete",
                message: `${amount.toLocaleString()} ${wallet.currency || "NGN"} moved into your "${vault.name}" vault (balance: ${balanceAfter.toLocaleString()}).`,
                actionUrl: "/savings",
                actionType: "view_vault",
                metadata: { vaultId: vault.id, amount, balance: balanceAfter },
                isActionable: false,
                expiresInHours: 48,
            });
        } catch { /* best-effort */ }

        succeeded++;
    }

    return { processed: dueRes.rows.length, succeeded, failed };
}

export default router;
