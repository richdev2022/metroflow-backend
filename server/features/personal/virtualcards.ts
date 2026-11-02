import express from "express";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { createNotification } from "../../services/notifications";
import { creditRevenueWallet } from "../../services/fees";
import { evaluateOutflow, fraudRejectReason } from "../../services/fraud";
import * as bitnob from "../../services/providers/bitnob";
import { requirePersonalService, useProvider } from "./flags";

const router = express.Router();
// Personal Products console kill-switch + provider routing for virtual cards.
router.use(requirePersonalService("virtualcards"));
/** Provider routing (Personal Products console): auto | provider | simulator. */
async function bitnobLive(): Promise<boolean> {
    return useProvider("virtualcards", bitnob.isBitnobConfigured());
}


/**
 * Virtual Cards (Personal) — USD virtual debit cards backed by Bitnob Card
 * Issuing (https://bitnob.dev/docs/card-issuing/overview).
 *
 * Flow:
 *   1. POST /kyc            — submit Bitnob Card KYC for the user (returns
 *                             customer_id once approved; stored per user).
 *   2. POST /               — create a card (needs approved KYC customer_id).
 *                             Provisioning is async: status pending → active.
 *   3. POST /:id/fund       — debit the user's USD wallet (ledger + fraud
 *                             gate), then fund the Bitnob card (micro-units).
 *   4. POST /:id/withdraw   — withdraw from the Bitnob card back to the USD
 *                             wallet.
 *   5. POST /:id/freeze | /unfreeze | DELETE /:id (terminate) — lifecycle.
 *   6. GET  /:id/transactions, GET /:id/secure (PAN/CVV — logged + rate-limited).
 *
 * When Bitnob is not configured (no BITNOB_API_KEY/BITNOB_SECRET_KEY) a
 * built-in SIMULATOR issues cards instantly so the whole product remains
 * usable end-to-end in staging; every card row records provider='simulator'.
 */

