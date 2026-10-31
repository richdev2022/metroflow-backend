/**
 * Provider balance desk — one normalized shape for every fulfilment
 * provider's platform wallet, powering the admin "Provider's Balance"
 * dashboard (list providers → pick one → balance + history).
 *
 * Why this exists: the platform's float is spread across providers.
 *   Flutterwave  → collection float; operators move funds OUT of Flutterwave
 *                  into Sogo / Prestmit (bills + giftcard service operations)
 *                  and into Bitnob (virtual-card + stablecoin operations).
 *   Sogo         → bills / giftcards / RMB service float.
 *   Prestmit     → giftcard trading float (NAIRA + CEDIS wallets).
 *   Bitnob       → virtual-card + stablecoin operations (USDT/USDC/BTC/NGN).
 * Seeing every balance on one screen (with low-balance flags and provider
 * history) makes pre-funding and reconciliation a single-glance operation.
 *
 * Each provider client keeps its native response untouched in `raw`; the
 * normalized view is always:
 *   { provider, label, configured, ok, error, wallets: [{currency,
 *     ledger_balance, available_balance, withdrawable_balance, formatted,
 *     low}], fetched_at }
 *
 * Amounts are normalized to MAJOR units (numbers). Providers that report
 * smallest-unit strings (Bitnob) are converted using their documented minor
 * unit (USDT/USDC: 6dp, BTC: 8dp, NGN: 2dp).
 */

import * as sogo from "./sogo";
import * as prestmit from "./prestmit";
import * as flw from "./flutterwave";
import {
  getBalances as bitnobBalances,
  isBitnobConfigured,
  BitnobApiError,
  BitnobNotConfiguredError,
} from "./providers/bitnob";

function bitnobErr(e: any): string {
  if (e instanceof BitnobNotConfiguredError) return e.message;
  if (e instanceof BitnobApiError) return e.message;
  return e?.response?.data?.message || e?.message || "Bitnob request failed";
}

import { query } from "../db";

export interface ProviderWalletBalance {
  currency: string;
  ledger_balance: number;
  available_balance: number;
  withdrawable_balance: number | null;
  formatted: string;
  /** True when available balance is below the configured low-balance threshold for the currency. */
  low: boolean;
  native: Record<string, unknown>;
}

export interface ProviderBalanceSnapshot {
  provider: string;
  label: string;
  role: string;
  configured: boolean;
  ok: boolean;
  error: string | null;
  wallets: ProviderWalletBalance[];
  fetched_at: string;
}

export interface ProviderMeta {
  key: string;
  label: string;
  role: string;
  configured: boolean;
  /** Short human description of what the float is used for (ops runbook). */
  usage: string;
}

export class ProviderBalanceError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Low-balance thresholds (major units) — admin-tunable via system_settings
// key `provider_low_balance_thresholds` = {"NGN": 100000, "USD": 500, ...}.
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: Record<string, number> = {
  NGN: 100_000,
  USD: 500,
  USDT: 500,
  USDC: 500,
  GHS: 2_000,
  BTC: 0.005,
};

async function thresholds(): Promise<Record<string, number>> {
  try {
    const res = await query(
      `SELECT value FROM system_settings WHERE key = 'provider_low_balance_thresholds' LIMIT 1`,
    );
    const raw = res.rows[0]?.value;
    if (raw) {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object") return { ...DEFAULT_THRESHOLDS, ...parsed };
    }
  } catch {
    /* settings table or JSON may be missing — defaults are fine */
  }
  return DEFAULT_THRESHOLDS;
}

function fmt(currency: string, amount: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
  }
}

function wallet(
  currency: string,
  ledger: number,
  available: number,
  withdrawable: number | null,
  lows: Record<string, number>,
  native: Record<string, unknown> = {},
): ProviderWalletBalance {
  return {
    currency: String(currency || "").toUpperCase(),
    ledger_balance: Number(ledger) || 0,
    available_balance: Number(available) || 0,
    withdrawable_balance: withdrawable == null ? null : Number(withdrawable),
    formatted: fmt(String(currency || "").toUpperCase(), Number(available) || 0),
    low: (Number(available) || 0) <= (lows[String(currency || "").toUpperCase()] ?? Infinity),
    native,
  };
}

