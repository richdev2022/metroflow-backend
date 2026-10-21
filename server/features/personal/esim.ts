import express from "express";
import crypto from "crypto";
import { query } from "../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../middleware/auth";
import { requirePersonalService, useProvider } from "./flags";
import { calculateFee, debitPlatformWallet, creditRevenueWallet } from "../../services/fees";
import { createNotification } from "../../services/notifications";
import { verifyPassword } from "../../services/auth";
import { evaluateOutflow } from "../../services/fraud";

/**
 * eSIM TOP-UPS — MetriCorex Personal (data plans for 190+ countries).
 * Mounted at /esim.
 *
 * Provider adapter is pluggable (ESIM_PROVIDER_URL-style, like the bills
 * adapter): with no provider configured a built-in SIMULATOR fulfils orders
 * so the whole flow (wallet debit, fee, ledger, fraud gate, delivery) is
 * exercisable in staging. A live aggregator drops in without schema changes:
 * implement fulfillOrder() + listPlans() against the provider and set
 * ESIM_PROVIDER_URL + ESIM_PROVIDER_API_KEY.
 *
 *   GET  /esim/plans?country=NG      catalog (country -> packages)
 *   GET  /esim/countries             covered countries
 *   POST /esim/purchase              buy a package from any NGN wallet
 *   GET  /esim/orders                user's orders
 *   GET  /esim/orders/:reference     order detail (QR / activation code)
 */

const router = express.Router();
// Personal Products console kill-switch for eSIM top-ups.
router.use(requirePersonalService("esim"));

const ESIM_PROVIDER_URL = process.env.ESIM_PROVIDER_URL || "";
const ESIM_PROVIDER_API_KEY = process.env.ESIM_PROVIDER_API_KEY || "";

export function isEsimProviderConfigured(): boolean {
  return !!ESIM_PROVIDER_URL;
}

/** Provider routing (Personal Products console): auto | provider | simulator. */
async function liveProvider(): Promise<boolean> {
  return useProvider("esim", isEsimProviderConfigured());
}

export async function ensureEsimSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS esim_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID NOT NULL,
      wallet_id UUID,
      reference VARCHAR(80) UNIQUE NOT NULL,
      country_code VARCHAR(2) NOT NULL,
      country_name VARCHAR(120),
      package_code VARCHAR(120) NOT NULL,
      package_name VARCHAR(200),
      data_amount_mb INTEGER,
      validity_days INTEGER,
      amount DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) DEFAULT 0,
      total DECIMAL(15,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending',      -- pending|success|failed|refunded
      fulfilment_mode VARCHAR(20),               -- provider | simulated
      provider_reference VARCHAR(120),
      activation_details JSONB,                  -- QR / SM-DP+ / activation code
      provider_response JSONB,
      failure_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_esim_orders_user ON esim_orders(user_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_esim_orders_status ON esim_orders(status)`);
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------
interface EsimPackage {
  code: string;
  name: string;
  dataAmountMb: number;
  validityDays: number;
  price: number;             // NGN
  countryCode: string;
  countryName: string;
}

/** Static catalog when no provider is configured (dev + demo markets). */
const SIMULATED_PACKAGES: EsimPackage[] = [
  { code: "ng-1gb-30", name: "Nigeria 1 GB", dataAmountMb: 1024, validityDays: 30, price: 2500, countryCode: "NG", countryName: "Nigeria" },
  { code: "ng-3gb-30", name: "Nigeria 3 GB", dataAmountMb: 3072, validityDays: 30, price: 6000, countryCode: "NG", countryName: "Nigeria" },
  { code: "us-1gb-15", name: "United States 1 GB", dataAmountMb: 1024, validityDays: 15, price: 6500, countryCode: "US", countryName: "United States" },
  { code: "us-5gb-30", name: "United States 5 GB", dataAmountMb: 5120, validityDays: 30, price: 24000, countryCode: "US", countryName: "United States" },
  { code: "gb-1gb-15", name: "United Kingdom 1 GB", dataAmountMb: 1024, validityDays: 15, price: 5800, countryCode: "GB", countryName: "United Kingdom" },
  { code: "za-1gb-15", name: "South Africa 1 GB", dataAmountMb: 1024, validityDays: 15, price: 5200, countryCode: "ZA", countryName: "South Africa" },
  { code: "ke-1gb-15", name: "Kenya 1 GB", dataAmountMb: 1024, validityDays: 15, price: 5400, countryCode: "KE", countryName: "Kenya" },
  { code: "ae-1gb-15", name: "United Arab Emirates 1 GB", dataAmountMb: 1024, validityDays: 15, price: 7900, countryCode: "AE", countryName: "United Arab Emirates" },
  { code: "global-1gb-7", name: "Global (190+ countries) 1 GB", dataAmountMb: 1024, validityDays: 7, price: 14500, countryCode: "GL", countryName: "Global" },
];

async function listPackages(countryCode?: string): Promise<EsimPackage[]> {
  if (await liveProvider()) {
    try {
      const res = await fetch(`${ESIM_PROVIDER_URL}/packages${countryCode ? `?country=${encodeURIComponent(countryCode)}` : ""}`, {
        headers: { Authorization: `Bearer ${ESIM_PROVIDER_API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      } as any);
      const body: any = await res.json();
      if (res.ok && Array.isArray(body?.packages)) return body.packages as EsimPackage[];
      return [];
    } catch (e: any) {
      console.warn("[esim] provider list failed:", e?.message);
      return [];
    }
  }
  const list = SIMULATED_PACKAGES;
  return countryCode ? list.filter((p) => p.countryCode === String(countryCode).toUpperCase()) : list;
}