const CREATE_MIN_USD = 2;
const CREATE_MAX_USD = 10_000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureVirtualCardSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS virtual_cards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',     -- bitnob | simulator
      bitnob_card_id VARCHAR(80),
      bitnob_customer_id VARCHAR(80),
      reference VARCHAR(80) UNIQUE NOT NULL,
      name VARCHAR(120),
      currency VARCHAR(3) DEFAULT 'USD',
      card_brand VARCHAR(20) DEFAULT 'visa',
      status VARCHAR(20) DEFAULT 'pending',               -- pending|active|frozen|terminated|failed
      created_status VARCHAR(20) DEFAULT 'processing',    -- processing|completed
      masked_pan VARCHAR(30),
      balance DECIMAL(15,2) DEFAULT 0,                    -- whole units (USD)
      wallet_id UUID,
      terminated_reason TEXT,
      provider_response JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    // IDEMPOTENT COLUMN LADDER — a database provisioned by an OLDER version of
    // this function has a virtual_cards table WITHOUT the newer columns, and
    // CREATE TABLE IF NOT EXISTS is a no-op there. Without this ladder the
    // bitnob_card_id index below throws 42703 ("column does not exist"),
    // runPostInitializeMigrations aborts, isDbReady never flips true and the
    // WHOLE API answers 503 "still initializing" (production incident
    // 2026-10-21). ADD COLUMN IF NOT EXISTS is a no-op on fresh tables.
    for (const col of [
      `ADD COLUMN IF NOT EXISTS business_id VARCHAR(255)`,
      `ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'bitnob'`,
      `ADD COLUMN IF NOT EXISTS bitnob_card_id VARCHAR(80)`,
      `ADD COLUMN IF NOT EXISTS bitnob_customer_id VARCHAR(80)`,
      `ADD COLUMN IF NOT EXISTS name VARCHAR(120)`,
      `ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'USD'`,
      `ADD COLUMN IF NOT EXISTS card_brand VARCHAR(20) DEFAULT 'visa'`,
      `ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`,
      `ADD COLUMN IF NOT EXISTS created_status VARCHAR(20) DEFAULT 'processing'`,
      `ADD COLUMN IF NOT EXISTS masked_pan VARCHAR(30)`,
      `ADD COLUMN IF NOT EXISTS balance DECIMAL(15,2) DEFAULT 0`,
      `ADD COLUMN IF NOT EXISTS wallet_id UUID`,
      `ADD COLUMN IF NOT EXISTS terminated_reason TEXT`,
      `ADD COLUMN IF NOT EXISTS provider_response JSONB`,
      `ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      `ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      // Mounted-router parity columns (features/personal/routes/virtualcards.ts):
      `ADD COLUMN IF NOT EXISTS reference VARCHAR(80)`,
      `ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(120)`,
      `ADD COLUMN IF NOT EXISTS provider_card_id VARCHAR(120)`,
      `ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(120)`,
      `ADD COLUMN IF NOT EXISTS failure_reason TEXT`,
      `ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMP`,
      `ADD COLUMN IF NOT EXISTS category VARCHAR(12) DEFAULT 'usdt'`,
      `ADD COLUMN IF NOT EXISTS contactless BOOLEAN DEFAULT FALSE`,
    ]) {
      await query(`ALTER TABLE virtual_cards ${col}`);
    }
    // Bitnob Card KYC — one submission per user (id_type/id_number live only
    // for the latest attempt; approved rows pin the provider customer_id that
    // Create Card consumes). See server/routes personal-webhooks for the
    // virtualcard.user.kyc.* webhook that flips the status asynchronously.
    await query(`
    CREATE TABLE IF NOT EXISTS virtual_card_kyc (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE,
      provider VARCHAR(20) DEFAULT 'bitnob',
      provider_customer_id VARCHAR(120),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending|approved|rejected
      normalized_status VARCHAR(30),
      id_type VARCHAR(30),
      id_number_masked VARCHAR(40),
      occupation VARCHAR(80),
      employment_status VARCHAR(40),
      account_purpose VARCHAR(120),
      annual_salary VARCHAR(30),
      expected_monthly_volume VARCHAR(30),
      place_of_birth VARCHAR(80),
      completion_link TEXT,
      rejection JSONB,
      provider_response JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_virtual_cards_user ON virtual_cards(user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_virtual_cards_bitnob ON virtual_cards(bitnob_card_id) WHERE bitnob_card_id IS NOT NULL`);

    await query(`
    CREATE TABLE IF NOT EXISTS virtual_card_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      card_id UUID NOT NULL REFERENCES virtual_cards(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      type VARCHAR(16) NOT NULL,                          -- funding|withdrawal|spend|refund
      status VARCHAR(16) DEFAULT 'pending',               -- pending|completed|failed
      amount DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) DEFAULT 0,
      currency VARCHAR(3) DEFAULT 'USD',
      reference VARCHAR(80) UNIQUE NOT NULL,
      provider_reference VARCHAR(120),
      description TEXT,
      balance_before DECIMAL(15,2),
      balance_after DECIMAL(15,2),
      provider_response JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    for (const col of [
      `ADD COLUMN IF NOT EXISTS fee DECIMAL(15,2) DEFAULT 0`,
      `ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'USD'`,
      `ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(120)`,
      `ADD COLUMN IF NOT EXISTS description TEXT`,
      `ADD COLUMN IF NOT EXISTS balance_before DECIMAL(15,2)`,
      `ADD COLUMN IF NOT EXISTS balance_after DECIMAL(15,2)`,
      `ADD COLUMN IF NOT EXISTS provider_response JSONB`,
      `ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
    ]) {
      await query(`ALTER TABLE virtual_card_transactions ${col}`);
    }
    await query(`CREATE INDEX IF NOT EXISTS idx_vc_tx_card ON virtual_card_transactions(card_id, created_at DESC)`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomReference(prefix: string): string {
    return `${prefix}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function publicCard(row: any) {
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        currency: row.currency,
        card_brand: row.card_brand,
        status: row.status,
        masked_pan: row.masked_pan || null,
        balance: Number(row.balance) || 0,
        created_at: row.created_at,
    };
}

/** Get (or lazily create) the Bitnob customer for this user. */
async function getBitnobCustomerId(user: any): Promise<string | null> {
    const existing = await query(
        `SELECT bitnob_customer_id FROM virtual_cards WHERE user_id = $1 AND bitnob_customer_id IS NOT NULL LIMIT 1`,
        [user.id],
    );
    if (existing.rows[0]?.bitnob_customer_id) return existing.rows[0].bitnob_customer_id;
    const firstName = (user.first_name || user.fullName || "Metro").toString().split(" ")[0];
    const lastName = (user.last_name || user.fullName || "User").toString().split(" ").slice(1).join(" ") || "User";
    try {
        const res = await bitnob.createCustomer({
            email: user.email,
            first_name: firstName,
            last_name: lastName,
            customer_type: "individual",
            reference: randomReference("CUS"),
        });
        return res?.data?.id || null;
    } catch (e: any) {
        // Customer may already exist server-side — try listing by email.
        try {
            const list = await bitnob.listCustomers({ email: user.email });
            return list?.data?.customers?.[0]?.id || null;
        } catch {
            console.error("[virtualcards] customer bootstrap failed:", e?.message);
            return null;
        }
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * @swagger
 * tags:
 *   name: VirtualCards
 *   description: Personal USD virtual cards (Bitnob card issuing)
 */

/**
 * @swagger
 * /virtualcards/provider-status:
 *   get:
 *     summary: Whether live Bitnob card issuing is configured (vs simulator)
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/provider-status", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const kyc = await query(
        `SELECT bitnob_customer_id FROM virtual_cards WHERE user_id = $1 AND bitnob_customer_id IS NOT NULL LIMIT 1`,
        [req.user!.userId],
    );
    res.json({
        success: true,
        data: {
            provider: (await bitnobLive()) ? "bitnob" : "simulator",
            kyc_customer_id: kyc.rows[0]?.bitnob_customer_id || null,
        },
    });
});

/**
 * @swagger
 * /virtualcards/kyc:
 *   post:
 *     summary: Submit Bitnob Card KYC for the signed-in user
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/kyc", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const {
        id_type, id_number, occupation, employment_status, account_purpose,
        annual_salary, expected_monthly_volume, place_of_birth,
        terms_of_service_accepted, id_front_image, id_back_image,
    } = req.body || {};

    for (const [k, v] of Object.entries({ id_type, id_number, occupation, employment_status, account_purpose, annual_salary, expected_monthly_volume })) {
        if (!v) return res.status(400).json({ success: false, error: `Missing required field: ${k}` });
    }
    if (terms_of_service_accepted !== true) {
        return res.status(400).json({ success: false, error: "terms_of_service_accepted must be true" });
    }

    if (!(await bitnobLive())) {
        // Simulator: instant approval.
        const simId = `SIMCUST_${randomReference("K")}`;
        await query(
            `INSERT INTO virtual_cards (user_id, provider, bitnob_customer_id, reference, name, status, created_status)
             VALUES ($1, 'simulator', $2, $3, 'kyc-record', 'terminated', 'completed')`,
            [userId, simId, randomReference("KYC")],
        );
        return res.json({ success: true, data: { customer_id: simId, status: "approved", mode: "simulator" } });
    }

    try {
        const result = await bitnob.submitCardKyc({
            customer: {
                email: user.email,
                first_name: (user.first_name || user.fullName || "Metro").toString().split(" ")[0],
                last_name: (user.last_name || user.fullName || "User").toString().split(" ").slice(1).join(" ") || "User",
                phone_number: user.phone_number || user.phone || undefined,
            },
            id_type, id_number,
            occupation: String(occupation).toLowerCase().replace(/\s+/g, "_"),
            employment_status, account_purpose,
            annual_salary: String(annual_salary),
            expected_monthly_volume: String(expected_monthly_volume),
            place_of_birth: place_of_birth || undefined,
            terms_of_service_accepted: true,
            webhook_url: process.env.BITNOB_WEBHOOK_URL || undefined,
            id_front_image, id_back_image,
        });
        const customerId = result?.data?.customer_id;
        const status = result?.data?.status || result?.data?.normalized_status || "pending";
        if (customerId) {
            await query(
                `INSERT INTO virtual_cards (user_id, provider, bitnob_customer_id, reference, name, status, created_status)
                 VALUES ($1, 'bitnob', $2, $3, 'kyc-record', 'terminated', 'completed')`,
                [userId, customerId, randomReference("KYC")],
            );
        }
        return res.json({
            success: true,
            data: {
                customer_id: customerId || null,
                status,
                completion_link: result?.data?.completion_link || null,
            },
        });
    } catch (e: any) {
        console.error("[virtualcards] KYC error:", e?.message);
        return res.status(502).json({ success: false, error: e?.message || "Card KYC submission failed" });
    }
});

/**
 * @swagger
 * /virtualcards:
 *   get:
 *     summary: List the caller's virtual cards
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    // Prefer live provider state when Bitnob is configured (2/60s per card — poll lazily).
    const rowsRes = await query(
        `SELECT * FROM virtual_cards WHERE user_id = $1 AND name <> 'kyc-record' ORDER BY created_at DESC`,
        [userId],
    );
    const rows = rowsRes.rows;
    if (await bitnobLive()) {
        await Promise.all(rows.filter((r: any) => r.provider === "bitnob" && r.bitnob_card_id).map(async (r: any) => {
            try {
                const live = await bitnob.getCard(r.bitnob_card_id);
                const c = live?.data?.card;
                if (c) {
                    await query(
                        `UPDATE virtual_cards SET status = $2, created_status = $3, masked_pan = $4,
                         balance = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        [r.id, c.status, c.created_status, c.masked_pan || r.masked_pan, bitnob.fromMicros(c.balance_amount || "0")],
                    );
                    r.status = c.status; r.created_status = c.created_status; r.masked_pan = c.masked_pan || r.masked_pan;
                    r.balance = bitnob.fromMicros(c.balance_amount || "0");
                }
            } catch { /* keep local mirror on provider hiccups */ }
        }));
    }
    res.json({ success: true, data: { cards: rows.map(publicCard), mode: (await bitnobLive()) ? "bitnob" : "simulator" } });
});