// ---------------------------------------------------------------------------
// Per-provider snapshots
// ---------------------------------------------------------------------------

/** Sogo — GET /v1/wallet returns data[] with balance/withdrawable per currency. */
async function sogoSnapshot(lows: Record<string, number>): Promise<ProviderBalanceSnapshot> {
  const base: ProviderBalanceSnapshot = {
    provider: "sogo",
    label: "Sogo",
    role: "Bills · Gift cards · RMB",
    configured: sogo.isSogoConfigured(),
    ok: false,
    error: null,
    wallets: [],
    fetched_at: new Date().toISOString(),
  };
  if (!base.configured) return base;
  try {
    const res: any = await sogo.wallet();
    const rows: any[] = Array.isArray(res?.data) ? res.data : [];
    base.wallets = rows.map((r) =>
      wallet(
        r?.currency,
        Number(r?.balance ?? 0),
        Number(r?.withdrawable_balance ?? r?.balance ?? 0),
        r?.withdrawable_balance != null ? Number(r.withdrawable_balance) : null,
        lows,
        r,
      ),
    );
    base.ok = true;
  } catch (e: any) {
    base.error = e?.response?.data?.message || e?.message || "Sogo wallet unavailable";
  }
  return base;
}

/**
 * Prestmit — walletDetails() for the NAIRA and CEDIS fiat wallets. The
 * partner API returns its own envelope; normalize defensively across the
 * known shapes (data.balance / data.available_balance / wallet.balance).
 */
async function prestmitSnapshot(lows: Record<string, number>): Promise<ProviderBalanceSnapshot> {
  const base: ProviderBalanceSnapshot = {
    provider: "prestmit",
    label: "Prestmit",
    role: "Gift card trading (NAIRA/CEDIS float)",
    configured: prestmit.isPrestmitConfigured(),
    ok: false,
    error: null,
    wallets: [],
    fetched_at: new Date().toISOString(),
  };
  if (!base.configured) return base;
  const pull = async (w: "NAIRA" | "CEDIS") => {
    try {
      const res: any = await prestmit.walletDetails(w);
      const d = res?.data ?? res ?? {};
      const ledger = Number(d?.balance ?? d?.ledger_balance ?? d?.wallet_balance ?? 0);
      const available = Number(d?.available_balance ?? d?.balance ?? ledger);
      if (!ledger && !available) return null;
      return wallet(w === "NAIRA" ? "NGN" : "GHS", ledger, available, available, lows, d);
    } catch (e: any) {
      if (w === "NAIRA") base.error = prestmit.prestmitErr(e);
      return null;
    }
  };
  const [naira, cedis] = await Promise.all([pull("NAIRA"), pull("CEDIS")]);
  base.wallets = [naira, cedis].filter(Boolean) as ProviderWalletBalance[];
  base.ok = base.wallets.length > 0;
  return base;
}

/** Flutterwave — GET /v3/balances returns data[] with available/ledger per currency. */
async function flutterwaveSnapshot(lows: Record<string, number>): Promise<ProviderBalanceSnapshot> {
  const base: ProviderBalanceSnapshot = {
    provider: "flutterwave",
    label: "Flutterwave",
    role: "Collections float (funds Sogo/Prestmit/Bitnob)",
    configured: flw.isFlutterwaveConfigured(),
    ok: false,
    error: null,
    wallets: [],
    fetched_at: new Date().toISOString(),
  };
  if (!base.configured) return base;
  try {
    const res: any = await flw.getBalances();
    const rows: any[] = Array.isArray(res?.data) ? res.data : [];
    base.wallets = rows.map((r) =>
      wallet(
        r?.currency,
        Number(r?.ledger_balance ?? r?.available_balance ?? 0),
        Number(r?.available_balance ?? 0),
        r?.available_balance != null ? Number(r.available_balance) : null,
        lows,
        r,
      ),
    );
    base.ok = true;
  } catch (e: any) {
    base.error = flw.flwErr(e);
  }
  return base;
}

