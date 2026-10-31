import express from "express";
import { logAuditEvent } from "../services/audit";
import { authenticateAdmin, requirePermission } from "../middleware/adminAuth";
import {
  listProviders,
  getProviderBalance,
  getAllProviderBalances,
  getProviderHistory,
  PROVIDER_KEYS,
} from "../services/provider-balances";
import { getSetting, setSetting } from "../services/app-config";
import { getFeatureToggles, setFeatureToggle, FEATURE_APPS } from "../features/personal/flags";

/**
 * ADMIN — "Provider's Balance" desk (mounted at /api/admin/personal/providers).
 *
 * Replaces the flat "Prestmit" menu entry with a provider-aware treasury
 * surface: pick a provider, see its platform wallet balances (ledger /
 * available / withdrawable), low-balance flags and its transaction history —
 * so pre-funding decisions (e.g. sweeping Flutterwave → Sogo/Prestmit for
 * service operations, Flutterwave → Bitnob for virtual cards) and
 * reconciliation happen from one screen.
 *
 *   GET  /                         provider list (configured flags + usage)
 *   GET  /balances                 every provider snapshot in one payload
 *   GET  /:provider/balance        one provider's normalized balances
 *   GET  /:provider/history        provider-native transaction history
 *   GET  /thresholds               low-balance alert thresholds
 *   PUT  /thresholds               update low-balance alert thresholds
 *   GET  /feature-toggles          per-app "Coming soon" feature toggles
 *   PUT  /feature-toggles          toggle a feature ON/OFF per app
 */
const router = express.Router();

router.use(authenticateAdmin);

/** Read endpoints are open to every admin with dashboard access. */
router.get("/", async (_req, res) => {
  try {
    const providers = await listProviders();
    res.json({ success: true, data: { providers, keys: PROVIDER_KEYS } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || "Provider list unavailable" });
  }
});

router.get("/balances", async (_req, res) => {
  try {
    const all = await getAllProviderBalances();
    res.json({ success: true, data: all });
  } catch (e: any) {
    res.status(502).json({ success: false, error: e?.message || "Provider balances unavailable" });
  }
});

router.get("/thresholds", async (_req, res) => {
  try {
    const raw = await getSetting("provider_low_balance_thresholds", "");
    let parsed: Record<string, number> = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
    res.json({ success: true, data: { thresholds: parsed } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.put("/thresholds", requirePermission("manage_settings"), async (req, res) => {
  try {
    const body = req.body || {};
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.thresholds || body)) {
      const n = Number(v);
      if (typeof k === "string" && /^[A-Z]{3,6}$/.test(k) && Number.isFinite(n) && n >= 0) clean[k] = n;
    }
    await setSetting("provider_low_balance_thresholds", JSON.stringify(clean), "Provider low-balance alert thresholds");
    await logAuditEvent({ action: "provider.thresholds.updated", newValues: clean }).catch(() => {});
    res.json({ success: true, data: { thresholds: clean } });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message });
  }
});

// Feature toggles ("Coming soon") — kept here so the Provider's Balance /
// settings surface admin-manages them alongside the treasury desk.
router.get("/feature-toggles", async (_req, res) => {
  try {
    const toggles = await getFeatureToggles();
    res.json({ success: true, data: { apps: FEATURE_APPS, toggles } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message });
  }
});

router.put("/feature-toggles", requirePermission("manage_settings"), async (req, res) => {
  try {
    const app = String(req.body?.app || "").toLowerCase();
    const feature = String(req.body?.feature || "").toLowerCase();
    const enabled = req.body?.enabled;
    if (!FEATURE_APPS.map((a) => String(a)).includes(app)) {
      return res.status(400).json({ success: false, error: `app must be one of: ${FEATURE_APPS.join(", ")}` });
    }
    if (!feature) return res.status(400).json({ success: false, error: "feature is required" });
    if (typeof enabled !== "boolean") return res.status(400).json({ success: false, error: "enabled must be a boolean" });
    const toggles = await setFeatureToggle(app as any, feature, enabled);
    await logAuditEvent({ action: "features.toggled", newValues: { app, feature, enabled } }).catch(() => {});
    res.json({ success: true, data: { app, feature, enabled, toggles } });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message });
  }
});

// NOTE: /:provider/* are LAST so the static routes above always win.
router.get("/:provider/balance", async (req, res) => {
  try {
    const snapshot = await getProviderBalance(req.params.provider);
    res.json({ success: true, data: snapshot });
  } catch (e: any) {
    res.status(e?.status || 502).json({ success: false, error: e?.message || "Provider balance unavailable" });
  }
});

router.get("/:provider/history", async (req, res) => {
  try {
    const { page, currency, from, to, status, type } = req.query as Record<string, string | undefined>;
    const history = await getProviderHistory(req.params.provider, {
      page: page ? Number(page) : undefined,
      currency,
      from,
      to,
      status,
      type,
    });
    res.json({ success: true, data: history });
  } catch (e: any) {
    res.status(e?.status || 502).json({ success: false, error: e?.message || "Provider history unavailable" });
  }
});

export default router;
