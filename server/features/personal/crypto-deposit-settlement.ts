import { query, pool } from "../../db";
import { createNotification } from "../../services/notifications";
import * as sogo from "../../services/sogo";
import { getPercent } from "./flags";

/**
 * CRYPTO DEPOSIT SETTLEMENT ENGINE — the money-safe counterpart of
 * bill-settlement.ts for Sogo on-chain deposits (Crypto-to-Cash).
 *
 * A deposit claim left 'processing' means the customer sent (or claims to
 * have sent) crypto to the shared Sogo deposit address, but the NGN credit
 * never landed. Causes: a missed/undelivered webhook, a process death before
 * settlement, or a customer who never actually sent the transfer.
 *
 * Every path is idempotent:
 *   - the wallet credit is ledger-keyed (`SOGO-DEP-<reference>`) — the balance
 *     is incremented ONLY when the ledger row is freshly inserted, so a
 *     webhook replay or poller retry can never double-credit;
 *   - the sales row is completed with a guarded UPDATE (status <> 'completed').
 *
 * Consumers:
 *   - the signed Sogo webhook (personal-webhooks.ts → handleSogoDepositEvent)
 *   - the 5-minute reconciliation poller (server/index.ts cron →
 *     reconcilePendingCryptoDeposits) which ASKS the provider —
 *     GET /v1/transactions/{reference} and the deposit-hash lookup — so a
 *     missed webhook can no longer strand a funded deposit forever.
 */

const MIN_POLL_AGE_MINUTES = Number(process.env.CRYPTO_DEPOSIT_POLL_AGE_MINUTES || 5);
const EXPIRE_AFTER_HOURS = Number(process.env.CRYPTO_DEPOSIT_EXPIRE_HOURS || 24);

