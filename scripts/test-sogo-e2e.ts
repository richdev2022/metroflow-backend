/**
 * SOGO END-TO-END TEST BATTERY — runs against the REAL Sogo sandbox
 * (sandbox.sogo.africa) using the service layer exactly as production does.
 *
 * Usage:  SOGO_SECRET_KEY=sogo_sk_test_xxx npx tsx scripts/test-sogo-e2e.ts
 *
 * Sandbox constraints handled here:
 *   - 10 requests/min per key → every call is paced (7.5s gap) with 429 retry.
 *   - Transactions are NOT persisted (GET /transactions/{ref} 404s) — purchase
 *     responses are the source of truth; outcomes are keyed on the published
 *     test identifiers (…1234 → completed, …0000 → refunded, …9999 → stuck).
 *   - Wallet balance is fixed at NGN 1,000,000.
 *
 * Exit code 0 = every case PASSED.
 */
import * as sogo from "../server/services/sogo";

const results: Array<{ name: string; ok: boolean; detail: string; ms: number }> = [];
const PACING_MS = 7_500; // < 10 req/min
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

async function paced<T>(name: string, fn: () => Promise<T>, validate: (res: T) => string | null): Promise<T> {
  const gap = Date.now() - lastCallAt;
  if (gap < PACING_MS) await sleep(PACING_MS - gap);
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fn();
      lastCallAt = Date.now();
      const problem = validate(res);
      results.push({ name, ok: !problem, detail: problem || "ok", ms: Date.now() - started });
      if (problem) console.log(`✗ ${name} — ${problem}`);
      else console.log(`✓ ${name} (${Date.now() - started}ms)`);
      return res;
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 429 && attempt < 4) {
        console.log(`… ${name} rate-limited, backing off 35s (attempt ${attempt})`);
        await sleep(35_000);
        continue;
      }
      lastCallAt = Date.now();
      const msg = sogo.sogoErr(e);
      results.push({ name, ok: false, detail: msg, ms: Date.now() - started });
      console.log(`✗ ${name} — ${msg}`);
      throw e;
    }
  }
}

const expectTruthy = (label: string) => (res: any) => (res ? null : `${label}: empty response`);

