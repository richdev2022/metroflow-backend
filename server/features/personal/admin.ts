/**
 * ADMIN — Personal Products console (mounted at /api/admin/personal).
 *
 * End-to-end management surface for every Personal-app product line:
 *   GET  /overview   monitoring: 7d/30d volume+count+fees per service, recent
 *                    activity feed, provider status, app flags, user counts
 *   GET  /config     services (flags + routing modes) + pricing snapshot
 *   PUT  /config     write service flags, provider routing, pricing knobs
 *
 * Auth: self-contained — authenticateAdmin + requirePermission('manage_settings').
 * Mounted at /api/admin/personal (before the protectedRouter catch-all).
 */

import express from "express";
import { query } from "../../db";
import { getSetting } from "../../services/app-config";
import { logAuditEvent } from "../../services/audit";
import { authenticateAdmin, requirePermission } from "../../middleware/adminAuth";
import {
    PERSONAL_SERVICES,
    ROUTED_SERVICES,
    PersonalService,
    ProviderMode,
    RoutedService,
    getAllPercentSettings,
    getPersonalServiceFlags,
    getProviderModes,
    setPercent,
} from "./flags";

const router = express.Router();

// Self-contained auth: mounted before protectedRouter in routes/admin.ts.
router.use(authenticateAdmin);
router.use(requirePermission("manage_settings"));

// ---------------------------------------------------------------------------
// Provider configured helpers (env truth)
// ---------------------------------------------------------------------------
function providerConfigured(service: RoutedService): boolean {
    switch (service) {
        case "bills":
            // Sogo default (SOGO_SECRET_KEY) with the Flutterwave v3 bridge second.
            return !!(process.env.SOGO_SECRET_KEY || process.env.FLW_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY || process.env.BILLS_PROVIDER_URL);
        case "esim":
            return !!process.env.ESIM_PROVIDER_URL;
        case "giftcards":
            // Sogo default for gift cards too; Prestmit remains the legacy rail.
            return !!(process.env.SOGO_SECRET_KEY || process.env.PRESTMIT_PUBLIC_KEY || process.env.PRESTMIT_PRIVATE_KEY);
        case "virtualcards":
        case "crypto":
            return !!(process.env.SOGO_SECRET_KEY || process.env.BITNOB_SECRET_KEY || process.env.BITNOB_API_KEY);
        default:
            return false;
    }
}

const PROVIDER_LABELS: Record<RoutedService, string> = {
    bills: "Sogo (SOGO_SECRET_KEY) — Flutterwave v3 bridge (FLW_SECRET_KEY)",
    esim: "eSIM provider (ESIM_PROVIDER_URL)",
    giftcards: "Sogo (SOGO_SECRET_KEY) — Prestmit legacy (PRESTMIT_* keys)",
    virtualcards: "Bitnob card issuing (BITNOB_* keys)",
    crypto: "Sogo deposit off-ramp (SOGO_SECRET_KEY) — Bitnob payouts (BITNOB_* keys)",
};

// ---------------------------------------------------------------------------
// GET /overview — monitoring snapshot
// ---------------------------------------------------------------------------
const RECENT_LIMIT_PER_SERVICE = 4;

async function windowStats(sql: string, params: any[] = []): Promise<any> {
    const res = await query(sql, params);
    return res.rows[0] || {};
}