/**
 * Bitnob — GET /api/balances returns accounts[] with ledger/available as
 * integer strings in the smallest unit (USDT/USDC 6dp, BTC 8dp, NGN 2dp).
 */
const BITNOB_MINOR: Record<string, number> = { USDT: 1e6, USDC: 1e6, BTC: 1e8, NGN: 100, USD: 100 };

function bitnobMajor(currency: string, smallest: unknown): number {
  const n = Number(smallest);
  if (!Number.isFinite(n)) return 0;
  return n / (BITNOB_MINOR[String(currency).toUpperCase()] ?? 1);
}

async function bitnobSnapshot(lows: Record<string, number>): Promise<ProviderBalanceSnapshot> {
  const base: ProviderBalanceSnapshot = {
    provider: "bitnob",
    label: "Bitnob",
    role: "Virtual cards · Stablecoin operations",
    configured: isBitnobConfigured(),
    ok: false,
    error: null,
    wallets: [],
    fetched_at: new Date().toISOString(),
  };
  if (!base.configured) return base;
  try {
    const res: any = await bitnobBalances();
    const accounts: any[] = res?.data?.accounts || [];
    base.wallets = accounts.map((a) => {
      const cur = String(a?.currency || "").toUpperCase();
      const ledger = bitnobMajor(cur, a?.ledger_balance);
      const available = bitnobMajor(cur, a?.available_balance);
      return wallet(cur, ledger, available, available, lows, {
        account_number: a?.account_number,
        ledger_balance_formatted: a?.ledger_balance_formatted,
        available_balance_formatted: a?.available_balance_formatted,
      });
    });
    base.ok = true;
  } catch (e: any) {
    base.error = bitnobErr(e);
  }
  return base;
}

const SNAPSHOTS: Record<string, (lows: Record<string, number>) => Promise<ProviderBalanceSnapshot>> = {
  sogo: sogoSnapshot,
  prestmit: prestmitSnapshot,
  flutterwave: flutterwaveSnapshot,
  bitnob: bitnobSnapshot,
};

export const PROVIDER_KEYS = Object.keys(SNAPSHOTS);

/** Metadata for the provider list view (configured flags resolved lazily). */
export async function listProviders(): Promise<ProviderMeta[]> {
  const checks: Record<string, boolean> = {
    sogo: sogo.isSogoConfigured(),
    prestmit: prestmit.isPrestmitConfigured(),
    flutterwave: flw.isFlutterwaveConfigured(),
    bitnob: isBitnobConfigured(),
  };
  const roles: Record<string, string> = {
    sogo: "Bills · Gift cards · RMB",
    prestmit: "Gift card trading (NAIRA/CEDIS float)",
    flutterwave: "Collections float (funds Sogo/Prestmit/Bitnob)",
    bitnob: "Virtual cards · Stablecoin operations",
  };
  const labels: Record<string, string> = {
    sogo: "Sogo",
    prestmit: "Prestmit",
    flutterwave: "Flutterwave",
    bitnob: "Bitnob",
  };
  return PROVIDER_KEYS.map((key) => ({
    key,
    label: labels[key] || key,
    role: roles[key] || "",
    configured: !!checks[key],
    usage:
      key === "flutterwave"
        ? "Primary collection float. Top-ups land here; ops sweep to Sogo/Prestmit for service operations and to Bitnob for virtual cards + stablecoin."
        : key === "sogo"
          ? "Service operations float for bills, gift cards and RMB purchases."
          : key === "prestmit"
            ? "Gift card trading float — NAIRA payouts and CEDIS settlements."
            : "Virtual card issuance/funding and USDT stablecoin operations.",
  }));
}

