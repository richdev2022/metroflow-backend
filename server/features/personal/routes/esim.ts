import express from "express";
import { query } from "../../../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus } from "../../../middleware/auth";
import {
  getOwnedWallet, debitWallet, creditWallet, insertTransaction, verifyTransactionPin,
  assertPersonalService, genRef, requirePersonalKyc,
} from "../personal-utils";
import { calculateFee, debitPlatformWallet, creditRevenueWallet } from "../../../services/fees";
import { getBillCategories, payBill } from "../../../services/flutterwave";
import { createNotification } from "../../../services/notifications";

/**
 * eSIM / DATA — REAL data bundle top-ups (Flutterwave bills; live provider).
 * Mounted at /esim.
 *
 *   GET  /esim/countries                     → covered countries (NG first)
 *   GET  /esim/plans?country=NG              → live data bundles (dynamic catalog)
 *   GET  /esim/orders                        → my orders
 *   POST /esim/purchase { package_code, wallet_id, pin } → REAL bundle purchase
 *
 * Honesty note surfaced to clients: activation_details describe the
 * fulfilment (direct-to-carrier data top-up). No simulation anywhere — when
 * Flutterwave rejects the payment the order fails and the wallet is refunded.
 */

const router = express.Router();

const COUNTRIES = [
  { code: "NG", name: "Nigeria" },
];

interface PlanRow {
  code: string;           // FLW item_code
  providerCode: string;   // FLW biller_code
  name: string;
  dataAmountMb: number;
  validityDays: number;
  price: number;
  countryCode: string;
  countryName: string;
}

function parseMb(name: string): number {
  const gb = name.match(/([\d.]+)\s*gb/i);
  if (gb) return Math.round(parseFloat(gb[1]) * 1024);
  const mb = name.match(/([\d.]+)\s*mb/i);
  if (mb) return Math.round(parseFloat(mb[1]));
  return 0;
}

function parseValidity(name: string): number {
  const days = name.match(/(\d+)\s*day/i);
  if (days) return parseInt(days[1], 10);
  const weeks = name.match(/(\d+)\s*week/i);
  if (weeks) return parseInt(weeks[1], 10) * 7;
  const months = name.match(/(\d+)\s*month/i);
  if (months) return parseInt(months[1], 10) * 30;
  return 30;
}

async function loadDataPlans(country = "NG"): Promise<PlanRow[]> {
  const items = await getBillCategories(country);
  const plans: PlanRow[] = [];
  for (const it of items) {
    const label = `${it.biller_name} ${it.short_name}`.toLowerCase();
    const isData = /\d+\s*(gb|mb)|data|sme|gifting/.test(label);
    if (!isData || it.is_amount_fixed !== true || !(Number(it.amount) > 0)) continue;
    plans.push({
      code: String(it.item_code),
      providerCode: String(it.biller_code),
      name: (it.short_name || it.biller_name || "Data bundle").trim(),
      dataAmountMb: parseMb(`${it.short_name} ${it.biller_name}`),
      validityDays: parseValidity(it.short_name),
      price: Number(it.amount),
      countryCode: "NG",
      countryName: "Nigeria",
    });
  }
  return plans;
}

router.get("/countries", authenticateToken, async (_req, res) => {
  res.json({ success: true, countries: COUNTRIES });
});

router.get("/plans", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const country = String(req.query.country || "NG").toUpperCase();
    if (!COUNTRIES.some((c) => c.code === country)) {
      return res.json({ success: true, packages: [] });
    }
    const plans = await loadDataPlans(country);
    res.json({ success: true, packages: plans });
  } catch (e: any) {
    console.error("esim plans error:", e?.message);
    res.status(503).json({ success: false, error: "Data catalogue is temporarily unavailable — retry shortly." });
  }
});