let schemaReady = false;
async function ensureSettlementSchema(): Promise<void> {
  if (schemaReady) return;
  // Sogo's own transaction reference, captured at settlement time so the
  // poller and webhook can independently reconfirm via GET /transactions/{ref}.
  await query(`ALTER TABLE crypto_deposit_sales ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(100)`);
  await query(`ALTER TABLE crypto_deposit_sales ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
  schemaReady = true;
}

function grossFromTx(tx: any, fallback = 0): number {
  return (
    sogo.sogoAmount(tx?.payout_amount) ||
    sogo.sogoAmount(tx?.net_amount) ||
    sogo.sogoAmount(tx?.amount) ||
    fallback
  );
}

/**
 * Idempotently settle a deposit sale from a provider transaction object.
 * Returns true when THIS call moved the money (fresh claim + fresh credit).
 */
export async function settleSogoDeposit(
  sale: any,
  tx: any,
): Promise<{ settled: boolean; net: number }> {
  await ensureSettlementSchema();
  if (!sale || String(sale.status) === "completed") return { settled: false, net: 0 };

  const gross = grossFromTx(tx, Number(sale.ngn_gross || 0));
  if (!(gross > 0)) {
    console.warn(`[crypto-settlement] ${sale.reference}: provider event carries no NGN amount — not crediting`);
    return { settled: false, net: 0 };
  }
  const spreadPct = await getPercent("crypto_spread_percent", 1);
  const fee = Math.round(gross * (spreadPct / 100) * 100) / 100;
  const net = Math.max(0, Math.round((gross - fee) * 100) / 100);

  // ---- Ledger-keyed credit (crash-safe against replays) ------------------
  const creditRef = `SOGO-DEP-${sale.reference}`;
  const existing = await query(
    `SELECT 1 FROM transactions WHERE reference = $1 AND type = 'credit' LIMIT 1`,
    [creditRef],
  );
  if (!existing.rows.length) {
    // ATOMIC: the unique ledger reference is the FIRST write and the balance
    // update commits in the SAME transaction — a crash between "ledger row"
    // and "balance update" can no longer record money the wallet never
    // received (a replay would then hit the unique guard and skip forever).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO transactions
           (user_id, amount, currency, status, reference, type, description,
            transaction_type, wallet_id, direction, payment_provider)
         VALUES ($1,$2,'NGN','success',$3,'credit',$4,'sogo_credit',$5,'credit',$6)`,
        [sale.user_id ?? null, net, creditRef,
         `Crypto deposit credit — ${sale.asset || ""} ${sale.crypto_amount || ""}`.trim(),
         sale.wallet_id ?? null, "sogo"],
      );
      if (sale.wallet_id && net > 0) {
        await client.query(
          `UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [net, sale.wallet_id],
        );
      }
      await client.query("COMMIT");
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      if (e?.code !== "23505") throw e; // unique violation = already credited by a racing worker
    } finally {
      client.release();
    }
  }

  // ---- Guarded status claim ----------------------------------------------
  const upd = await query(
    `UPDATE crypto_deposit_sales
        SET status = 'completed', ngn_gross = $2, fee = $3, ngn_net = $4,
            rate = COALESCE($5, rate), provider_reference = COALESCE($6, provider_reference),
            provider_response = $7::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status <> 'completed'
      RETURNING id`,
    [sale.id, gross, fee, net, tx?.rate ?? null,
     String(tx?.reference || "") || null, JSON.stringify(tx)],
  );

  // Close the matching stablecoin-hub claim so both surfaces show "credited".
  const depositHash = String(
    tx?.metadata?.deposit_tx_hash || tx?.deposit_tx_hash || sale.tx_hash || "",
  ).trim();
  if (depositHash) {
    await query(
      `UPDATE stablecoin_deposits SET status = 'credited', credited_at = CURRENT_TIMESTAMP
        WHERE tx_hash = $1 AND status IN ('pending', 'processing')`,
      [depositHash],
    ).catch(() => {});
  }

  if (upd.rows.length) {
    try {
      await createNotification({
        businessId: "",
        userId: String(sale.user_id),
        type: "credit",
        title: "Crypto deposit settled",
        message: `₦${net.toLocaleString()} has been credited to your wallet from your ${sale.asset || "crypto"} deposit.`,
        actionUrl: "/crypto",
        actionType: "view_transaction",
        metadata: { reference: sale.reference },
        isActionable: false,
        expiresInHours: 720,
      });
    } catch { /* best effort */ }
    return { settled: true, net };
  }
  return { settled: false, net };
}

/**
 * Independent provider verification: GET /v1/transactions/{reference}.
 * Returns the normalized transaction, or null when the API has no record /
 * is unreachable (callers then trust the signed webhook, like bills do).
 */
export async function reconfirmSogoDeposit(
  sogoRef: string,
): Promise<any | null> {
  try {
    const tx = await sogo.getTransaction(String(sogoRef), 12_000);
    return tx || null;
  } catch (e: any) {
    console.warn(`[crypto-settlement] reconfirm ${sogoRef} failed:`, e?.message);
    return null;
  }
}

/** Normalize a Sogo status object/string to our vocabulary. */
function remoteStatus(tx: any): string {
  return sogo.normalizeSogoStatus(sogo.sogoStatus(tx));
}

/**
 * Full deposit-event pipeline (used by the signed webhook).
 * Matching order: our reference → pre-claimed tx_hash → deposit address →
 * resolve owner from the address book / pending stablecoin claim.
 * Returns how the event was dispositioned.
 */
export async function handleSogoDepositEvent(tx: any): Promise<"settled" | "ignored" | "held"> {
  const depositHash = String(
    tx?.metadata?.deposit_tx_hash || tx?.deposit_tx_hash || tx?.hash || "",
  ).trim();
  const address = String(tx?.metadata?.deposit_address || tx?.deposit_address || tx?.address || "");
  let sale: any = null;

  if (tx?.reference) {
    const byRef = await query(`SELECT * FROM crypto_deposit_sales WHERE reference = $1 LIMIT 1`, [String(tx.reference)]);
    sale = byRef.rows[0] || null;
  }
  if (!sale && depositHash) {
    // The customer claimed this deposit by submitting their on-chain tx hash.
    const byHash = await query(
      `SELECT * FROM crypto_deposit_sales WHERE tx_hash = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [depositHash],
    );
    sale = byHash.rows[0] || null;
  }
  if (!sale && address) {
    const byAddr = await query(
      `SELECT * FROM crypto_deposit_sales WHERE address = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [address],
    );
    sale = byAddr.rows[0] || null;
  }
  if (!sale && (address || depositHash)) {
    // First deposit on a known address — resolve the owner and open a row.
    let owner: any = null;
    if (address) {
      const addr = await query(`SELECT * FROM crypto_deposit_addresses WHERE address = $1 LIMIT 1`, [address]);
      owner = addr.rows[0] || null;
    }
    if (!owner && depositHash) {
      const claim = await query(
        `SELECT * FROM stablecoin_deposits WHERE tx_hash = $1 AND status = 'pending' AND user_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [depositHash],
      );
      if (claim.rows.length) {
        owner = { user_id: claim.rows[0].user_id, asset: claim.rows[0].currency, network: claim.rows[0].chain };
      }
    }
    if (!owner) {
      console.warn("[crypto-settlement] deposit for unknown address/hash:", address || depositHash);
      return "ignored";
    }
    const wallet = await query(
      `SELECT id FROM wallets WHERE user_id = $1 AND business_id IS NULL AND UPPER(currency) = 'NGN' AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
      [owner.user_id],
    );
    const insert = await query(
      `INSERT INTO crypto_deposit_sales
         (user_id, wallet_id, address, reference, provider, asset, network, crypto_amount, status, provider_response, tx_hash)
       VALUES ($1,$2,$3,$4,'sogo',$5,$6,$7,'processing',$8::jsonb,$9)
       ON CONFLICT (reference) DO NOTHING RETURNING *`,
      [owner.user_id, wallet.rows[0]?.id || null, address || null,
       String(tx.reference || `SO-${Date.now()}`),
       owner.asset, owner.network,
       sogo.sogoAmount(tx.crypto_amount) || sogo.sogoAmount(tx.amount) || null,
       JSON.stringify(tx), depositHash || null],
    );
    sale = insert.rows[0] || null;
    if (!sale) {
      const again = await query(`SELECT * FROM crypto_deposit_sales WHERE reference = $1 LIMIT 1`, [String(tx.reference || "")]);
      sale = again.rows[0] || null;
    }
  }
  if (!sale) {
    console.warn("[crypto-settlement] crypto deposit without match:", tx?.reference);
    return "ignored";
  }
  if (sale.status === "completed") return "settled"; // idempotent

  // ---- Reconfirm with the provider before moving money (belt-and-braces) --
  const sogoRef = String(tx?.reference || sale.provider_reference || "");
  if (sogoRef && sale.provider === "sogo" && !sogo.isSogoSandbox()) {
    const remote = await reconfirmSogoDeposit(sogoRef);
    if (remote) {
      const rStatus = remoteStatus(remote);
      if (["failed", "refunded", "cancelled"].includes(rStatus)) {
        // The webhook claims money but the provider record says otherwise —
        // refuse to credit on conflicting evidence; leave for support.
        console.error(`[crypto-settlement] ${sale.reference}: reconfirm says ${rStatus} — NOT crediting`);
        await query(
          `UPDATE crypto_deposit_sales SET provider_response = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [sale.id, JSON.stringify({ webhook: tx, reconfirm: remote, conflict: true })],
        );
        return "held";
      }
      if (rStatus === "completed") {
        // Prefer the independently fetched record as the settlement source.
        tx = remote;
      }
    }
  }

  if (remoteStatus(tx) === "completed" || grossFromTx(tx) > 0) {
    const res = await settleSogoDeposit(sale, tx);
    if (res.settled) {
      await query(
        `UPDATE crypto_deposit_sales SET provider_reference = COALESCE($2, provider_reference) WHERE id = $1`,
        [sale.id, String(tx?.reference || "") || null],
      ).catch(() => {});
      return "settled";
    }
    return "held";
  }

  // Provider says failed/cancelled/refunded (or a terminal webhook arrived for
  // a deposit that never converted): no money was debited from the user, so
  // there is nothing to refund — mark the claim failed and inform the user.
  await query(
    `UPDATE crypto_deposit_sales SET status = 'failed', failure_reason = $2,
        provider_response = $3::jsonb, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'processing'`,
    [sale.id, `Provider reported: ${remoteStatus(tx) || "failed"}`, JSON.stringify(tx)],
  );
  if (depositHash) {
    await query(
      `UPDATE stablecoin_deposits SET status = 'failed', failure_reason = $2
        WHERE tx_hash = $1 AND status = 'pending'`,
      [depositHash, "Deposit did not complete at the provider"],
    ).catch(() => {});
  }
  return "settled";
}