async function fulfillOrder(order: { reference: string; packageCode: string; }): Promise<{ ok: boolean; mode: "provider" | "simulated"; activation?: any; providerReference?: string | null; message?: string }> {
  if (await liveProvider()) {
    try {
      const res = await fetch(`${ESIM_PROVIDER_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ESIM_PROVIDER_API_KEY}` },
        body: JSON.stringify({ reference: order.reference, packageCode: order.packageCode }),
        signal: AbortSignal.timeout(30_000),
      } as any);
      const body: any = await res.json();
      if (!res.ok || body?.ok === false) {
        return { ok: false, mode: "provider", message: body?.message || `Provider responded ${res.status}` };
      }
      return { ok: true, mode: "provider", activation: body?.activation || null, providerReference: body?.reference || null };
    } catch (e: any) {
      return { ok: false, mode: "provider", message: e?.message || "Provider request failed" };
    }
  }
  // Simulator: instantly fulfilled with a clearly-labelled activation payload.
  return {
    ok: true,
    mode: "simulated",
    providerReference: `SIM-ESIM-${order.reference}`,
    activation: {
      simulated: true,
      activation_code: `LPA:1$simulator.metricorex.com$${crypto.randomBytes(12).toString("hex").toUpperCase()}`,
      qr_note: "Simulated eSIM — replace ESIM_PROVIDER_URL to go live",
      iccid: `89${Date.now()}`.substring(0, 19),
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get("/countries", async (_req, res) => {
  try {
    const packages = await listPackages();
    const countries = Array.from(new Map(packages.map((p) => [p.countryCode, { code: p.countryCode, name: p.countryName }])).values());
    return res.json({ success: true, countries, provider: isEsimProviderConfigured() ? "provider" : "simulated" });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || "Failed to load countries" });
  }
});

router.get("/plans", async (req, res) => {
  try {
    const country = (req.query.country as string) || undefined;
    const packages = await listPackages(country);
    return res.json({ success: true, packages, provider: isEsimProviderConfigured() ? "provider" : "simulated" });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || "Failed to load plans" });
  }
});