async function main() {
  if (!sogo.isSogoConfigured()) {
    console.error("SOGO_SECRET_KEY is not set — export it and re-run.");
    process.exit(2);
  }
  const info = sogo.sandboxInfo();
  console.log(`\n=== SOGO E2E — base=${info.base_url} kind=${info.key_kind} ===\n`);
  if (info.key_kind !== "sandbox") {
    console.error("SAFETY: refusing to run the purchase battery against a NON-sandbox key.");
    process.exit(2);
  }

  let dataPlans: any[] = [];
  let educationPlans: any[] = [];

  // ---------------- CRYPTO ----------------
  const assets = await paced("crypto/assets", () => sogo.cryptoAssets(), (r) =>
    Array.isArray(r) && r.length >= 10 ? null : `expected 10+ assets, got ${Array.isArray(r) ? r.length : typeof r}`);
  const usdt = assets.find((a: any) => a.symbol === "usdt");
  console.log(`   usdt networks: ${usdt?.networks?.join(", ")} (default ${usdt?.default_network})`);

  const rate = await paced("crypto/rate usdt x100", () => sogo.cryptoRate("usdt", 100), (r) =>
    Number(r?.rate ?? r?.estimated_amount_ngn ?? r?.net_amount ?? 0) > 0 ? null : `no rate in response: ${JSON.stringify(r).slice(0, 200)}`);
  console.log(`   usdt 100 → NGN ${JSON.stringify(rate).slice(0, 160)}`);

  await paced("crypto/deposit-address GET (none)", () => sogo.cryptoGetDepositAddress("usdt", "trc20"), () => null);

  const addr = await paced("crypto/deposit-address POST", () =>
    sogo.cryptoCreateDepositAddress("usdt", "trc20", `MFADDR${Date.now()}`), (r) =>
    (r?.address || r?.deposit_address) ? null : `no address: ${JSON.stringify(r).slice(0, 240)}`);
  const address = addr?.address || addr?.deposit_address;
  console.log(`   address: ${String(address).slice(0, 24)}…`);

  const testDep = await paced("crypto/test-deposit (DEP-…1234 → completed)", () =>
    sogo.cryptoTestDeposit({ asset: "usdt", network: "trc20", crypto_amount: 10, test_reference: `MF-DEP-TX-${Date.now().toString().slice(-4)}1234` }), (r) =>
    (r?.status || r?.transaction?.status) ? null : `no transaction in response: ${JSON.stringify(r).slice(0, 240)}`);
  console.log(`   status: ${testDep?.transaction?.status || testDep?.status}`);

  // ---------------- BILLS ----------------
  const catalog = await paced("bills/catalog", () => sogo.billsCatalog(), (r) =>
    Array.isArray(r) && r.length >= 5 ? null : `expected 5+ categories, got ${Array.isArray(r) ? r.length : typeof r}`);
  console.log(`   categories: ${catalog.map((c: any) => c.type).join(", ")}`);

  dataPlans = await paced("bills/data-plans?network=mtn", () => sogo.billsDataPlans("mtn"), (r) =>
    Array.isArray(r) && r.length > 0 ? null : `no plans: ${JSON.stringify(r).slice(0, 160)}`);
  console.log(`   mtn plans: ${dataPlans.length} (first: ${JSON.stringify(dataPlans[0]).slice(0, 120)})`);

  const cablePackages = await paced("bills/cable-packages?provider=dstv", () => sogo.billsCablePackages("dstv"), (r) =>
    Array.isArray(r) && r.length > 0 ? null : `no packages: ${JSON.stringify(r).slice(0, 160)}`);
  console.log(`   dstv packages: ${cablePackages.length} (first: ${JSON.stringify(cablePackages[0]).slice(0, 120)})`);

  educationPlans = await paced("bills/education-plans", () => sogo.billsEducationPlans(), (r) =>
    Array.isArray(r) && r.length > 0 ? null : `no plans: ${JSON.stringify(r).slice(0, 160)}`);
  console.log(`   education plans: ${educationPlans.length} (first: ${JSON.stringify(educationPlans[0]).slice(0, 120)})`);

  try {
    const discounts = await paced("bills/discount-rates", () => sogo.billsDiscountRates(), (r) =>
      r ? null : "empty discounts");
    console.log(`   discounts: ${JSON.stringify(discounts).slice(0, 140)}`);
  } catch {
    // Provider-side gap (sandbox 500s this endpoint) — tolerated: the router
    // degrades gracefully and the hub stays functional.
    console.log("⚠ bills/discount-rates — provider-side 500, tolerated (router degrades gracefully)");
  }

  await paced("bills/epin-stock", () => sogo.billsEpinStock(), expectTruthy("epin stock"));

  const meter = await paced("bills/verify-meter (12345671234 @ ikedc)", () =>
    sogo.verifyElectricityMeter("ikedc", "12345671234", "prepaid"), (r) =>
    JSON.stringify(r).toLowerCase().includes("customer") || JSON.stringify(r).toLowerCase().includes("name") ? null : `unexpected: ${JSON.stringify(r).slice(0, 240)}`);
  console.log(`   meter customer: ${JSON.stringify(meter).slice(0, 140)}`);

  await paced("bills/verify-smartcard (10001234 @ dstv)", () =>
    sogo.verifyCableSmartcard("dstv", "10001234"), (r) => (r ? null : "empty"));
  await paced("bills/verify-jamb (1234567890 + jamb plan code)", () =>
    sogo.verifyJambProfile("1234567890", String(educationPlans[0]?.variation_code || educationPlans[0]?.code || "sbx_jamb_utme")), (r) => (r ? null : "empty"));
  await paced("bills/verify-betting (bet9ja 12341234)", () =>
    sogo.verifyBettingAccount("bet9ja", "12341234"), (r) => (r ? null : "empty"));

  const airtime = await paced("bills/airtime (airtel 09012341234 ₦500)", () =>
    sogo.buyAirtime({ network: "airtel", phone: "09012341234", amount: 500, reference: `MFBILL${Date.now()}1234` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });
  console.log(`   airtime ref: ${airtime?.transaction?.reference || airtime?.reference}`);

  const plan = dataPlans.find((p: any) => Number(p.amount ?? p.price ?? 0) > 0) || dataPlans[0];
  const variation = plan?.variation_code || plan?.variationCode || plan?.code;
  const planPrice = Number(plan?.amount ?? plan?.price ?? 0);
  await paced("bills/data (mtn first plan)", () =>
    sogo.buyData({ network: "mtn", phone: "09012341234", variation_code: String(variation), ported: true, reference: `MFBILL${Date.now()}1234` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });

  await paced("bills/electricity (ikedc 12345671234 prepaid ₦1000)", () =>
    sogo.payElectricity({ disco_slug: "ikedc", meter_number: "12345671234", meter_type: "prepaid", amount: 1000, reference: `MFBILL${Date.now()}1234` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });

  const cablePkg = cablePackages.find((p: any) => Number(p.amount ?? p.price ?? 0) > 0) || cablePackages[0];
  const cableVariation = cablePkg?.variation_code || cablePkg?.variationCode || cablePkg?.code;
  await paced("bills/cable-tv (dstv 10001234 renew)", () =>
    sogo.payCableTv({ provider: "dstv", smartcard_number: "10001234", subscription_type: "renew", variation_code: String(cableVariation), amount: Number(cablePkg?.amount ?? cablePkg?.price ?? 1000), reference: `MFBILL${Date.now()}1234` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });

  const jambPlan = educationPlans.find((p: any) => Number(p.amount ?? p.price ?? 0) > 0) || educationPlans[0];
  const jambVariation = jambPlan?.variation_code || jambPlan?.variationCode || jambPlan?.code;
  await paced("bills/education (jamb 12341234)", () =>
    sogo.payEducation({ provider: "jamb", variation_code: String(jambVariation), amount: Number(jambPlan?.amount ?? jambPlan?.price ?? 1000), profile_id: "1234567890", reference: `MFBILL${Date.now()}1234` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });

  const epin = await paced("bills/epin (mtn ₦100 ×1 pack)", () =>
    sogo.buyEpin({ network: "mtn", denomination: 100, quantity: 1, reference: `MFBILL${Date.now()}1234` }), (r) => {
    const body = JSON.stringify(r);
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) || body.includes("epin") || body.includes("card") ? null : `status=${status || "?"}: ${body.slice(0, 240)}`;
  });
  console.log(`   epin: ${JSON.stringify(epin).slice(0, 200)}`);

  await paced("bills/bet-funding (bet9ja 12341234 ₦500)", () =>
    sogo.fundBetting({ provider: "bet9ja", account_id: "12341234", amount: 500, reference: `MFBILL${Date.now()}1234` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });

  // Refund path: phone ending 0000 → refunded webhook (response 201 processing/refunded)
  const refunded = await paced("bills/airtime *0000 → refunded", () =>
    sogo.buyAirtime({ network: "airtel", phone: "09012340000", amount: 100, reference: `MFBILL${Date.now()}0000` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["refunded", "processing", "failed", "completed"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });
  console.log(`   *0000 status: ${sogo.sogoStatus(refunded?.transaction || refunded)}`);

  // ---------------- GIFT CARDS BUY ----------------
  const gcCountries = await paced("giftcards/buy/countries", () => sogo.giftcardBuyCountries(), (r) =>
    Array.isArray(r) && r.length > 50 ? null : `expected 50+ countries, got ${Array.isArray(r) ? r.length : typeof r}`);

  const products = await paced("giftcards/buy/products?country_code=US", () =>
    sogo.giftcardBuyProducts({ country_code: "US" }), (r) =>
    Array.isArray(r) && r.length > 0 ? null : `no products: ${JSON.stringify(r).slice(0, 200)}`);
  const target = products.find((p: any) => p.denomination_type === "RANGE" && Number(p.min_recipient_denomination) >= 5) || products[0];
  console.log(`   target product: ${target?.product_name} (${target?.product_id}) ${target?.denomination_type} [${target?.min_recipient_denomination ?? target?.fixed_recipient_denominations?.[0]}–${target?.max_recipient_denomination ?? target?.fixed_recipient_denominations?.slice(-1)?.[0]}] ${target?.currency_code}`);

  const amount = Number(target.denomination_type === "RANGE" ? Math.max(5, Number(target.min_recipient_denomination)) : target.fixed_recipient_denominations[0]);
  const calc = await paced("giftcards/buy/calculate", () =>
    sogo.giftcardBuyCalculate(target.product_id, amount, 1), (r) =>
    Number(r?.total_price_ngn ?? 0) > 0 ? null : `no total_price_ngn: ${JSON.stringify(r).slice(0, 240)}`);
  console.log(`   ¥${amount} → ₦${calc.total_price_ngn} (unit ${calc.exact_unit_price_ngn ?? calc.unit_price_ngn})`);

  // expected_amount_ngn ending 1234 → completed (webhook). Use the real total
  // rounded to .1234 to trigger the completed path deterministically.
  const total = Math.max(1, Math.floor(Number(calc.total_price_ngn)));
  const expectedWith1234 = Number(`${total - (total % 10000) + 1234}`);
  const buy = await paced("giftcards/buy (expected …1234 → completed)", () =>
    sogo.giftcardBuy({ product_id: target.product_id, amount, quantity: 1, expected_amount_ngn: expectedWith1234, reference: `MFGCB${Date.now()}` }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["completed", "processing"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });
  console.log(`   buy status: ${sogo.sogoStatus(buy?.transaction || buy)} ref: ${sogo.sogoReference(buy)}`);

  // ---------------- GIFT CARDS SELL ----------------
  const sellCatalog = await paced("giftcards/sell/catalog", () => sogo.giftcardSellCatalog(), (r) =>
    Array.isArray(r) && r.length > 0 ? null : `no brands: ${JSON.stringify(r).slice(0, 200)}`);
  const amazon = sellCatalog.find((b: any) => b.slug === "amazon") || sellCatalog[0];
  console.log(`   amazon: countries=${amazon?.countries?.map((c: any) => c.code).join("/")} types=${amazon?.card_types?.join("/")} min=${amazon?.min_amount} max=${amazon?.max_amount}`);

  await paced("giftcards/sell/rates?slug=amazon", () => sogo.giftcardSellRates("amazon"), (r) =>
    (Array.isArray(r) ? r[0]?.rates : r?.rates) ? null : `no rates: ${JSON.stringify(r).slice(0, 200)}`);

  // Sandbox e-code formats (docs): Apple X+15, Amazon AQ+13, Xbox 25 chars,
  // Steam 15 chars, PlayStation 12 chars, generic GIFTUSA+1234. Outcome keyed
  // on the last 4 chars → 1234 = completed webhook.
  const ecodeBrands = sellCatalog.filter((b: any) => (b.card_types || []).includes("ecode"));
  const brand = ecodeBrands.find((b: any) => ["apple", "steam", "xbox", "playstation"].includes(b.slug)) || ecodeBrands[0] || sellCatalog[0];
  const ECODE_BY_SLUG: Record<string, string> = {
    apple: "XJW8Y3N4K9P21234",
    amazon: "AQ8BNC7X2P1234",
    xbox: "F4G9K2P7M3X8Y1Z5W6N2C1234",
    steam: "8K2P9M4G7X51234",
    playstation: "9M4G7X5Y1234",
  };
  const ecode = ECODE_BY_SLUG[brand.slug] || "GIFTUSA1234";
  const sellCountry = brand?.countries?.[0] || { code: "US", currency: "USD" };
  const sellMin = Math.max(Number(brand.min_amount || 10), 10);
  const sell = await paced(`giftcards/sell (${brand.slug} ecode ${ecode.slice(0, 10)}…1234)`, () =>
    sogo.giftcardSell({
      slug: brand.slug, card_country: sellCountry.code, card_type: "ecode",
      card_currency: sellCountry.currency, card_amount: sellMin,
      additional_info: ecode, payout_currency: "NGN", reference: `MFGCS${Date.now()}`,
    }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["pending", "completed"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });
  console.log(`   sell status: ${sogo.sogoStatus(sell?.transaction || sell)}`);

  // ---------------- RMB ----------------
  const rmbRates = await paced("rmb/buy/rates", () => sogo.rmbRates(), (r) =>
    Array.isArray(r?.channels) && r.channels.length >= 2 ? null : `expected 2+ channels: ${JSON.stringify(r).slice(0, 200)}`);
  console.log(`   channels: ${rmbRates.channels.map((c: any) => c.channel).join(", ")}`);

  // 1x1 white PNG (smallest valid image) as the recipient QR for the test.
  const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const rmb = await paced("rmb/buy (alipay recipient1234 ¥100)", () =>
    sogo.rmbBuy({
      channel: "alipay", alipay_account_type: "nigerian", rmb_amount: 100,
      recipient_name: "Zhang Wei", recipient_identifier: "recipient1234",
      description: "MetriCorex E2E test order", qr_code: { buffer: PNG_1PX, filename: "qr.png", contentType: "image/png" },
      reference: `MFRMB${Date.now()}`,
    }), (r) => {
    const status = sogo.sogoStatus(r?.transaction || r);
    return ["processing", "completed", "pending"].includes(status) ? null : `status=${status || "?"}: ${JSON.stringify(r).slice(0, 240)}`;
  });
  console.log(`   rmb status: ${sogo.sogoStatus(rmb?.transaction || rmb)}`);

  // ---------------- SUMMARY ----------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASSED ===`);
  for (const f of failed) console.log(`FAIL: ${f.name} — ${f.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nE2E battery crashed:", e?.message);
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) console.log(`FAIL: ${f.name} — ${f.detail}`);
  process.exit(1);
});
