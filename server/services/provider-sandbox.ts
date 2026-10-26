/**
 * PROVIDER SANDBOX DETECTION — one source of truth for "is a money provider
 * running against a sandbox/test environment right now?".
 *
 * Why this exists (production incident, Oct 2026): the VPS ran the Sogo BILL
 * provider with sandbox keys in PRODUCTION. Sandbox never delivers real
 * airtime, never sends webhooks and 404s every lookup — customers' wallets
 * were debited for services that could never arrive, and the admin console
 * had NO surface telling the operator about it.
 *
 * The admin dashboard polls GET /admin/providers/sandbox-status (below) and
 * shows a persistent warning banner while ANY active money provider is in
 * sandbox mode.
 */

export type SandboxItem = {
  /** Human service label, e.g. "Collections", "Transfers (payouts)", "Bill payments" */
  service: string;
  provider: string;
  sandbox: boolean;
  /** How we know: which env/setting betrayed the sandbox mode */
  detail: string;
};

function looksSandboxy(value: string | undefined | null): boolean {
  if (!value) return false;
  return /sandbox|sanbox|test|dev-api|staging/i.test(value);
}

/** Flutterwave: legacy test keys embed "-test-"/"SANDBOX"; new-style keys are
 *  opaque, so an explicit FLW_ENV/FLW_BASE_URL is the reliable signal. */
export function isFlutterwaveSandbox(): { sandbox: boolean; detail: string } {
  const key = String(process.env.FLW_SECRET_KEY || "");
  const base = String(process.env.FLW_BASE_URL || "");
  if (/sandbox/i.test(process.env.FLW_ENV || "")) return { sandbox: true, detail: "FLW_ENV=sandbox" };
  if (/test/i.test(process.env.FLW_ENV || "")) return { sandbox: true, detail: "FLW_ENV=test" };
  if (/FLWSECK[-_]?test|FLWPUBK[-_]?test|[-_]SANDBOX|[-_]TEST/i.test(key)) {
    return { sandbox: true, detail: "secret key carries a test/sandbox marker" };
  }
  if (looksSandboxy(base)) return { sandbox: true, detail: `FLW_BASE_URL=${base}` };
  if (!key) return { sandbox: true, detail: "no secret key configured" };
  return { sandbox: false, detail: "live key" };
}

export function isSquadSandbox(): { sandbox: boolean; detail: string } {
  const base = String(process.env.SQUAD_BASE_URL || "");
  if (looksSandboxy(base)) return { sandbox: true, detail: `SQUAD_BASE_URL=${base}` };
  if (looksSandboxy(process.env.SQUAD_SECRET_KEY) && base) return { sandbox: true, detail: "key/base carry a test marker" };
  // Squad default without an explicit prod override is the sandbox host.
  const key = String(process.env.SQUAD_SECRET_KEY || "");
  if (key && !process.env.SQUAD_BASE_URL) return { sandbox: true, detail: "SQUAD_BASE_URL unset (default host is sandbox)" };
  if (!key) return { sandbox: true, detail: "no secret key configured" };
  return { sandbox: false, detail: "live base URL" };
}

export function isMonnifySandbox(): { sandbox: boolean; detail: string } {
  const base = String(process.env.MONNIFY_BASE_URL || "");
  if (looksSandboxy(base) || !base) {
    return { sandbox: true, detail: base ? `MONNIFY_BASE_URL=${base}` : "MONNIFY_BASE_URL unset (defaults to sandbox.monnify.com)" };
  }
  return { sandbox: false, detail: "live base URL" };
}

export function isBitnobSandbox(): { sandbox: boolean; detail: string } {
  if (String(process.env.BITNOB_ENV || "").toLowerCase() === "sandbox") {
    return { sandbox: true, detail: "BITNOB_ENV=sandbox" };
  }
  const base = String(process.env.BITNOB_BASE_URL || "");
  if (looksSandboxy(base)) return { sandbox: true, detail: `BITNOB_BASE_URL=${base}` };
  if (!process.env.BITNOB_SECRET_KEY && !process.env.BITNOB_API_KEY) {
    return { sandbox: true, detail: "no secret key configured" };
  }
  return { sandbox: false, detail: "live base URL" };
}

/** Build the full sandbox report for the CURRENTLY ACTIVE providers only.
 *  Inactive providers are irrelevant — they cannot move money. */
export async function buildSandboxReport(): Promise<{
  anySandbox: boolean;
  items: SandboxItem[];
}> {
  const items: SandboxItem[] = [];

  // 1. Collections + transfers (business gateway: squad | monnify | flutterwave)
  try {
    const factory = await import("./providers/factory");
    const [collections, transfers] = await Promise.all([
      factory.getActiveProviderName(),
      factory.getActiveTransferProviderName(),
    ]);
    const flw = isFlutterwaveSandbox();
    const squad = isSquadSandbox();
    const monnify = isMonnifySandbox();
    const detect = (name: string) =>
      name === "flutterwave" ? flw : name === "squad" ? squad : name === "monnify" ? monnify : { sandbox: false, detail: "unknown" };

    const c = detect(collections);
    items.push({ service: "Collections (card/bank payments)", provider: collections, sandbox: c.sandbox, detail: c.detail });
    if (transfers !== collections) {
      const t = detect(transfers);
      items.push({ service: "Transfers (payouts)", provider: transfers, sandbox: t.sandbox, detail: t.detail });
    } else {
      items.push({ service: "Transfers (payouts)", provider: transfers, sandbox: c.sandbox, detail: `${c.detail} (same gateway as collections)` });
    }
  } catch {
    /* factory import failure must never break the report */
  }

  // 2. Personal routing services (bills / giftcards / crypto)
  try {
    const { getActiveProvider } = await import("../features/personal/provider-routing");
    const sogo = await import("./sogo");
    const prestmit = await import("./prestmit");
    const personal: Array<{ service: string; provider: string }> = [
      { service: "Bill payments", provider: await getActiveProvider("bills") },
      { service: "Gift card trading", provider: await getActiveProvider("giftcards") },
      { service: "Crypto & stablecoins", provider: await getActiveProvider("crypto") },
    ];
    for (const p of personal) {
      if (p.provider === "simulator") {
        items.push({ service: p.service, provider: p.provider, sandbox: true, detail: "simulator — no real fulfilment happens" });
      } else if (p.provider === "sogo") {
        const sandbox = sogo.isSogoSandbox();
        items.push({
          service: p.service,
          provider: p.provider,
          sandbox,
          detail: sandbox ? `sandbox base URL / ${sogo.sogoKeyKind()} key` : "live keys",
        });
      } else if (p.provider === "prestmit") {
        const sandbox = prestmit.isPrestmitSandbox();
        items.push({ service: p.service, provider: p.provider, sandbox, detail: sandbox ? "dev-api base URL / dev key" : "live keys" });
      } else if (p.provider === "bitnob") {
        const b = isBitnobSandbox();
        items.push({ service: p.service, provider: p.provider, sandbox: b.sandbox, detail: b.detail });
      } else if (p.provider === "flutterwave") {
        const f = isFlutterwaveSandbox();
        items.push({ service: p.service, provider: p.provider, sandbox: f.sandbox, detail: f.detail });
      }
    }
  } catch {
    /* provider-routing failure must never break the report */
  }

  return { anySandbox: items.some((i) => i.sandbox), items };
}