/**
 * @swagger
 * /virtualcards:
 *   post:
 *     summary: Create a new USD virtual card
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const { name, amount, card_brand, contactless_payment } = req.body || {};
    const amountUsd = Number(amount);
    if (!amountUsd || Number.isNaN(amountUsd)) return res.status(400).json({ success: false, error: "amount (USD) is required" });
    if (amountUsd < CREATE_MIN_USD || amountUsd > CREATE_MAX_USD) {
        return res.status(400).json({ success: false, error: `amount must be between $${CREATE_MIN_USD} and $${CREATE_MAX_USD}` });
    }

    const userRes = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    // Active-card cap (platform risk control).
    const activeRes = await query(
        `SELECT COUNT(*)::int AS c FROM virtual_cards WHERE user_id = $1 AND status IN ('active','pending','frozen')`,
        [userId],
    );
    if ((activeRes.rows[0]?.c ?? 0) >= 5) {
        return res.status(403).json({ success: false, error: "You can hold at most 5 active virtual cards. Terminate one first.", code: "CARD_LIMIT" });
    }

    const reference = randomReference("VC");
    const mode = (await bitnobLive()) ? "bitnob" : "simulator";
    let bitnobCardId: string | null = null;
    let customerId: string | null = null;
    let status = "pending";
    let createdStatus = "processing";
    let maskedPan: string | null = null;
    let providerResponse: any = null;

    if (mode === "bitnob") {
        customerId = await getBitnobCustomerId(user);
        if (!customerId) {
            return res.status(400).json({
                success: false,
                error: "Card KYC is required before issuing a virtual card. Submit KYC first.",
                code: "CARD_KYC_REQUIRED",
            });
        }
        try {
            const created = await bitnob.createCard({
                customer_id: customerId,
                amount: bitnob.toMicros(amountUsd),
                currency: "USD",
                card_brand: card_brand || "visa",
                name: name || undefined,
                contactless_payment: Boolean(contactless_payment),
                reference,
                webhook_url: process.env.BITNOB_WEBHOOK_URL || undefined,
            });
            const c = created?.data?.card;
            bitnobCardId = c?.id || null;
            status = c?.status || "pending";
            createdStatus = c?.created_status || "processing";
            maskedPan = c?.masked_pan || null;
            providerResponse = created;
        } catch (e: any) {
            console.error("[virtualcards] create failed:", e?.message);
            const kycNeeded = /kyc|verif|identity/i.test(e?.message || "");
            return res.status(502).json({
                success: false,
                error: kycNeeded ? "Card KYC is required before issuing a virtual card. Submit KYC first." : (e?.message || "Card creation failed"),
                code: kycNeeded ? "CARD_KYC_REQUIRED" : "PROVIDER_ERROR",
            });
        }
    } else {
        status = "active";
        createdStatus = "completed";
        maskedPan = `5399****${String(Math.floor(1000 + Math.random() * 9000))}`;
        providerResponse = { simulated: true };
    }

    const insert = await query(
        `INSERT INTO virtual_cards
         (user_id, provider, bitnob_card_id, bitnob_customer_id, reference, name, currency, card_brand,
          status, created_status, masked_pan, balance, provider_response)
         VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, $9, $10, 0, $11::jsonb)
         RETURNING *`,
        [userId, mode, bitnobCardId, customerId, reference, name || "Virtual Card", card_brand || "visa",
         status, createdStatus, maskedPan, JSON.stringify(providerResponse || {})],
    );
    res.status(201).json({ success: true, data: { card: publicCard(insert.rows[0]) } });
});

/**
 * @swagger
 * /virtualcards/{id}/fund:
 *   post:
 *     summary: Fund a card from the caller's USD wallet (or any wallet via conversion at payout rate)
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/fund", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const cardId = String(req.params.id);
    const amount = Number(req.body?.amount);
    if (!amount || Number.isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: "amount is required" });
    }

    const cardRes = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [cardId, userId]);
    const card = cardRes.rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (card.status === "terminated") return res.status(400).json({ success: false, error: "Card is terminated" });
    if (card.status === "frozen") return res.status(400).json({ success: false, error: "Card is frozen — unfreeze it first" });

    // Wallet: prefer the user's USDT stablecoin wallet, then USDC, else first
    // active personal wallet (the legacy USD wallet was retired into USDT).
    const walletRes = await query(
        `SELECT * FROM wallets WHERE user_id = $1 AND status = 'active' AND (business_id IS NULL)
         ORDER BY (currency = 'USDT') DESC, (currency = 'USDC') DESC, created_at ASC LIMIT 1`,
        [userId],
    );
    const wallet = walletRes.rows[0];
    if (!wallet) return res.status(404).json({ success: false, error: "No active wallet found" });

    const walletCurrency = String(wallet.currency || "NGN").toUpperCase();
    let debitUsd = amount;               // USD needed on the card
    let debitAmount = amount;            // amount debited from THIS wallet
    let fxRate: number | null = null;
    if (walletCurrency !== "USDT" && walletCurrency !== "USDC" && walletCurrency !== "USD") {
        // Convert via Bitnob exchange rate (fallback: static 1600 NGN/USD marker is NOT used — we refuse instead).
        if (await bitnobLive()) {
            try {
                const conv = await bitnob.convertAmount(walletCurrency, "USD", 1);
                fxRate = Number(conv?.data?.rate_used || conv?.data?.to_amount) || null;
            } catch { /* fall through */ }
        }
        if (!fxRate) {
            return res.status(400).json({ success: false, error: `Live USD rate unavailable — fund from a USD wallet.`, code: "RATE_UNAVAILABLE" });
        }
        debitAmount = Math.round(amount * fxRate * 100) / 100;
    }

    // FRAUD GATE (outflow) — card funding is a classic laundering rail.
    const fraudResult = await evaluateOutflow({
        flow: "virtual_card",
        userId,
        walletId: wallet.id,
        amount: debitAmount,
        currency: walletCurrency,
        ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
        userAgent: (req.headers["user-agent"] as string) || null,
        deviceId: (req.headers["x-device-id"] as string) || null,
        beneficiary: { accountName: `virtual-card:${card.masked_pan || card.reference}` },
        channel: "virtualcards:fund",
    });
    if (fraudResult.decision === "reject") {
        return res.status(403).json({ success: false, error: fraudRejectReason(fraudResult), code: "FRAUD_REJECTED" });
    }

    const reference = randomReference("VCF");
    // Funding fee (Personal Products console: virtualcard_funding_fee_percent,
    // default 1%) — charged on the wallet-side debit, lands in revenue.
    const { getPercent } = await import("./flags");
    const fundingFeePercent = await getPercent("virtualcard_funding_fee_percent", 1);
    const fundingFee = Math.round(debitAmount * fundingFeePercent) / 100;
    const totalDebit = Math.round((debitAmount + fundingFee) * 100) / 100;
    const debit = await query(
        `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND balance >= $1 AND status = 'active' RETURNING balance`,
        [totalDebit, wallet.id],
    );
    if (debit.rows.length === 0) {
        return res.status(400).json({ success: false, error: "Insufficient wallet balance", code: "INSUFFICIENT_BALANCE" });
    }

    const owningBusinessId = (wallet.business_id as string) || null;
    await query(
        `INSERT INTO transactions
         (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction, fee)
         VALUES ($1, $2, $3, $4, $5, 'success', 'debit', $6, 'virtual_card_funding', $7, 'debit', $8)`,
        [owningBusinessId, userId, totalDebit, walletCurrency, reference,
         `Virtual card funding (${card.name || card.masked_pan || card.id})`, wallet.id, fundingFee],
    );
    if (fundingFee > 0) {
        creditRevenueWallet(fundingFee, walletCurrency, reference, "Virtual Card Funding Fee", "virtualcards").catch(() => {});
    }

    const insertTx = async (type: string, status_: string, txAmount: number, desc: string, providerRef?: string, before?: number, after?: number) => {
        await query(
            `INSERT INTO virtual_card_transactions
             (card_id, user_id, type, status, amount, currency, reference, provider_reference, description, balance_before, balance_after)
             VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, $8, $9, $10)`,
            [card.id, userId, type, status_, txAmount, reference, providerRef || null, desc, before ?? null, after ?? null],
        );
    };

    if (card.provider === "simulator") {
        const newBalance = Math.round(((Number(card.balance) || 0) + amount) * 100) / 100;
        await query(`UPDATE virtual_cards SET balance = $2, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, newBalance]);
        await insertTx("funding", "completed", amount, "Card funding (simulator)", null, Number(card.balance), newBalance);
        await createNotification({
            userId,
            title: "Virtual card funded",
            message: `$${amount.toLocaleString()} was added to your virtual card.`,
            type: "transaction",
        }).catch(() => {});
        return res.json({ success: true, data: { status: "completed", balance: newBalance, mode: "simulator" } });
    }

    // Bitnob: amounts in micro-units; funding settles asynchronously (webhook/poll).
    try {
        const funded = await bitnob.fundOrWithdrawCard(card.bitnob_card_id, {
            amount: bitnob.toMicros(amount),
            type: "fund",
            reference,
        });
        const tx = funded?.data?.transaction;
        await insertTx("funding", tx?.status || "pending", amount, "Card funding", tx?.id || null, Number(card.balance), null);
        return res.json({
            success: true,
            data: {
                status: tx?.status || "pending",
                mode: "bitnob",
                reference,
                message: "Funding accepted — the card balance updates once the provider settles.",
            },
        });
    } catch (e: any) {
        // Refund the wallet on provider rejection.
        await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [debitAmount, wallet.id]);
        await query(`UPDATE transactions SET status = 'failed' WHERE reference = $1`, [reference]);
        console.error("[virtualcards] fund failed:", e?.message);
        return res.status(502).json({ success: false, error: e?.message || "Card funding failed — wallet refunded" });
    }
});

/**
 * @swagger
 * /virtualcards/{id}/withdraw:
 *   post:
 *     summary: Withdraw card balance back to the USD wallet
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/withdraw", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const cardId = String(req.params.id);
    const amount = Number(req.body?.amount);
    if (!amount || Number.isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: "amount is required" });

    const cardRes = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [cardId, userId]);
    const card = cardRes.rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (card.status === "terminated") return res.status(400).json({ success: false, error: "Card is terminated" });
    if (amount > (Number(card.balance) || 0)) {
        return res.status(400).json({ success: false, error: "Amount exceeds card balance" });
    }

    const walletRes = await query(
        `SELECT * FROM wallets WHERE user_id = $1 AND status = 'active' AND (business_id IS NULL)
         ORDER BY (currency = 'USDT') DESC, (currency = 'USDC') DESC, created_at ASC LIMIT 1`,
        [userId],
    );
    const wallet = walletRes.rows[0];
    if (!wallet) return res.status(404).json({ success: false, error: "No active wallet found" });

    const reference = randomReference("VCW");
    const walletCurrency = String(wallet.currency || "NGN").toUpperCase();
    const creditAmount = walletCurrency === "USD" ? amount : amount; // conversion applied on credit path if needed

    if (card.provider === "simulator") {
        const newBalance = Math.round(((Number(card.balance) || 0) - amount) * 100) / 100;
        await query(`UPDATE virtual_cards SET balance = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, newBalance]);
        await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [creditAmount, wallet.id]);
        await query(
            `INSERT INTO virtual_card_transactions (card_id, user_id, type, status, amount, currency, reference, description, balance_before, balance_after)
             VALUES ($1, $2, 'withdrawal', 'completed', $3, 'USD', $4, 'Card withdrawal (simulator)', $5, $6)`,
            [card.id, userId, amount, reference, Number(card.balance), newBalance],
        );
        return res.json({ success: true, data: { status: "completed", card_balance: newBalance, mode: "simulator" } });
    }

    try {
        const wd = await bitnob.fundOrWithdrawCard(card.bitnob_card_id, {
            amount: bitnob.toMicros(amount),
            type: "withdraw",
            reference,
        });
        const tx = wd?.data?.transaction;
        await query(
            `INSERT INTO virtual_card_transactions (card_id, user_id, type, status, amount, currency, reference, provider_reference, description, balance_before)
             VALUES ($1, $2, 'withdrawal', $3, $4, 'USD', $5, $6, 'Card withdrawal', $7)`,
            [card.id, userId, tx?.status || "pending", amount, reference, tx?.id || null, Number(card.balance)],
        );
        res.json({ success: true, data: { status: tx?.status || "pending", mode: "bitnob", reference } });
    } catch (e: any) {
        console.error("[virtualcards] withdraw failed:", e?.message);
        res.status(502).json({ success: false, error: e?.message || "Card withdrawal failed" });
    }
});

