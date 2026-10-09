/**
 * Inflow (wallet funding) transaction-limit guard.
 *
 * The registration-category transaction limits apply to BOTH directions:
 *   - outflow (transfers)  -> enforceTransactionLimits (server/routes/transfers.ts)
 *   - inflow  (funding)    -> this module
 *
 * Checkout funding is checked BEFORE the payment session is created
 * (POST /wallet/fund/card), so a user can never pay more than their tier
 * allows. Virtual-account funding has no pre-check opportunity (the sender
 * moves money straight into the VA), so the guard runs at credit time inside
 * the provider webhooks / verify callback:
 *
 *   1. The wallet is NOT credited.
 *   2. A FAILED wallet_funding transaction row is recorded (audit trail +
 *      visible to the user and admin).
 *   3. The collected money is refunded to the payer automatically when the
 *      provider supports API refunds (Flutterwave, Monnify); otherwise the
 *      record is flagged "manual refund required" for admin follow-up.
 *   4. The wallet owner is notified via push + in-app + email.
 */
import { query } from "../db";
import { enforceInflowLimits, type LimitCheckResult } from "./transaction-limits";
import { createNotification } from "./notifications";
import { sendPushToUsers } from "./push";
import { sendEmail } from "./email";
import { buildEmailFooterHtml } from "./email-footer";

export interface FundingLimitContext {
  /** business_id of the wallet owner (preferred for category lookup). */
  businessId?: string | null;
  /** user_id of the wallet owner (used for notifications). */
  userId?: string | null;
  /** Fallback owner key when the wallet has no business (personal wallet). */
  ownerKey?: string | null;
  currency?: string;
}

/**
 * Check whether a funding of `amount` is allowed for this business/user.
 * Returns ok:true when within limits. Never throws — DB failures fall back
 * to ALLOW so a limits outage can never swallow user money silently.
 */
export async function checkFundingLimit(
  ctx: FundingLimitContext,
  amount: number,
  options: { currency?: string } = {},
): Promise<LimitCheckResult> {
  const key = ctx.businessId || ctx.ownerKey;
  // Personal wallets without a business scope: enforcement is keyed on the
  // user id (businesses.registration_category lookup will not match, so the
  // default non_registered tier applies).
  if (!key) return { ok: true };
  try {
    return await enforceInflowLimits(key, amount, {
      currency: options.currency || ctx.currency || "NGN",
    });
  } catch (err: any) {
    console.error("[funding-limits] check failed, allowing funding:", err?.message);
    return { ok: true };
  }
}

interface RejectOverLimitParams {
  walletId: string;
  businessId?: string | null;
  userId?: string | null;
  /** Gross funding amount (what the payer sent, major units). */
  amount: number;
  currency?: string;
  /** Our reference for the failed transaction row. */
  reference: string;
  provider: string;
  /** Where the money was collected from. */
  source: "checkout" | "virtual_account";
  /** Provider-native identifiers that enable API refunds. */
  providerTransactionId?: string | number | null;
  providerReference?: string | null;
  /** Raw webhook/verify payload for the audit trail. */
  gatewayEvent?: unknown;
  /** Existing pending transaction row (checkout path) to fail in place. */
  existingTransactionId?: string | null;
  /** The limit check result that caused the rejection. */
  limitResult: LimitCheckResult;
}

export interface RejectOverLimitResult {
  rejected: boolean;
  transactionId: string | null;
  refund: {
    attempted: boolean;
    success: boolean;
    message: string;
    automatic: boolean;
  };
}

/**
 * Record a rejected over-limit funding and refund the payer where possible.
 * Idempotent by reference (unique index on transactions.reference).
 */