/**
 * Reconciliation poller (5-minute cron). For every 'processing' deposit:
 *   1. ask the provider — by provider reference first, then by tx hash;
 *   2. completed  → settle (credit the customer);
 *   3. failed/refunded/cancelled → mark failed;
 *   4. no record at all after EXPIRE_AFTER_HOURS → mark failed with an
 *      honest reason (the customer was never debited, so no refund is due).
 * Returns the number of rows that changed state.
 */
export async function reconcilePendingCryptoDeposits(limit = 25): Promise<number> {
  await ensureSettlementSchema();
  const rows = await query(
    `SELECT * FROM crypto_deposit_sales
      WHERE status = 'processing'
        AND created_at < CURRENT_TIMESTAMP - ($2::text || ' minutes')::interval
      ORDER BY created_at ASC LIMIT $1`,
    [limit, String(MIN_POLL_AGE_MINUTES)],
  );
  let changed = 0;
  for (const sale of rows.rows) {
    try {
      let providerTx: any = null;
      if (sale.provider_reference) {
        providerTx = await reconfirmSogoDeposit(sale.provider_reference);
      }
      if (!providerTx && sale.tx_hash) {
        const hits = await sogo.getTransactionsByDepositHash(String(sale.tx_hash));
        if (Array.isArray(hits) && hits.length) {
          providerTx = hits.find((h: any) => remoteStatus(h) === "completed") || hits[0];
        }
      }
      const ageHours = (Date.now() - new Date(sale.created_at).getTime()) / 3_600_000;

      if (providerTx) {
        const before = String(sale.status);
        const outcome = await handleSogoDepositEvent(providerTx);
        if (outcome !== "held" || before !== "processing") changed += 1;
        if (outcome === "settled") {
          console.log(`[crypto-settlement] poller settled ${sale.reference}`);
        }
        continue;
      }

      if (ageHours >= EXPIRE_AFTER_HOURS) {
        await query(
          `UPDATE crypto_deposit_sales
              SET status = 'failed',
                  failure_reason = $2,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'processing'`,
          [sale.id,
           `No completed on-chain deposit found at the provider after ${EXPIRE_AFTER_HOURS}h — verify the asset/network and the transaction hash, or contact support with proof of payment.`],
        );
        await query(
          `UPDATE stablecoin_deposits SET status = 'failed', failure_reason = $2
            WHERE tx_hash = $1 AND status = 'pending'`,
          [sale.tx_hash, "Deposit not found on-chain after 24h"],
        ).catch(() => {});
        try {
          await createNotification({
            businessId: "",
            userId: String(sale.user_id),
            type: "warning",
            title: "Crypto deposit could not be confirmed",
            message: "We could not find your deposit on-chain within 24 hours. Please double-check the network you used and contact support with the transaction hash.",
            actionUrl: "/crypto",
            metadata: { reference: sale.reference },
            isActionable: false,
            expiresInHours: 720,
          });
        } catch { /* best effort */ }
        changed += 1;
        console.warn(`[crypto-settlement] poller expired ${sale.reference} after ${EXPIRE_AFTER_HOURS}h with no provider record`);
      }
    } catch (e: any) {
      console.error(`[crypto-settlement] poller error for ${sale.reference}:`, e?.message);
    }
  }
  return changed;
}