router.post("/purchase", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureEsimSchema();
    const { userId, businessId } = req.user!;
    const { package_code, wallet_id, pin } = req.body || {};
    if (!package_code) return res.status(400).json({ success: false, error: "package_code is required" });

    const pkg = (await listPackages()).find((p) => p.code === String(package_code));
    if (!pkg) return res.status(400).json({ success: false, error: "Unknown package. Refresh the plans list." });

    if (!pin) return res.status(400).json({ success: false, error: "Transaction PIN is required" });
    const pinRes = await query(`SELECT transaction_pin_hash FROM businesses WHERE id = $1`, [businessId]);
    if (!pinRes.rows[0]?.transaction_pin_hash) return res.status(400).json({ success: false, error: "Transaction PIN not set. Please create one first.", code: "PIN_NOT_SET" });
    if (!(await verifyPassword(String(pin), pinRes.rows[0].transaction_pin_hash))) {
      return res.status(400).json({ success: false, error: "Invalid transaction PIN" });
    }

    // FRAUD GATE (outflow)
    const fraudResult = await evaluateOutflow({
      flow: "esim",
      userId, businessId, walletId: wallet_id || null,
      amount: pkg.price,
      currency: "NGN",
      ip: (String(req.headers["x-forwarded-for"] || "")).split(",")[0]?.trim() || req.ip || null,
      userAgent: (req.headers["user-agent"] as string) || null,
      deviceId: (req.headers["x-device-id"] as string) || null,
      beneficiary: { accountName: `esim:${pkg.code}` },
      channel: `esim:${pkg.countryCode}`,
    });
    if (fraudResult.decision === "reject") {
      return res.status(403).json({ success: false, error: "This order was declined by our security system.", code: "FRAUD_REJECTED" });
    }
    if (fraudResult.decision === "hold") {
      return res.status(202).json({
        success: true,
        message: "Order received but held for a quick security review. Complete verification in the app to release it.",
        code: "FRAUD_HOLD",
        fraud: { decision: "hold", dueDiligenceId: fraudResult.dueDiligenceId },
      });
    }

    const walletRes = await query(
      `SELECT * FROM wallets WHERE id = $1 AND (business_id = $2 OR user_id = $3)`,
      [wallet_id, businessId || null, userId],
    );
    const wallet = walletRes.rows[0];
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    if (String(wallet.currency || "NGN").toUpperCase() !== "NGN") {
      return res.status(400).json({ success: false, error: "eSIM purchases are charged in NGN. Select your NGN wallet." });
    }

    const baseFee = await calculateFee(pkg.price, "esim");
    const fee = Math.round(baseFee * 100) / 100;
    const total = Math.round((pkg.price + fee) * 100) / 100;

    const debit = await query(
      `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND balance >= $1 AND status = 'active' RETURNING balance`,
      [total, wallet.id],
    );
    if (debit.rows.length === 0) {
      return res.status(400).json({ success: false, error: `Insufficient balance. This plan costs ₦${total.toLocaleString()} (₦${pkg.price.toLocaleString()} + ₦${fee.toLocaleString()} fee).`, code: "INSUFFICIENT_BALANCE" });
    }

    const reference = `ESIM_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`.toUpperCase();
    const owningBusinessId: string | null = (wallet.business_id as string) || null;
    const insertRes = await query(
      `INSERT INTO esim_orders
       (business_id, user_id, wallet_id, reference, country_code, country_name, package_code, package_name,
        data_amount_mb, validity_days, amount, fee, total, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'NGN','pending') RETURNING *`,
      [owningBusinessId, userId, wallet.id, reference, pkg.countryCode, pkg.countryName, pkg.code, pkg.name,
       pkg.dataAmountMb, pkg.validityDays, pkg.price, fee, total],
    );
    const order = insertRes.rows[0];

    await query(
      `INSERT INTO transactions
       (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction, fee)
       VALUES ($1, $2, $3, 'NGN', $4, 'success', 'debit', $5, 'esim', $6, 'debit', $7)`,
      [owningBusinessId, userId, total, reference,
       `eSIM ${pkg.name} (${pkg.dataAmountMb >= 1024 ? `${(pkg.dataAmountMb / 1024).toFixed(pkg.dataAmountMb % 1024 === 0 ? 0 : 1)} GB` : `${pkg.dataAmountMb} MB`}, ${pkg.validityDays}d)`, wallet.id, fee],
    );
    await debitPlatformWallet(pkg.price, "NGN", `${reference}-VENDOR`, "Platform Wallet Debit for eSIM Purchase", "esim");
    if (fee > 0) await creditRevenueWallet(fee, "NGN", reference, "eSIM Convenience Fee", "esim");

    const fulfilment = await fulfillOrder({ reference, packageCode: pkg.code });
    const finalStatus = fulfilment.ok ? "success" : "failed";
    await query(
      `UPDATE esim_orders SET status = $2, fulfilment_mode = $3, provider_reference = $4,
         activation_details = $5::jsonb, provider_response = $6::jsonb, failure_reason = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [order.id, finalStatus, fulfilment.mode, fulfilment.providerReference || null,
       JSON.stringify(fulfilment.activation || null), JSON.stringify(fulfilment), fulfilment.ok ? null : fulfilment.message],
    );

    if (!fulfilment.ok) {
      await query(`UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [total, wallet.id]);
      await query(
        `INSERT INTO transactions
         (business_id, user_id, amount, currency, reference, status, type, description, transaction_type, wallet_id, direction)
         VALUES ($1, $2, $3, 'NGN', $4, 'success', 'credit', $5, 'esim_refund', $6, 'credit')`,
        [owningBusinessId, userId, total, `${reference}-REFUND`, `eSIM purchase refund — ${pkg.name}`, wallet.id],
      );
    } else {
      try {
        await createNotification({
          businessId: String(owningBusinessId || businessId || ""),
          userId: String(userId),
          type: "system",
          title: "Your eSIM is ready",
          message: `${pkg.name} is activated. Open the app to scan the QR and install your data plan.`,
          actionUrl: "/esim",
          actionType: "view_order",
          metadata: { reference },
          isActionable: true,
          expiresInHours: 720,
        });
      } catch { /* best effort */ }
    }

    const updated = await query(`SELECT * FROM esim_orders WHERE id = $1`, [order.id]);
    return res.json({
      success: finalStatus === "success",
      order: updated.rows[0],
      message: finalStatus === "success"
        ? "eSIM purchased — scan the QR code from the order details"
        : `Purchase failed and refunded: ${fulfilment.message || "please try again"}`,
    });
  } catch (error: any) {
    console.error("eSIM purchase error:", error?.message);
    return res.status(500).json({ success: false, error: "Failed to process eSIM purchase" });
  }
});

router.get("/orders", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureEsimSchema();
    const rows = await query(
      `SELECT id, reference, country_code, country_name, package_name, data_amount_mb, validity_days,
              amount, fee, total, status, fulfilment_mode, created_at
         FROM esim_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    return res.json({ success: true, orders: rows.rows });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Failed to load orders" });
  }
});

router.get("/orders/:reference", authenticateToken, checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    await ensureEsimSchema();
    const rows = await query(
      `SELECT * FROM esim_orders WHERE reference = $1 AND user_id = $2`,
      [String(req.params.reference), req.user!.userId],
    );
    if (rows.rows.length === 0) return res.status(404).json({ success: false, error: "Order not found" });
    return res.json({ success: true, order: rows.rows[0] });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: "Failed to load order" });
  }
});

export default router;
