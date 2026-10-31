import express from "express";
import { query } from "../db";
import { logAuditEvent } from "../services/audit";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import { getSetting, setSetting } from "../services/app-config";
import * as bitnob from "../services/bitnob";

/**
 * ADMIN — Virtual Card Management (mounted at /api/admin/personal/virtualcards).
 *
 *   GET  /              every issued card + cardholder (filters, pagination)
 *   GET  /kyc           card-KYC submissions (status, rejection reasons)
 *   GET  /config        fee knobs (issuance / funding / conversion) + rate override
 *   PUT  /config        write those knobs
 *   POST /:id/status    force freeze / unfreeze / terminate (provider + local)
 *   GET  /stats         KPI tiles (active cards, float, spend 30d)
 */
const router = express.Router();

router.use(authenticateAdmin);
router.use(requirePermission("manage_settings"));

const NUM_KEYS: Array<[string, number]> = [
  ["virtualcard_issuance_fee_usd", 0],
  ["virtualcard_funding_fee_percent", 1],
  ["virtualcard_conversion_fee_percent", 0.5],
  ["virtualcard_ngn_usd_rate_override", 0],
];

router.get("/config", async (_req, res) => {
  try {
    const out: Record<string, number | null> = {};
    for (const [key] of NUM_KEYS) {
      const raw = await getSetting(key, "");
      const n = Number(raw);
      out[key] = raw !== "" && Number.isFinite(n) ? n : null;
    }
    res.json({ success: true, data: { config: out } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.put("/config", async (req, res) => {
  try {
    const body = req.body?.config || req.body || {};
    const written: Record<string, number> = {};
    for (const [key] of NUM_KEYS) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, error: `${key} must be a non-negative number` });
      }
      await setSetting(key, String(n), `Virtual card knob ${key}`);
      written[key] = n;
    }
    await logAuditEvent({ action: "virtualcards.config.updated", newValues: written }).catch(() => {});
    res.json({ success: true, data: { written } });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message });
  }
});

router.get("/kyc", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const rows = await query(
      `SELECT k.*, u.name AS user_name, u.email AS user_email
         FROM virtual_card_kyc k LEFT JOIN users u ON u.id = k.user_id
        ORDER BY k.updated_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const total = Number((await query(`SELECT COUNT(*)::int AS c FROM virtual_card_kyc`)).rows[0]?.c || 0);
    res.json({ success: true, data: { submissions: rows.rows, page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e: any) {
    res.status(200).json({ success: true, data: { submissions: [], page: 1, limit: 50, total: 0, pages: 0 } });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const [active, float, spend, failed] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM virtual_cards WHERE status IN ('active','frozen')`),
      query(`SELECT COALESCE(SUM(balance),0)::float AS s FROM virtual_cards WHERE status IN ('active','frozen')`),
      query(`SELECT COALESCE(SUM(amount),0)::float AS s FROM virtual_card_transactions WHERE type = 'spend' AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'`),
      query(`SELECT COUNT(*)::int AS c FROM virtual_cards WHERE status = 'failed'`),
    ]);
    res.json({
      success: true,
      data: {
        active_cards: active.rows[0]?.c || 0,
        total_float_usd: float.rows[0]?.s || 0,
        spend_30d_usd: spend.rows[0]?.s || 0,
        failed_creations: failed.rows[0]?.c || 0,
        provider_configured: bitnob.isBitnobConfigured(),
      },
    });
  } catch (e: any) {
    res.status(200).json({ success: true, data: { active_cards: 0, total_float_usd: 0, spend_30d_usd: 0, failed_creations: 0, provider_configured: false } });
  }
});

router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const status = req.query.status ? String(req.query.status).toLowerCase() : null;
    const search = req.query.q ? String(req.query.q).trim() : null;

    const where: string[] = ["COALESCE(c.name,'') <> 'kyc-record'"];
    const params: any[] = [];
    if (status && status !== "all") {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.masked_pan ILIKE $${params.length})`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const rows = await query(
      `SELECT c.id, c.user_id, c.provider, c.status, c.category, c.card_brand, c.name AS card_name, c.masked_pan,
              c.balance::float AS balance, c.currency, c.failure_reason, c.created_at, c.updated_at,
              u.name AS user_name, u.email AS user_email, u.phone_number
         FROM virtual_cards c LEFT JOIN users u ON u.id = c.user_id
         ${whereSql}
        ORDER BY c.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const total = Number((await query(
      `SELECT COUNT(*)::int AS c FROM virtual_cards c LEFT JOIN users u ON u.id = c.user_id ${whereSql}`,
      params,
    )).rows[0]?.c || 0);
    res.json({ success: true, data: { cards: rows.rows, page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e: any) {
    res.status(200).json({ success: true, data: { cards: [], page: 1, limit: 25, total: 0, pages: 0 } });
  }
});

router.post("/:id/status", async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["freeze", "unfreeze", "terminate"].includes(action)) {
      return res.status(400).json({ success: false, error: "action must be freeze | unfreeze | terminate" });
    }
    const card = (await query(`SELECT * FROM virtual_cards WHERE id = $1`, [req.params.id])).rows[0];
    if (!card) return res.status(404).json({ success: false, error: "Card not found" });
    if (card.provider_card_id && bitnob.isBitnobConfigured()) {
      try {
        if (action === "terminate") await bitnob.terminateCard(card.provider_card_id, String(req.body?.reason || "admin_action"));
        else await bitnob.setCardStatus(card.provider_card_id, action === "freeze" ? "frozen" : "active");
      } catch (e: any) {
        return res.status(502).json({ success: false, error: `Provider call failed: ${e?.message || "unknown"}` });
      }
    }
    const newStatus = action === "terminate" ? "terminated" : action === "freeze" ? "frozen" : "active";
    await query(
      `UPDATE virtual_cards SET status = $2,
         balance = CASE WHEN $2 = 'terminated' THEN 0 ELSE balance END,
         terminated_at = CASE WHEN $2 = 'terminated' THEN CURRENT_TIMESTAMP ELSE terminated_at END,
         updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [card.id, newStatus],
    );
    await logAuditEvent({ action: "virtualcards.status_forced", newValues: { card: card.id, newStatus } }).catch(() => {});
    res.json({ success: true, data: { id: card.id, status: newStatus } });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message });
  }
});

export default router;