router.get("/orders", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await query(
      `SELECT * FROM esim_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.userId],
    );
    const orders = rows.rows.map((o) => ({
      id: o.id,
      reference: o.provider_reference || o.reference,
      country_name: o.country_name,
      package_name: o.package_name,
      data_amount_mb: o.data_amount_mb,
      validity_days: o.validity_days,
      total: Number(o.total),
      fee: Number(o.fee),
      status: o.status,
      activation_details: o.activation_details,
      created_at: o.created_at,
    }));
    res.json({ success: true, orders });
  } catch {
    res.status(500).json({ success: false, error: "Could not load orders" });
  }
});

router.post("/purchase", authenticateToken, requirePersonalKyc(), checkSubscriptionStatus, async (req: AuthenticatedRequest, res) => {
  try {
    if (!(await assertPersonalService(res, "esim"))) return;
    const userId = req.user!.userId;
    const packageCode = String(req.body?.package_code || "");
    const pin = typeof req.body?.pin === "string" ? req.body.pin : undefined;
    const customerRef = String(req.body?.customer_ref || "").trim() || null;
    if (!packageCode) return res.status(400).json({ success: false, error: "Choose a data package" });
    if (!customerRef || !/^0[789][01]\d{8}$/.test(customerRef)) {
      return res.status(400).json({ success: false, error: "Enter the phone number to receive the data" });
    }

    const plans = await loadDataPlans("NG");
    const plan = plans.find((p) => p.code === packageCode);
    if (!plan) return res.status(400).json({ success: false, error: "That package is no longer available — refresh the list" });

    const wallet = await getOwnedWallet(String(req.body?.wallet_id || ""), userId, req.user!.businessId ?? null);
    if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
    if (wallet.currency !== "NGN") return res.status(400).json({ success: false, error: "Data purchases are charged in NGN" });
    const pinCheck = await verifyTransactionPin(pin, { userId, businessId: req.user!.businessId ?? null, wallet });
    if (!pinCheck.ok) return res.status(400).json({ success: false, error: pinCheck.error, code: pinCheck.code });

    const fee = await calculateFee(plan.price, "bill");
    const total = Math.round((plan.price + fee) * 100) / 100;
    if (Number(wallet.balance) < total) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: `You need ₦${total.toLocaleString()} for this bundle` });
    }
    const reference = genRef("MF-ESM");
    if (!(await debitWallet(wallet.id, total))) {
      return res.status(400).json({ success: false, code: "INSUFFICIENT_BALANCE", error: "Insufficient wallet balance" });
    }
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference,
      type: "debit", transactionType: "esim_order", amount: total, currency: "NGN",
      fee, description: `Data bundle — ${plan.name} (${customerRef})`,
    });
    await debitPlatformWallet(plan.price, "NGN", `${reference}-VENDOR`, "Data bundle vendor settlement", "esim");
    if (fee > 0) await creditRevenueWallet(fee, "NGN", reference, "Data bundle convenience fee", "esim");

    const dbInsert = await query(
      `INSERT INTO esim_orders
        (user_id, wallet_id, reference, provider, package_code, package_name, country_code, country_name,
         data_amount_mb, validity_days, customer_ref, total, fee, currency, status)
       VALUES ($1,$2,$3,'flutterwave',$4,$5,'NG','Nigeria',$6,$7,$8,$9,$10,'NGN','pending') RETURNING id`,
      [userId, wallet.id, reference, plan.code, plan.name, plan.dataAmountMb, plan.validityDays, customerRef, total, fee],
    );

    const result = await payBill({ reference, customer: customerRef, amount: plan.price, type: plan.providerCode });
    if (result.ok) {
      await query(
        `UPDATE esim_orders SET status = 'success', provider_reference = $2, provider_response = $3::jsonb,
         activation_details = $4::jsonb WHERE id = $1`,
        [dbInsert.rows[0].id, result.provider_reference || null, JSON.stringify(result.raw),
         JSON.stringify({
           activation_code: `Data bundle ${plan.name} sent to ${customerRef}`,
           qr_note: `No QR needed — the bundle is live on ${customerRef}.`,
           simulated: false,
         })],
      );
      createNotification({
        businessId: "", userId, type: "debit", title: "Data delivered",
        message: `${plan.name} is now active on ${customerRef}.`,
      }).catch(() => {});
      const fresh = await query(`SELECT * FROM esim_orders WHERE id = $1`, [dbInsert.rows[0].id]);
      const o = fresh.rows[0];
      return res.status(201).json({
        success: true,
        message: "Data delivered — the bundle is live.",
        order: {
          id: o.id, reference: o.provider_reference || o.reference, country_name: o.country_name,
          package_name: o.package_name, data_amount_mb: o.data_amount_mb, validity_days: o.validity_days,
          total: Number(o.total), status: o.status, activation_details: o.activation_details,
          created_at: o.created_at,
        },
      });
    }
    // Failed → refund
    await creditWallet(wallet.id, total);
    await insertTransaction({
      userId, businessId: wallet.business_id, walletId: wallet.id, reference: `${reference}-REFUND`,
      type: "credit", transactionType: "esim_refund", amount: total, currency: "NGN",
      description: "Refund — data bundle purchase failed",
    });
    await query(
      `UPDATE esim_orders SET status = 'failed', failure_reason = $2, refunded_at = CURRENT_TIMESTAMP, provider_response = $3::jsonb WHERE id = $1`,
      [dbInsert.rows[0].id, result.error || "Fulfilment failed", JSON.stringify(result.raw || null)],
    );
    return res.status(502).json({ success: false, error: result.error || "The data purchase failed and was refunded." });
  } catch (e: any) {
    console.error("esim purchase error:", e?.message);
    res.status(500).json({ success: false, error: "Could not complete the purchase" });
  }
});

export default router;