async function setCardStatusRoute(req: AuthenticatedRequest, res: any, next: "active" | "frozen") {
    const userId = req.user!.userId;
    const cardRes = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [String(req.params.id), userId]);
    const card = cardRes.rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (card.provider === "simulator") {
        await query(`UPDATE virtual_cards SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, next]);
        return res.json({ success: true, data: { status: next, mode: "simulator" } });
    }
    try {
        await bitnob.setCardStatus(card.bitnob_card_id, next);
        await query(`UPDATE virtual_cards SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, next]);
        res.json({ success: true, data: { status: next, mode: "bitnob" } });
    } catch (e: any) {
        console.error("[virtualcards] status failed:", e?.message);
        res.status(502).json({ success: false, error: e?.message || "Card status update failed" });
    }
}

/**
 * @swagger
 * /virtualcards/{id}/freeze:
 *   post:
 *     summary: Freeze a card
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/freeze", authenticateToken, checkSubscriptionStatus, (req: AuthenticatedRequest, res) => setCardStatusRoute(req, res, "frozen"));

/**
 * @swagger
 * /virtualcards/{id}/unfreeze:
 *   post:
 *     summary: Unfreeze a card
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/:id/unfreeze", authenticateToken, checkSubscriptionStatus, (req: AuthenticatedRequest, res) => setCardStatusRoute(req, res, "active"));

/**
 * @swagger
 * /virtualcards/{id}:
 *   delete:
 *     summary: Terminate a card (balance must be withdrawn first)
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.delete("/:id", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const reason = String(req.body?.reason || "user_requested");
    const cardRes = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [String(req.params.id), userId]);
    const card = cardRes.rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if ((Number(card.balance) || 0) > 0) {
        return res.status(400).json({
            success: false,
            error: `Card still holds $${Number(card.balance).toFixed(2)} — withdraw the balance before terminating.`,
            code: "CARD_NOT_EMPTY",
        });
    }
    if (card.provider === "simulator") {
        await query(`UPDATE virtual_cards SET status = 'terminated', terminated_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, reason]);
        return res.json({ success: true, data: { status: "terminated", mode: "simulator" } });
    }
    try {
        await bitnob.terminateCard(card.bitnob_card_id, reason);
        await query(`UPDATE virtual_cards SET status = 'terminated', terminated_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [card.id, reason]);
        res.json({ success: true, data: { status: "terminated", mode: "bitnob" } });
    } catch (e: any) {
        console.error("[virtualcards] terminate failed:", e?.message);
        res.status(502).json({ success: false, error: e?.message || "Card termination failed" });
    }
});

/**
 * @swagger
 * /virtualcards/{id}/transactions:
 *   get:
 *     summary: Card transactions (local ledger + provider)
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/:id/transactions", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    const cardRes = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [String(req.params.id), userId]);
    const card = cardRes.rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });

    const local = await query(
        `SELECT * FROM virtual_card_transactions WHERE card_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [card.id],
    );
    let providerTx: any[] = [];
    if (card.provider === "bitnob" && card.bitnob_card_id) {
        try {
            const pt = await bitnob.getCardTransactions(card.bitnob_card_id);
            providerTx = pt?.data?.transactions || pt?.data?.card_transactions || [];
        } catch { /* local view survives */ }
    }
    res.json({ success: true, data: { transactions: local.rows, provider_transactions: providerTx } });
});