/** One provider's normalized balance snapshot (never throws — errors ride on the payload). */
export async function getProviderBalance(provider: string): Promise<ProviderBalanceSnapshot> {
  const key = String(provider || "").toLowerCase();
  const fn = SNAPSHOTS[key];
  if (!fn) throw new ProviderBalanceError(`Unknown provider '${provider}'. Known: ${PROVIDER_KEYS.join(", ")}`, 404);
  return fn(await thresholds());
}

/** Every provider at once — the dashboard's "all balances" refresh button. */
export async function getAllProviderBalances(): Promise<{
  providers: ProviderBalanceSnapshot[];
  any_low: ProviderWalletBalance[];
  fetched_at: string;
}> {
  const lows = await thresholds();
  const providers = await Promise.all(
    PROVIDER_KEYS.map((k) =>
      SNAPSHOTS[k](lows).catch((e: any) => ({
        provider: k,
        label: k,
        role: "",
        configured: false,
        ok: false,
        error: e?.message || "snapshot failed",
        wallets: [] as ProviderWalletBalance[],
        fetched_at: new Date().toISOString(),
      })),
    ),
  );
  const any_low = providers.flatMap((p) => p.wallets.filter((w) => w.low).map((w) => ({ ...w, provider: p.provider })));
  return { providers, any_low, fetched_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// History — provider-native transaction listing for reconciliation.
// Shapes are returned provider-native (envelope trimmed) because the admin
// table renders whatever columns the provider exposes.
// ---------------------------------------------------------------------------

export async function getProviderHistory(
  provider: string,
  params: { page?: number; currency?: string; from?: string; to?: string; status?: string; type?: string } = {},
): Promise<{ provider: string; items: any[]; meta: Record<string, unknown> }> {
  const key = String(provider || "").toLowerCase();
  const page = Math.max(1, Number(params.page) || 1);
  if (key === "sogo") {
    const res: any = await sogo.transactions({
      page,
      per_page: 50,
      currency: params.currency,
      from: params.from,
      to: params.to,
      status: params.status,
      type: params.type,
    });
    const data: any[] = Array.isArray(res?.data) ? res.data : [];
    return { provider: key, items: data, meta: { meta: res?.meta ?? null, links: res?.links ?? null } };
  }
  if (key === "flutterwave") {
    const res: any = await flw.getBalanceHistory({
      currency: params.currency || "NGN",
      page,
      from: params.from,
      to: params.to,
    });
    const data = res?.data;
    const items: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.balance_history)
        ? data.balance_history
        : Array.isArray(data?.data)
          ? data.data
          : [];
    return { provider: key, items, meta: { meta: res?.meta ?? null } };
  }
  if (key === "prestmit") {
    const withdrawals = await prestmit.withdrawalHistory(page).catch((e) => ({ error: prestmit.prestmitErr(e) }));
    const sell = await prestmit.sellHistory({ page }).catch((e) => ({ error: prestmit.prestmitErr(e) }));
    const buy = await prestmit.buyHistory({ page }).catch((e) => ({ error: prestmit.prestmitErr(e) }));
    return {
      provider: key,
      items: [
        ...((withdrawals as any)?.data ?? []),
        ...((sell as any)?.data ?? []),
        ...((buy as any)?.data ?? []),
      ],
      meta: { withdrawals, sell, buy },
    };
  }
  if (key === "bitnob") {
    // Bitnob card transaction feed doubles as the float history for card ops;
    // payouts/trades history is available per-card. Until a global endpoint is
    // exposed, surface the recent card transactions across the platform's cards.
    const res = await query(
      `SELECT provider_txn_id, type, amount, fee, currency, status, description, reference, created_at
         FROM virtual_card_transactions
        WHERE provider_txn_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 100`,
    ).catch(() => ({ rows: [] as any[] }));
    const items = (res as any).rows || [];
    return { provider: key, items, meta: { source: "virtual_card_transactions (local mirror)" } };
  }
  throw new ProviderBalanceError(`Unknown provider '${provider}'. Known: ${PROVIDER_KEYS.join(", ")}`, 404);
}
