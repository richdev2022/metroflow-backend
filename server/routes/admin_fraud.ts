import express from "express";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import { AuthenticatedAdminRequest } from "../middleware/adminAuth";
import { query } from "../db";
import { logAuditEvent } from "../services/audit";
import {
  invalidateFraudRuleCache,
  releaseFraudCase,
  rejectFraudCase,
  escalateFraudCase,
} from "../services/fraud";

/**
 * FRAUD & COMPLIANCE — admin side.
 * Mounted at /admin (see routes/admin.ts). authenticateAdmin is applied by
 * the parent router before this router is mounted.
 *
 *   GET    /admin/fraud/overview            KPIs + recent feed
 *   GET    /admin/fraud/evaluations         evaluation audit trail (filters)
 *   GET    /admin/fraud/cases               case queue (filters)
 *   POST   /admin/fraud/cases/:id/release   release a held case (manage_fraud)
 *   POST   /admin/fraud/cases/:id/reject    reject + optional blacklist (manage_fraud)
 *   POST   /admin/fraud/cases/:id/escalate  escalate (manage_fraud)
 *   GET    /admin/fraud/rules               rule catalogue (manage_fraud)
 *   PATCH  /admin/fraud/rules/:code         update rule (manage_fraud)
 *   GET    /admin/fraud/blacklists          list blacklists (manage_fraud)
 *   POST   /admin/fraud/blacklists          add entry (manage_fraud)
 *   DELETE /admin/fraud/blacklists/:id      remove entry (manage_fraud)
 *   GET    /admin/compliance/due-diligence  DD queue (manage_compliance)
 *   GET    /admin/compliance/due-diligence/:id  DD detail + docs (manage_compliance)
 *   POST   /admin/compliance/due-diligence/:id/approve    approve + release (manage_compliance)
 *   POST   /admin/compliance/due-diligence/:id/reject     reject (+ blacklist) (manage_compliance)
 *   POST   /admin/compliance/due-diligence/:id/more-info  request more info (manage_compliance)
 */

const router = express.Router();
router.use(authenticateAdmin);