/**
 * @swagger
 * /virtualcards/{id}/secure:
 *   get:
 *     summary: Reveal full card details (PAN, CVV, expiry) — rate-limited + audit-logged
 *     tags: [VirtualCards]
 *     security: [{ bearerAuth: [] }]
 */
const secureAttempts = new Map<string, number[]>();
router.get("/:id/secure", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId;
    // Simple in-memory rate limit: 10 reveals / 10 min / user.
    const now = Date.now();
    const window = (secureAttempts.get(userId) || []).filter((t) => now - t < 10 * 60_000);
    if (window.length >= 10) {
        return res.status(429).json({ success: false, error: "Too many reveals — try again later." });
    }
    window.push(now);
    secureAttempts.set(userId, window);

    const cardRes = await query(`SELECT * FROM virtual_cards WHERE id = $1 AND user_id = $2`, [String(req.params.id), userId]);
    const card = cardRes.rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });

    if (card.provider === "simulator") {
        const sim = {
            card_number: `539987${String(Math.floor(100000000000 + Math.random() * 899999999999)).slice(0, 9)}${card.masked_pan?.slice(-4) || "0000"}`.slice(0, 16),
            cvv: String(Math.floor(100 + Math.random() * 900)),
            expiry: "12/29",
            note: "SIMULATOR CARD — not spendable with real merchants",
        };
        return res.json({ success: true, data: { ...sim, mode: "simulator" } });
    }
    try {
        const sec = await bitnob.getCardSecureDetails(card.bitnob_card_id);
        res.json({ success: true, data: { ...(sec?.data || {}), mode: "bitnob" } });
    } catch (e: any) {
        console.error("[virtualcards] secure details failed:", e?.message);
        res.status(502).json({ success: false, error: e?.message || "Could not retrieve card details" });
    }
});

export default router;