export async function rejectOverLimitFunding(
  params: RejectOverLimitParams,
): Promise<RejectOverLimitResult> {
  const {
    walletId,
    businessId,
    userId,
    amount,
    currency = "NGN",
    reference,
    provider,
    source,
    providerTransactionId,
    providerReference,
    gatewayEvent,
    existingTransactionId,
    limitResult,
  } = params;

  const fmt = (n: number) =>
    `${currency} ${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

  const reason =
    limitResult.error ||
    "Funding exceeds your transaction limit";
  const refundNoteBase = `Funding rejected — exceeds your transaction limit (${fmt(limitResult.data?.limit ?? 0)} ${limitResult.data?.limitType || ""} limit). Reference: ${reference}`;

  let transactionId: string | null = null;
  const refund: RejectOverLimitResult["refund"] = {
    attempted: false,
    success: false,
    message: "not attempted",
    automatic: false,
  };

  try {
    // 1. Record the failed funding (in place for checkout, new row for VA).
    if (existingTransactionId) {
      const upd = await query(
        `UPDATE transactions
           SET status = 'failed',
               description = $2,
               gateway_response = $3,
               updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('success','failed')
         RETURNING id`,
        [
          existingTransactionId,
          "Wallet Funding Rejected — Transaction Limit Exceeded",
          JSON.stringify({
            rejection: {
              reason,
              code: limitResult.code,
              limitType: limitResult.data?.limitType,
              limit: limitResult.data?.limit,
              amount,
              category: limitResult.data?.category,
            },
            refund,
            gatewayEvent,
          }),
        ],
      );
      transactionId = upd.rows[0]?.id || existingTransactionId;
    } else {
      const ins = await query(
        `INSERT INTO transactions
           (business_id, user_id, amount, currency, status, reference, type, description,
            transaction_type, wallet_id, direction, fee, payment_provider, gateway_response)
         VALUES ($1, $2, $3, $4, 'failed', $5, 'credit',
                 'Wallet Funding Rejected — Transaction Limit Exceeded',
                 'wallet_funding', $6, 'credit', 0, $7, $8)
         ON CONFLICT (reference) DO UPDATE
           SET status = 'failed',
               description = EXCLUDED.description,
               gateway_response = EXCLUDED.gateway_response,
               updated_at = NOW()
         RETURNING id`,
        [
          businessId || null,
          userId || null,
          amount,
          currency,
          reference,
          walletId,
          provider,
          JSON.stringify({
            rejection: {
              reason,
              code: limitResult.code,
              limitType: limitResult.data?.limitType,
              limit: limitResult.data?.limit,
              amount,
              category: limitResult.data?.category,
            },
            refund,
            gatewayEvent,
          }),
        ],
      );
      transactionId = ins.rows[0]?.id || null;
    }

    // 2. Best-effort automatic refund to the payer.
    let providerForRefund: any = null;
    try {
      const { getProvider } = await import("./providers/factory");
      providerForRefund = getProvider(provider);
    } catch {
      providerForRefund = null;
    }

    if (providerForRefund && typeof providerForRefund.refundPayment === "function") {
      refund.attempted = true;
      refund.automatic = true;
      try {
        const refundRes = await providerForRefund.refundPayment({
          transactionId: providerTransactionId || undefined,
          providerReference: providerReference || undefined,
          reference,
          amount: Number(amount) || undefined,
          currency,
          reason: refundNoteBase,
        });
        refund.success = !!refundRes?.success;
        refund.message = refundRes?.message || (refund.success ? "Refund initiated" : "Refund failed");
      } catch (refundErr: any) {
        refund.success = false;
        refund.message = refundErr?.message || "Refund request failed";
      }
    } else {
      refund.message = `${provider} does not support API refunds — manual refund required`;
    }

    // Persist the refund outcome on the transaction record.
    if (transactionId) {
      await query(
        `UPDATE transactions
           SET gateway_response = COALESCE(gateway_response, '{}'::jsonb) || $2::jsonb,
               updated_at = NOW()
         WHERE id = $1`,
        [transactionId, JSON.stringify({ refund })],
      ).catch(() => {});
    }

    console.error(
      `[funding-limits] REJECTED ${source} funding ${reference}: ${amount} ${currency} ` +
        `(${limitResult.code}, limit ${limitResult.data?.limit}); ` +
        `refund attempted=${refund.attempted} success=${refund.success} (${refund.message})`,
    );

    // 3. Notify the wallet owner — push (with in-app) + email.
    const ownerRes = await query(
      `SELECT id, name, email, business_id FROM users WHERE id = $1`,
      [userId],
    ).catch(() => ({ rows: [] as any[] }));
    const owner = ownerRes.rows[0];
    const ownerName = owner?.name || "there";
    const refundLine = refund.success
      ? `The full amount has been automatically refunded to the sender. Depending on the bank, the refund may take a few minutes to a few working days to reflect.`
      : refund.attempted
        ? `An automatic refund could not be completed (${refund.message}). Our support team has been notified and will process your refund manually.`
        : `This payment channel cannot be refunded automatically. Our support team has been notified and will process your refund manually.`;

    if (owner?.id) {
      sendPushToUsers(
        [{ userId: owner.id, businessId: owner.business_id || businessId || undefined }],
        {
          title: "Funding rejected — transaction limit exceeded",
          body: `Your funding of ${fmt(amount)} was rejected. ${refund.success ? "A refund has been initiated." : "Our team will process the refund."}`,
          data: {
            type: "funding_rejected",
            reference,
            amount: String(amount),
            currency,
            code: limitResult.code || "",
            refundStatus: refund.success ? "initiated" : "pending",
          },
        },
        { inApp: true, type: "funding_rejected", businessId: owner.business_id || businessId || undefined },
      ).catch((e: any) => console.warn("[funding-limits] push failed:", e?.message));

      if (owner.email) {
        const emailHtml = `<!DOCTYPE html>
<html>
  <body style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f3f4f6;padding:40px 0;margin:0;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;padding:40px;border-radius:12px;border-top:4px solid #ef4444;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);">
      <div style="text-align:center;margin-bottom:30px;">
        <h1 style="color:#111827;font-size:22px;font-weight:700;margin:0;">Funding Rejected — Transaction Limit Exceeded</h1>
      </div>
      <p style="color:#4b5563;font-size:14px;">Hello ${ownerName},</p>
      <p style="color:#4b5563;font-size:14px;">
        We received a funding of <strong>${fmt(amount)}</strong> (${source === "checkout" ? "checkout payment" : "bank transfer to your virtual account"}) but could not credit your wallet because it exceeds your transaction limit.
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:24px;margin:24px 0;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div><span style="color:#6b7280;font-size:12px;text-transform:uppercase;display:block;">Amount</span><strong style="color:#991b1b;font-size:18px;">${fmt(amount)}</strong></div>
          <div><span style="color:#6b7280;font-size:12px;text-transform:uppercase;display:block;">Your ${limitResult.data?.limitType || "applicable"} limit</span><strong style="font-size:18px;">${fmt(limitResult.data?.limit ?? 0)}</strong></div>
          <div><span style="color:#6b7280;font-size:12px;text-transform:uppercase;display:block;">Reference</span><span style="font-family:monospace;font-size:13px;">${reference}</span></div>
          <div><span style="color:#6b7280;font-size:12px;text-transform:uppercase;display:block;">Status</span><strong style="color:#ef4444;">Rejected — refund ${refund.success ? "initiated" : "pending"}</strong></div>
        </div>
      </div>
      <p style="color:#4b5563;font-size:14px;">${refundLine}</p>
      <p style="color:#4b5563;font-size:14px;">
        To send larger amounts, upgrade to a Registered Business account to unlock higher limits.
      </p>
      ${buildEmailFooterHtml()}
    </div>
  </body>
</html>`;
        sendEmail(
          owner.email,
          ownerName,
          "Funding rejected — transaction limit exceeded — Metricorex",
          emailHtml,
        ).catch(() => {});
      }
    }
  } catch (err: any) {
    console.error("[funding-limits] rejectOverLimitFunding failed:", err?.message);
  }

  return { rejected: true, transactionId, refund };
}

/**
 * HTML page shown after the /wallet/verify callback rejects an over-limit
 * funding (the browser lands here after checkout, so it needs a friendly
 * response instead of JSON).
 */
export function fundingRejectedHtml(reason: string, refunded: boolean, clientUrl?: string): string {
  const backUrl = clientUrl || process.env.CLIENT_URL || "/";
  const title = refunded ? "Payment Rejected & Refunded" : "Payment Rejected";
  const color = "#f59e0b";
  const detail = refunded
    ? "We received your payment but could not credit your wallet because it exceeds your transaction limit. The full amount has been refunded to the sender — it may take a few minutes to a few working days to reflect, depending on the bank."
    : "We received your payment but could not credit your wallet because it exceeds your transaction limit. Our support team has been notified and will process your refund.";
  return `
    <html>
        <head><meta charset="utf-8" /></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <div style="margin-bottom: 20px; font-size: 48px;">⚠️</div>
            <h1 style="color: ${color};">${title}</h1>
            <p style="max-width: 480px; margin: 0 auto; color: #374151;">${detail}</p>
            <p style="max-width: 480px; margin: 12px auto 0; color: #6b7280; font-size: 14px;">${reason}</p>
            <p style="max-width: 480px; margin: 12px auto 0; color: #6b7280; font-size: 13px;">Tip: upgrade to a Registered Business account to unlock higher limits.</p>
            <a href="${backUrl}" style="display: inline-block; padding: 10px 20px; background: ${color}; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Return to App</a>
        </body>
    </html>
  `;
}