// ─────────────────────────── overview ───────────────────────────
router.get("/fraud/overview", requirePermission("manage_fraud"), async (_req: AuthenticatedAdminRequest, res) => {
  try {
    const k = await query(`
      SELECT
        (SELECT COUNT(*) FROM fraud_cases WHERE status = 'open') AS open_cases,
        (SELECT COUNT(*) FROM fraud_cases WHERE status = 'escalated') AS escalated_cases,
        (SELECT COUNT(*) FROM fraud_cases WHERE status = 'open' AND direction = 'inflow') AS open_inflow,
        (SELECT COUNT(*) FROM fraud_cases WHERE status = 'open' AND direction = 'outflow') AS open_outflow,
        (SELECT COUNT(*) FROM fraud_evaluations WHERE decision = 'reject' AND created_at > NOW() - INTERVAL '24 hours') AS rejects_24h,
        (SELECT COUNT(*) FROM fraud_evaluations WHERE decision = 'hold' AND created_at > NOW() - INTERVAL '24 hours') AS holds_24h,
        (SELECT COUNT(*) FROM fraud_evaluations WHERE decision = 'flag' AND created_at > NOW() - INTERVAL '24 hours') AS flags_24h,
        (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (decided_at - created_at))), 0)
           FROM fraud_cases WHERE decided_at IS NOT NULL AND decided_at > NOW() - INTERVAL '7 days') AS avg_review_seconds,
        (SELECT COUNT(*) FROM due_diligence_cases WHERE status IN ('pending','submitted','under_review')) AS open_dd,
        (SELECT COUNT(*) FROM fraud_rules WHERE is_enabled = TRUE) AS enabled_rules
    `);
    const recent = await query(
      `SELECT fe.id, fe.direction, fe.flow, fe.amount, fe.currency, fe.decision, fe.score,
              fe.matched_rules, fe.created_at, fe.user_id, fe.business_id, fe.transfer_reference
         FROM fraud_evaluations fe ORDER BY fe.created_at DESC LIMIT 25`,
    );
    return res.json({ success: true, kpis: k.rows[0], recent: recent.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load fraud overview" });
  }
});

// ─────────────────────────── evaluations ───────────────────────────
router.get("/fraud/evaluations", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const { decision, direction, flow, search, page = "1", limit = "50" } = req.query as any;
    const params: any[] = [];
    const where: string[] = [];
    if (decision) { params.push(decision); where.push(`fe.decision = $${params.length}`); }
    if (direction) { params.push(direction); where.push(`fe.direction = $${params.length}`); }
    if (flow) { params.push(flow); where.push(`fe.flow = $${params.length}`); }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      const n = params.length;
      where.push(`(LOWER(fe.transfer_reference) LIKE $${n} OR LOWER(COALESCE(fe.business_id::text,'')) LIKE $${n} OR LOWER(COALESCE(fe.user_id::text,'')) LIKE $${n})`);
    }
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const rows = await query(
      `SELECT fe.* FROM fraud_evaluations fe
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY fe.created_at DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    return res.json({ success: true, evaluations: rows.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load evaluations" });
  }
});

// ─────────────────────────── cases ───────────────────────────
router.get("/fraud/cases", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const { status, direction, flow, search, page = "1", limit = "50" } = req.query as any;
    const params: any[] = [];
    const where: string[] = [];
    if (status) { params.push(status); where.push(`fc.status = $${params.length}`); }
    else where.push(`fc.status IN ('open','escalated')`);
    if (direction) { params.push(direction); where.push(`fc.direction = $${params.length}`); }
    if (flow) { params.push(flow); where.push(`fc.flow = $${params.length}`); }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      const n = params.length;
      where.push(`(LOWER(fc.transfer_reference) LIKE $${n} OR LOWER(COALESCE(fc.business_id,'')) LIKE $${n})`);
    }
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const rows = await query(
      `SELECT fc.*, fe.matched_rules, fe.score, fe.context AS evaluation_context,
              dd.status AS dd_status, dd.expires_at AS dd_expires_at
         FROM fraud_cases fc
         LEFT JOIN fraud_evaluations fe ON fe.id = fc.evaluation_id
         LEFT JOIN due_diligence_cases dd ON dd.fraud_case_id = fc.id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY fc.created_at DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    return res.json({ success: true, cases: rows.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load cases" });
  }
});

router.post("/fraud/cases/:id/release", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const notes = String(req.body?.notes || "");
    const result = await releaseFraudCase(String(req.params.id), req.admin?.adminId || "", notes);
    if (req.admin?.adminId) {
      logAuditEvent({ userId: req.admin.adminId, action: 'fraud_case_release', entityType: 'fraud_case', entityId: String(req.params.id), newValues: { notes } }).catch(() => {});
    }
    return res.status(result.ok ? 200 : 400).json({ success: result.ok, message: result.message });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Release failed" });
  }
});

router.post("/fraud/cases/:id/reject", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const notes = String(req.body?.notes || "");
    const bl = req.body?.blacklist || null;
    const result = await rejectFraudCase(String(req.params.id), req.admin?.adminId || "", notes,
      bl && bl.value ? { type: String(bl.type || "bank_account"), value: String(bl.value) } : null);
    if (req.admin?.adminId) {
      logAuditEvent({ userId: req.admin.adminId, action: 'fraud_case_reject', entityType: 'fraud_case', entityId: String(req.params.id), newValues: { notes, blacklist: bl } }).catch(() => {});
    }
    return res.status(result.ok ? 200 : 400).json({ success: result.ok, message: result.message });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Reject failed" });
  }
});

router.post("/fraud/cases/:id/escalate", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const notes = String(req.body?.notes || "");
    const result = await escalateFraudCase(String(req.params.id), req.admin?.adminId || "", notes);
    if (req.admin?.adminId) {
      logAuditEvent({ userId: req.admin.adminId, action: 'fraud_case_escalate', entityType: 'fraud_case', entityId: String(req.params.id), newValues: { notes } }).catch(() => {});
    }
    return res.status(result.ok ? 200 : 400).json({ success: result.ok, message: result.message });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Escalate failed" });
  }
});