router.get("/overview", async (_req, res) => {
    try {
        const [
            bills7, bills30,
            giftcards7, giftcards30,
            esim7, esim30,
            vcTx7, vcTx30, vcCards,
            crypto7, crypto30,
            savings7, savings30, savingsTotals,
            swap7, swap30,
            socialCounts, liveCounts,
            userCounts,
        ] = await Promise.all([
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='success')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                    COUNT(*) FILTER (WHERE status='pending')::int AS pending
                FROM bill_payments WHERE created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='success')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed
                FROM bill_payments WHERE created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(CASE WHEN direction='buy' THEN total_charged ELSE payout_amount END),0) AS volume,
                    COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='successful')::int AS success, COUNT(*) FILTER (WHERE status IN ('failed','rejected'))::int AS failed,
                    COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending
                FROM gift_card_trades WHERE created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(CASE WHEN direction='buy' THEN total_charged ELSE payout_amount END),0) AS volume,
                    COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='successful')::int AS success, COUNT(*) FILTER (WHERE status IN ('failed','rejected'))::int AS failed
                FROM gift_card_trades WHERE created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='success')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                    COUNT(*) FILTER (WHERE status='pending')::int AS pending
                FROM esim_orders WHERE created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='success')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed
                FROM esim_orders WHERE created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='completed')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                    COUNT(*) FILTER (WHERE status='pending')::int AS pending
                FROM virtual_card_transactions WHERE created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='completed')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed
                FROM virtual_card_transactions WHERE created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT COUNT(*)::int AS total_cards, COUNT(*) FILTER (WHERE status IN ('active','pending','frozen'))::int AS active_cards,
                    COALESCE(SUM(balance) FILTER (WHERE status IN ('active','pending','frozen')),0) AS card_balance
                FROM virtual_cards`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(settlement_amount),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='completed')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                    COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending
                FROM crypto_sales WHERE created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(settlement_amount),0) AS volume, COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='completed')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed
                FROM crypto_sales WHERE created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(CASE WHEN type IN ('deposit','auto_save') THEN amount ELSE 0 END),0) AS volume,
                    COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='success')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed
                FROM savings_transactions WHERE created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(CASE WHEN type IN ('deposit','auto_save') THEN amount ELSE 0 END),0) AS volume,
                    COALESCE(SUM(fee),0) AS fees,
                    COUNT(*) FILTER (WHERE status='success')::int AS success, COUNT(*) FILTER (WHERE status='failed')::int AS failed
                FROM savings_transactions WHERE created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT COUNT(*)::int AS total_vaults, COUNT(*) FILTER (WHERE status='active')::int AS active_vaults,
                    COALESCE(SUM(balance) FILTER (WHERE status='active'),0) AS vault_balance,
                    COUNT(*) FILTER (WHERE auto_save_enabled AND status='active')::int AS autosave_vaults
                FROM savings_vaults`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS volume, COALESCE(SUM(fee),0) AS fees
                FROM transactions WHERE transaction_type='swap' AND status='success' AND created_at > NOW() - INTERVAL '7 days'`),
            windowStats(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS volume, COALESCE(SUM(fee),0) AS fees
                FROM transactions WHERE transaction_type='swap' AND status='success' AND created_at > NOW() - INTERVAL '30 days'`),
            windowStats(`SELECT (SELECT COUNT(*)::int FROM feed_posts) AS posts, (SELECT COUNT(*)::int FROM feed_posts WHERE created_at > NOW() - INTERVAL '7 days') AS posts_7d,
                (SELECT COUNT(*)::int FROM polls) AS polls, (SELECT COUNT(*)::int FROM poll_votes) AS votes,
                (SELECT COUNT(*)::int FROM feed_likes) AS likes, (SELECT COUNT(*)::int FROM feed_comments) AS comments`),
            windowStats(`SELECT (SELECT COUNT(*)::int FROM live_sessions) AS sessions,
                (SELECT COUNT(*)::int FROM live_sessions WHERE created_at > NOW() - INTERVAL '7 days') AS sessions_7d,
                (SELECT COUNT(*)::int FROM live_sessions WHERE status='live') AS live_now,
                (SELECT COALESCE(SUM(view_count),0)::int FROM live_sessions) AS total_views`),
            windowStats(`SELECT (SELECT COUNT(*)::int FROM users WHERE account_type='personal') AS personal_users,
                (SELECT COUNT(*)::int FROM users) AS total_users,
                (SELECT COUNT(*)::int FROM users WHERE account_type IS NULL) AS unclassified_users`),
        ]);

        const num = (v: any) => (v == null ? 0 : Number(v));
        const shape = (s: any, extra: any = {}) => ({
            count: num(s.count),
            volume: num(s.volume),
            fees: num(s.fees),
            success: num(s.success),
            failed: num(s.failed),
            pending: num(s.pending),
            ...extra,
        });

        const services: Record<string, any> = {
            bills: { "7d": shape(bills7), "30d": shape(bills30) },
            giftcards: { "7d": shape(giftcards7), "30d": shape(giftcards30) },
            esim: { "7d": shape(esim7), "30d": shape(esim30) },
            virtualcards: {
                "7d": shape(vcTx7, { total_cards: num(vcCards.total_cards), active_cards: num(vcCards.active_cards), card_balance: num(vcCards.card_balance) }),
                "30d": shape(vcTx30),
            },
            crypto: { "7d": shape(crypto7), "30d": shape(crypto30) },
            savings: {
                "7d": shape(savings7),
                "30d": shape(savings30),
                total_vaults: num(savingsTotals.total_vaults),
                active_vaults: num(savingsTotals.active_vaults),
                vault_balance: num(savingsTotals.vault_balance),
                autosave_vaults: num(savingsTotals.autosave_vaults),
            },
            swap: { "7d": shape(swap7), "30d": shape(swap30) },
            social: {
                posts: num(socialCounts.posts),
                posts_7d: num(socialCounts.posts_7d),
                polls: num(socialCounts.polls),
                votes: num(socialCounts.votes),
                likes: num(socialCounts.likes),
                comments: num(socialCounts.comments),
            },
            live: {
                sessions: num(liveCounts.sessions),
                sessions_7d: num(liveCounts.sessions_7d),
                live_now: num(liveCounts.live_now),
                total_views: num(liveCounts.total_views),
            },
        };

        // ---- Recent activity: latest few per service, merged + sorted ----
        const recentRes = await query(`
            (SELECT 'bills' AS service, reference, status, total AS amount, 'NGN' AS currency,
                    COALESCE(provider_name, category) AS detail, user_id, created_at, fulfilment_mode
             FROM bill_payments ORDER BY created_at DESC LIMIT ${RECENT_LIMIT_PER_SERVICE})
            UNION ALL
            (SELECT 'giftcards' AS service, reference, status, COALESCE(total_charged, payout_amount) AS amount, 'NGN' AS currency,
                    COALESCE(giftcard_name, 'Gift card') AS detail, user_id, created_at, direction AS fulfilment_mode
             FROM gift_card_trades ORDER BY created_at DESC LIMIT ${RECENT_LIMIT_PER_SERVICE})
            UNION ALL
            (SELECT 'esim' AS service, reference, status, total AS amount, 'NGN' AS currency,
                    COALESCE(package_name, country_name) AS detail, user_id, created_at, fulfilment_mode
             FROM esim_orders ORDER BY created_at DESC LIMIT ${RECENT_LIMIT_PER_SERVICE})
            UNION ALL
            (SELECT 'virtualcards' AS service, reference, status, amount, COALESCE(currency,'USD') AS currency,
                    type AS detail, user_id, created_at, NULL AS fulfilment_mode
             FROM virtual_card_transactions ORDER BY created_at DESC LIMIT ${RECENT_LIMIT_PER_SERVICE})
            UNION ALL
            (SELECT 'crypto' AS service, reference, status, settlement_amount AS amount, 'NGN' AS currency,
                    from_asset AS detail, user_id, created_at, provider AS fulfilment_mode
             FROM crypto_sales ORDER BY created_at DESC LIMIT ${RECENT_LIMIT_PER_SERVICE})
            UNION ALL
            (SELECT 'swap' AS service, reference, status, amount, currency, description AS detail, user_id, created_at, NULL AS fulfilment_mode
             FROM transactions WHERE transaction_type='swap' ORDER BY created_at DESC LIMIT ${RECENT_LIMIT_PER_SERVICE})
            ORDER BY created_at DESC
            LIMIT 20
        `);

        // Enrich with user emails (best effort)
        const userIds = [...new Set(recentRes.rows.map((r: any) => r.user_id).filter(Boolean))];
        const userMap = new Map<string, any>();
        if (userIds.length) {
            const users = await query(`SELECT id, email, name FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
            for (const u of users.rows) userMap.set(u.id, u);
        }
        const recent = recentRes.rows.map((r: any) => {
            const u = userMap.get(r.user_id);
            return {
                ...r,
                amount: Number(r.amount) || 0,
                user_email: u?.email || null,
                user_name: u ? (u.name || u.email) : null,
            };
        });

        const [flags, modes, businessFlag, personalFlag] = await Promise.all([
            getPersonalServiceFlags(),
            getProviderModes(),
            getSetting("business_app_enabled", "true"),
            getSetting("personal_app_enabled", "false"),
        ]);

        res.json({
            success: true,
            data: {
                services,
                recent,
                users: {
                    personal_users: Number(userCounts.personal_users) || 0,
                    total_users: Number(userCounts.total_users) || 0,
                    unclassified_users: Number(userCounts.unclassified_users) || 0,
                },
                app_flags: {
                    business_app_enabled: String(businessFlag || "true").toLowerCase() !== "false",
                    personal_app_enabled: String(personalFlag || "false").toLowerCase() === "true",
                },
                service_flags: flags,
                provider_modes: modes,
                providers: ROUTED_SERVICES.map((s) => {
                    const mode = modes[s] || "auto";
                    const effective: "provider" | "simulator" =
                        mode === "provider" ? "provider"
                        : mode === "simulator" ? "simulator"
                        : providerConfigured(s) ? "provider" : "simulator";
                    return {
                        service: s,
                        provider: s === "giftcards" ? "Sogo / Prestmit" : s === "bills" ? "Sogo / Flutterwave" : s === "esim" ? "eSIM provider" : s === "crypto" ? "Sogo / Bitnob" : "Bitnob",
                        env_configured: providerConfigured(s),
                        mode,
                        effective,
                        env_note: PROVIDER_LABELS[s],
                    };
                }),
            },
        });
    } catch (error: any) {
        console.error("[admin/personal] overview failed:", error?.message);
        res.status(500).json({ success: false, error: error.message || "Failed to load personal products overview" });
    }
});

// ---------------------------------------------------------------------------
// GET /config — services + pricing snapshot
// ---------------------------------------------------------------------------
router.get("/config", async (_req, res) => {
    try {
        const [flags, modes, percents] = await Promise.all([
            getPersonalServiceFlags(),
            getProviderModes(),
            getAllPercentSettings(),
        ]);

        const feeRes = await query(
            `SELECT fee_type, name, config_type, config, currency FROM fee_configurations WHERE fee_type = ANY($1)`,
            [["bill", "esim", "swap", "savings_break"]],
        );
        const feeRows = feeRes.rows.map((r: any) => ({
            fee_type: r.fee_type,
            name: r.name,
            config_type: r.config_type,
            config: typeof r.config === "string" ? JSON.parse(r.config) : r.config,
            currency: r.currency,
        }));

        res.json({
            success: true,
            data: {
                services: PERSONAL_SERVICES.map((s) => ({
                    service: s,
                    enabled: flags[s] !== false,
                    routable: (ROUTED_SERVICES as readonly string[]).includes(s),
                    provider_mode: (modes as any)[s] || null,
                    env_configured: (ROUTED_SERVICES as readonly string[]).includes(s) ? providerConfigured(s as RoutedService) : null,
                })),
                pricing: {
                    ...percents,
                    fees: feeRows,
                },
            },
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load personal products config" });
    }
});

// ---------------------------------------------------------------------------
// PUT /config — write flags, routing, pricing
// Body (all optional):
//   services: { [service]: { enabled?: boolean, provider_mode?: 'auto'|'provider'|'simulator' } }
//   pricing:  { giftcard_sell_fee_percent?, giftcard_buy_fee_percent?,
//               crypto_spread_percent?, virtualcard_funding_fee_percent?,
//               bills_fee_flat?, esim_fee_flat?, swap_fee_percent? }   (null resets to default)
// ---------------------------------------------------------------------------
router.put("/config", async (req, res) => {
    try {
        const body = req.body || {};
        const services = body.services || {};
        const pricing = body.pricing || {};

        // ---- Service flags ----
        const validServices = new Set<string>(PERSONAL_SERVICES);
        const flagUpdates: Record<string, boolean> = {};
        for (const [svc, patch] of Object.entries(services)) {
            if (!validServices.has(svc)) return res.status(400).json({ success: false, error: `Unknown service: ${svc}` });
            const p = (patch || {}) as any;
            if (typeof p.enabled === "boolean") flagUpdates[svc] = p.enabled;
            if (p.provider_mode !== undefined) {
                if ((ROUTED_SERVICES as readonly string[]).includes(svc)) {
                    if (!["auto", "provider", "simulator"].includes(p.provider_mode)) {
                        return res.status(400).json({ success: false, error: `provider_mode must be auto|provider|simulator` });
                    }
                } else {
                    return res.status(400).json({ success: false, error: `${svc} has no external provider` });
                }
            }
        }

        if (Object.keys(flagUpdates).length) {
            const current = await getPersonalServiceFlags();
            const next = { ...current };
            for (const [svc, enabled] of Object.entries(flagUpdates)) (next as any)[svc] = enabled;
            await query(
                `INSERT INTO system_settings (key, value, description, updated_at)
                 VALUES ('personal_service_flags', $1, 'Personal product service flags (admin console)', CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
                [JSON.stringify(next)],
            );
        }

        // ---- Provider routing ----
        const modeUpdates: Record<string, ProviderMode> = {};
        for (const [svc, patch] of Object.entries(services)) {
            const p = (patch || {}) as any;
            if (p.provider_mode !== undefined && (ROUTED_SERVICES as readonly string[]).includes(svc)) {
                modeUpdates[svc] = p.provider_mode;
            }
        }
        if (Object.keys(modeUpdates).length) {
            const modes = await getProviderModes();
            const next = { ...modes, ...modeUpdates };
            await query(
                `INSERT INTO system_settings (key, value, description, updated_at)
                 VALUES ('personal_provider_modes', $1, 'Personal provider routing (auto|provider|simulator)', CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
                [JSON.stringify(next)],
            );
        }

        // ---- Pricing: percent settings ----
        const percentKeys: Record<string, [number, number]> = {
            giftcard_sell_fee_percent: [5, 50],
            giftcard_buy_fee_percent: [5, 50],
            crypto_spread_percent: [1, 50],
            virtualcard_funding_fee_percent: [1, 50],
        };
        for (const [key, [fb, max]] of Object.entries(percentKeys)) {
            if (pricing[key] !== undefined) await setPercent(key, pricing[key], fb, max);
        }

        // ---- Pricing: fee_configurations rows ----
        // fee_configurations has no UNIQUE(fee_type) guarantee in every
        // environment, so upsert via UPDATE then guarded INSERT.
        async function upsertFee(feeType: string, name: string, configType: string, config: any, currency = "NGN") {
            const upd = await query(
                `UPDATE fee_configurations
                 SET name = $1, config_type = $3, config = $4::jsonb, currency = $5, updated_at = CURRENT_TIMESTAMP
                 WHERE fee_type = $2`,
                [name, feeType, configType, JSON.stringify(config), currency],
            );
            if (upd.rowCount === 0) {
                await query(
                    `INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
                     SELECT $1, $2, $3, $4::jsonb, $5
                     WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = $2)`,
                    [name, feeType, configType, JSON.stringify(config), currency],
                );
            }
        }

        const numOrNull = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));

        if (pricing.bills_fee_flat !== undefined) {
            const flat = numOrNull(pricing.bills_fee_flat);
            if (flat === null) throw new Error("bills_fee_flat must be a number (NGN)");
            if (flat < 0 || flat > 100000) throw new Error("bills_fee_flat must be between 0 and 100000 NGN");
            await upsertFee("bill", "Bill Payment Convenience Fee", "flat", { amount: flat });
        }
        if (pricing.esim_fee_flat !== undefined) {
            const flat = numOrNull(pricing.esim_fee_flat);
            if (flat === null) throw new Error("esim_fee_flat must be a number (NGN)");
            if (flat < 0 || flat > 100000) throw new Error("esim_fee_flat must be between 0 and 100000 NGN");
            await upsertFee("esim", "eSIM Purchase Fee", "flat", { amount: flat });
        }
        if (pricing.swap_fee_percent !== undefined) {
            const pct = numOrNull(pricing.swap_fee_percent);
            if (pct === null) throw new Error("swap_fee_percent must be a number");
            if (pct < 0 || pct > 10) throw new Error("swap_fee_percent must be between 0 and 10%");
            await upsertFee("swap", "Wallet Swap Fee", "percentage_cap", { percentage: pct, cap: null });
        }

        logAuditEvent({
            userId: (req as any).admin?.adminId || null,
            action: "personal_products_config_update",
            entityType: "system_setting",
            newValues: { services: flagUpdates, modes: modeUpdates, pricing: Object.keys(pricing) },
        }).catch(() => {});

        // Return the fresh snapshot
        const [flags, modes, percents] = await Promise.all([
            getPersonalServiceFlags(),
            getProviderModes(),
            getAllPercentSettings(),
        ]);
        const feeRes = await query(
            `SELECT fee_type, name, config_type, config, currency FROM fee_configurations WHERE fee_type = ANY($1)`,
            [["bill", "esim", "swap", "savings_break"]],
        );
        res.json({
            success: true,
            data: {
                services: PERSONAL_SERVICES.map((s) => ({
                    service: s,
                    enabled: flags[s] !== false,
                    routable: (ROUTED_SERVICES as readonly string[]).includes(s),
                    provider_mode: (modes as any)[s] || null,
                    env_configured: (ROUTED_SERVICES as readonly string[]).includes(s) ? providerConfigured(s as RoutedService) : null,
                })),
                pricing: { ...percents, fees: feeRes.rows.map((r: any) => ({ ...r, config: typeof r.config === "string" ? JSON.parse(r.config) : r.config })) },
            },
        });
    } catch (error: any) {
        res.status(400).json({ success: false, error: error.message || "Failed to save personal products config" });
    }
});

// ---------------------------------------------------------------------------
// PROVIDER ROUTING — the active provider per routed service
// (bills: sogo|flutterwave|simulator · giftcards: sogo|prestmit|simulator ·
//  crypto: sogo|bitnob|simulator). "sogo" is the default for all three.
// ---------------------------------------------------------------------------

router.get("/providers", async (_req, res) => {
    try {
        const { getRoutingStatus } = await import("./provider-routing");
        const status = await getRoutingStatus();
        res.json({ success: true, data: status });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || "Failed to load provider routing" });
    }
});

router.put("/providers", async (req, res) => {
    try {
        const { setActiveProvider, SERVICE_PROVIDERS } = await import("./provider-routing");
        const { service, provider } = req.body || {};
        const svc = String(service || "").toLowerCase();
        const prov = String(provider || "").toLowerCase();
        if (!Object.keys(SERVICE_PROVIDERS).includes(svc)) {
            return res.status(400).json({ success: false, error: `service must be one of: ${Object.keys(SERVICE_PROVIDERS).join(", ")}` });
        }
        if (!(SERVICE_PROVIDERS as any)[svc].includes(prov)) {
            return res.status(400).json({ success: false, error: `${svc} supports providers: ${(SERVICE_PROVIDERS as any)[svc].join(", ")}` });
        }
        await setActiveProvider(svc as any, prov as any);
        await logAuditEvent({
            action: "personal.provider_routing.update",
            entityType: "personal_provider_routing",
            entityId: `service:${svc}`,
            newValues: { service: svc, provider: prov },
        }).catch(() => {});
        const { getRoutingStatus } = await import("./provider-routing");
        const status = await getRoutingStatus();
        return res.json({ success: true, data: status, message: `${svc} now routes to ${prov}` });
    } catch (error: any) {
        return res.status(400).json({ success: false, error: error.message || "Failed to update provider routing" });
    }
});

export default router;
export type { PersonalService };