// ─────────────────────────── rules ───────────────────────────
router.get("/fraud/rules", requirePermission("manage_fraud"), async (_req: AuthenticatedAdminRequest, res) => {
  try {
    const rows = await query(`SELECT * FROM fraud_rules ORDER BY priority ASC`);
    return res.json({ success: true, rules: rows.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load rules" });
  }
});

const RULE_ACTIONS = ["allow", "flag", "hold", "reject"];
router.patch("/fraud/rules/:code", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const { code } = req.params;
    const body = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    if (body.is_enabled !== undefined) {
      params.push(body.is_enabled === true || body.is_enabled === "true");
      sets.push(`is_enabled = $${params.length}`);
    }
    if (body.action !== undefined) {
      if (!RULE_ACTIONS.includes(body.action)) return res.status(400).json({ success: false, error: "Invalid action" });
      params.push(body.action);
      sets.push(`action = $${params.length}`);
    }
    if (body.threshold !== undefined) {
      if (typeof body.threshold !== "object") return res.status(400).json({ success: false, error: "threshold must be an object" });
      params.push(JSON.stringify(body.threshold));
      sets.push(`threshold = $${params.length}::jsonb`);
    }
    if (body.weight !== undefined) {
      const w = parseInt(String(body.weight), 10);
      if (!Number.isFinite(w) || w < 0 || w > 100) return res.status(400).json({ success: false, error: "weight must be 0-100" });
      params.push(w);
      sets.push(`weight = $${params.length}`);
    }
    if (body.priority !== undefined) {
      const p = parseInt(String(body.priority), 10);
      if (!Number.isFinite(p)) return res.status(400).json({ success: false, error: "priority must be an integer" });
      params.push(p);
      sets.push(`priority = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ success: false, error: "Nothing to update" });
    params.push(code);
    const r = await query(
      `UPDATE fraud_rules SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE code = $${params.length} RETURNING *`,
      params,
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: "Rule not found" });
    invalidateFraudRuleCache();
    if (req.admin?.adminId) logAuditEvent({ userId: req.admin.adminId, action: 'fraud_rule_update', entityType: 'fraud_rule', entityId: String(code), newValues: body }).catch(() => {});
    return res.json({ success: true, rule: r.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Rule update failed" });
  }
});

// ─────────────────────────── blacklists ───────────────────────────
router.get("/fraud/blacklists", requirePermission("manage_fraud"), async (_req: AuthenticatedAdminRequest, res) => {
  try {
    const rows = await query(`SELECT * FROM fraud_blacklists ORDER BY created_at DESC LIMIT 500`);
    return res.json({ success: true, blacklists: rows.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load blacklists" });
  }
});

const BL_TYPES = ["user", "business", "device", "ip", "bank_account", "phone"];
router.post("/fraud/blacklists", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const { type, value, reason } = req.body || {};
    if (!BL_TYPES.includes(String(type))) return res.status(400).json({ success: false, error: "Invalid type" });
    if (!value || String(value).length < 3) return res.status(400).json({ success: false, error: "value is required (min 3 chars)" });
    const r = await query(
      `INSERT INTO fraud_blacklists (type, value, reason, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (type, value) DO UPDATE SET reason = EXCLUDED.reason RETURNING *`,
      [type, String(value).trim(), reason || "", req.admin?.adminId || null],
    );
    if (req.admin?.adminId) logAuditEvent({ userId: req.admin.adminId, action: 'fraud_blacklist_add', entityType: 'fraud_blacklist', entityId: String(value), newValues: { type, value, reason } }).catch(() => {});
    return res.json({ success: true, entry: r.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Blacklist add failed" });
  }
});

router.delete("/fraud/blacklists/:id", requirePermission("manage_fraud"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const r = await query(`DELETE FROM fraud_blacklists WHERE id = $1 RETURNING id`, [String(req.params.id)]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: "Entry not found" });
    if (req.admin?.adminId) logAuditEvent({ userId: req.admin.adminId, action: 'fraud_blacklist_remove', entityType: 'fraud_blacklist', entityId: String(req.params.id) }).catch(() => {});
    return res.json({ success: true, message: "Entry removed" });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Blacklist remove failed" });
  }
});

// ─────────────────────────── due diligence (compliance) ───────────────────────────
router.get("/compliance/due-diligence", requirePermission("manage_compliance"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const { status, page = "1", limit = "50" } = req.query as any;
    const params: any[] = [];
    const where: string[] = [];
    if (status) { params.push(status); where.push(`dd.status = $${params.length}`); }
    else where.push(`dd.status IN ('pending','submitted','under_review')`);
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const rows = await query(
      `SELECT dd.*, fc.transfer_reference, fc.amount AS case_amount, fc.currency, fc.direction, fc.flow,
              u.email AS user_email, u.name AS user_name
         FROM due_diligence_cases dd
         LEFT JOIN fraud_cases fc ON fc.id = dd.fraud_case_id
         LEFT JOIN users u ON u.id = dd.user_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY dd.created_at DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    return res.json({ success: true, cases: rows.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load DD queue" });
  }
});

router.get("/compliance/due-diligence/:id", requirePermission("manage_compliance"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const rows = await query(
      `SELECT dd.*, fc.transfer_reference, fc.amount AS case_amount, fc.currency, fc.direction, fc.flow,
              fe.matched_rules, fe.score, fe.context AS evaluation_context,
              u.email AS user_email, u.name AS user_name
         FROM due_diligence_cases dd
         LEFT JOIN fraud_cases fc ON fc.id = dd.fraud_case_id
         LEFT JOIN fraud_evaluations fe ON fe.id = fc.evaluation_id
         LEFT JOIN users u ON u.id = dd.user_id
        WHERE dd.id = $1`,
      [String(req.params.id)],
    );
    if (rows.rows.length === 0) return res.status(404).json({ success: false, error: "Case not found" });
    const docs = await query(
      `SELECT id, field_key, file_url, file_name, mime_type, size_bytes, created_at FROM due_diligence_documents WHERE case_id = $1`,
      [String(req.params.id)],
    );
    return res.json({ success: true, case: rows.rows[0], documents: docs.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Failed to load DD case" });
  }
});

async function loadDdCase(id: string) {
  const rows = await query(`SELECT * FROM due_diligence_cases WHERE id = $1 FOR UPDATE`, [id]);
  return rows.rows[0] || null;
}

router.post("/compliance/due-diligence/:id/approve", requirePermission("manage_compliance"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const dd = await loadDdCase(String(req.params.id));
    if (!dd) return res.status(404).json({ success: false, error: "Case not found" });
    if (!["submitted", "under_review"].includes(dd.status)) {
      return res.status(400).json({ success: false, error: `Case is ${dd.status}; only submitted/under_review can be approved` });
    }
    const notes = String(req.body?.notes || "");
    await query(
      `UPDATE due_diligence_cases SET status='approved', reviewed_by=$2, reviewed_at=CURRENT_TIMESTAMP,
         review_notes=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [dd.id, req.admin?.adminId || null, notes],
    );
    if (dd.fraud_case_id) {
      const result = await releaseFraudCase(dd.fraud_case_id, req.admin?.adminId || "", notes || "DD approved");
      if (!result.ok) return res.status(400).json({ success: false, error: result.message });
    }
    if (req.admin?.adminId) logAuditEvent({ userId: req.admin.adminId, action: 'dd_approve', entityType: 'due_diligence_case', entityId: dd.id, newValues: { notes } }).catch(() => {});
    return res.json({ success: true, message: "Approved — held transaction released" });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Approve failed" });
  }
});

router.post("/compliance/due-diligence/:id/reject", requirePermission("manage_compliance"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const dd = await loadDdCase(String(req.params.id));
    if (!dd) return res.status(404).json({ success: false, error: "Case not found" });
    if (!["submitted", "under_review"].includes(dd.status)) {
      return res.status(400).json({ success: false, error: `Case is ${dd.status}; only submitted/under_review can be rejected` });
    }
    const notes = String(req.body?.notes || "");
    await query(
      `UPDATE due_diligence_cases SET status='rejected', reviewed_by=$2, reviewed_at=CURRENT_TIMESTAMP,
         review_notes=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [dd.id, req.admin?.adminId || null, notes],
    );
    if (dd.fraud_case_id) {
      const result = await rejectFraudCase(dd.fraud_case_id, req.admin?.adminId || "", notes || "DD rejected", null);
      if (!result.ok) return res.status(400).json({ success: false, error: result.message });
    }
    if (req.admin?.adminId) logAuditEvent({ userId: req.admin.adminId, action: 'dd_reject', entityType: 'due_diligence_case', entityId: dd.id, newValues: { notes } }).catch(() => {});
    return res.json({ success: true, message: "Rejected — held transaction declined" });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Reject failed" });
  }
});

router.post("/compliance/due-diligence/:id/more-info", requirePermission("manage_compliance"), async (req: AuthenticatedAdminRequest, res) => {
  try {
    const dd = await loadDdCase(String(req.params.id));
    if (!dd) return res.status(404).json({ success: false, error: "Case not found" });
    const notes = String(req.body?.notes || "");
    if (!notes) return res.status(400).json({ success: false, error: "notes (what you need from the user) are required" });
    await query(
      `UPDATE due_diligence_cases SET status='pending', review_notes=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [dd.id, notes],
    );
    if (req.admin?.adminId) logAuditEvent({ userId: req.admin.adminId, action: 'dd_more_info', entityType: 'due_diligence_case', entityId: dd.id, newValues: { notes } }).catch(() => {});
    return res.json({ success: true, message: "More information requested" });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message || "Request failed" });
  }
});

export default router;
