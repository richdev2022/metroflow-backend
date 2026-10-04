import { query } from "../db";
import { sendEmail } from "./email-sender";
import { EMAIL_LOGO_URL_EXPORT as EMAIL_LOGO_URL } from "./email";

/**
 * Site growth service — marketing-site wishlist + email subscriptions and
 * per-category notification campaigns.
 *
 * Tables (see migrations.ensureSiteGrowthSchema):
 *  - site_wishlist_entries  — people who joined the Personal wishlist
 *  - site_subscribers       — email subscribers per category (text[])
 *  - site_email_campaigns   — audit trail of every admin bulk send
 */

/** Canonical subscriber categories. Admin campaigns target one category. */
export const SUBSCRIBER_CATEGORIES: Array<{ id: string; label: string; description: string }> = [
  {
    id: "product_updates",
    label: "Product Updates (monthly)",
    description: "A monthly digest of everything new across Metricorex",
  },
  {
    id: "wishlist",
    label: "Wishlist / Early Access",
    description: "Launch news and early-access invites for MetriCorex Personal",
  },
  {
    id: "newsletter",
    label: "General Newsletter",
    description: "Occasional stories, tips and announcements",
  },
];

const VALID_CATEGORIES = new Set(SUBSCRIBER_CATEGORIES.map((c) => c.id));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function normalizeCategories(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((c) => String(c).trim())
    .filter((c) => VALID_CATEGORIES.has(c));
  return Array.from(new Set(cleaned));
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 255);
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Branded email templates
// ---------------------------------------------------------------------------

const BRAND_NAME = process.env.BREVO_SENDER_NAME || "Metricorex";
const ACCENT = "#6D28D9"; // violet-700
const ACCENT_2 = "#C026D3"; // fuchsia-600

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layoutEmail(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 0;"><tr><td>
        <a href="${cta.url}" style="display:inline-block;background:linear-gradient(135deg, ${ACCENT}, ${ACCENT_2});color:#ffffff;text-decoration:none;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;padding:13px 34px;border-radius:999px;">${escapeHtml(cta.label)}</a>
      </td></tr></table>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 40px rgba(15,10,40,.08);">
        <tr><td style="background:linear-gradient(135deg, ${ACCENT}, ${ACCENT_2});padding:26px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:.5px;">${escapeHtml(BRAND_NAME)}</span>
        </td></tr>
        <tr><td style="padding:34px 36px 12px;">
          <div style="text-align:center;margin-bottom:20px;">
            <img src="${EMAIL_LOGO_URL}" alt="Metricorex Logo" style="max-width:150px;height:auto;" />
          </div>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${title}</h1>
          <div style="font-size:15px;line-height:1.65;color:#374151;">${bodyHtml}</div>
          ${ctaHtml}
        </td></tr>
        <tr><td style="padding:26px 36px 30px;border-top:1px solid #eef0f4;margin-top:24px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
            You are receiving this because you subscribed at metricorex.com.
            <br>© ${new Date().getFullYear()} ${escapeHtml(BRAND_NAME)}. All rights reserved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function wishlistConfirmationEmailHtml(name: string | null): string {
  const first = (name || "there").split(" ")[0];
  return layoutEmail(
    "You're on the wishlist ✨",
    `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
     <p style="margin:0 0 14px;">Welcome aboard! You've just joined the <strong>MetriCorex Personal</strong> wishlist — the all-in-one app for your money, bills, chats, streams and marketplace.</p>
     <p style="margin:0 0 14px;">Here's what happens next:</p>
     <ul style="margin:0 0 14px;padding-left:20px;">
       <li style="margin-bottom:6px;">You'll be among the <strong>first to get access</strong> when Personal opens its doors</li>
       <li style="margin-bottom:6px;">Founding members get <strong>early perks</strong> on transfers and bill payments</li>
       <li>We'll email you the moment your invite is ready</li>
     </ul>
     <p style="margin:0;">In the meantime, explore <strong>Metricorex for Business</strong> — it's live today.</p>`,
    { label: "Explore Metricorex Business", url: "https://metricorex.com" },
  );
}

export function subscriberWelcomeEmailHtml(name: string | null, categories: string[]): string {
  const first = (name || "there").split(" ")[0];
  const list = categories
    .map((c) => `<li style="margin-bottom:6px;">${escapeHtml(SUBSCRIBER_CATEGORIES.find((x) => x.id === c)?.label || c)}</li>`)
    .join("");
  return layoutEmail(
    "You're subscribed 🎉",
    `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
     <p style="margin:0 0 14px;">Thanks for subscribing to ${escapeHtml(BRAND_NAME)} updates. You'll hear from us about:</p>
     <ul style="margin:0 0 14px;padding-left:20px;">${list}</ul>
     <p style="margin:0;">No spam, ever — just the good stuff.</p>`,
  );
}

function campaignWrapperHtml(subject: string, bodyHtml: string): string {
  return layoutEmail(escapeHtml(subject), bodyHtml);
}

// ---------------------------------------------------------------------------
// Wishlist
// ---------------------------------------------------------------------------

export interface WishlistInput {
  name?: unknown;
  email: unknown;
  features?: unknown;
  note?: unknown;
  source?: unknown;
}

export async function addToWishlist(input: WishlistInput): Promise<{ id: string; isNew: boolean; emailSent: boolean }> {
  const email = String(input.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error("A valid email address is required");

  const name = cleanName(input.name);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) || null : null;
  const source = cleanName(input.source) || "website";

  let features: string[] = [];
  if (Array.isArray(input.features)) {
    features = Array.from(
      new Set(
        input.features
          .map((f) => String(f).trim().slice(0, 120))
          .filter((f) => f.length > 0)
          .slice(0, 40),
      ),
    );
  }

  const existing = await query(`SELECT id FROM site_wishlist_entries WHERE LOWER(email) = LOWER($1)`, [email]);
  const isNew = existing.rows.length === 0;

  const result = await query(
    `INSERT INTO site_wishlist_entries (name, email, features, note, source)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (LOWER(email)) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, site_wishlist_entries.name),
           features = EXCLUDED.features,
           note = COALESCE(EXCLUDED.note, site_wishlist_entries.note),
           updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [name, email, JSON.stringify(features), note, source],
  );

  // Confirmation email — send on first join only (never spam repeats)
  let emailSent = false;
  if (isNew) {
    emailSent = await sendEmail(email, name || "Friend", "You're on the MetriCorex Personal wishlist ✨", wishlistConfirmationEmailHtml(name));
    if (emailSent) {
      await query(`UPDATE site_wishlist_entries SET welcome_email_sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [result.rows[0].id]);
    }
  }

  return { id: result.rows[0].id, isNew, emailSent };
}

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

export interface SubscribeInput {
  name?: unknown;
  email: unknown;
  categories?: unknown;
  source?: unknown;
}

export async function addSubscriber(
  input: SubscribeInput,
): Promise<{ id: string; isNew: boolean; categories: string[]; emailSent: boolean }> {
  const email = String(input.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error("A valid email address is required");

  const name = cleanName(input.name);
  const source = cleanName(input.source) || "website";
  let categories = normalizeCategories(input.categories);
  if (categories.length === 0) categories = ["product_updates"];

  const existing = await query(`SELECT id, welcome_email_sent_at FROM site_subscribers WHERE LOWER(email) = LOWER($1)`, [email]);
  const isNew = existing.rows.length === 0;

  // Merge: never silently remove categories a subscriber already chose
  const result = await query(
    `INSERT INTO site_subscribers (name, email, categories, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (LOWER(email)) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, site_subscribers.name),
           categories = (
             SELECT array_agg(DISTINCT c) FROM unnest(site_subscribers.categories || EXCLUDED.categories) AS c
           ),
           is_active = TRUE,
           updated_at = CURRENT_TIMESTAMP
     RETURNING id, categories`,
    [name, email, categories, source],
  );

  const finalCategories: string[] = result.rows[0].categories || categories;
  let emailSent = false;
  const alreadyWelcomed = existing.rows.length > 0 && existing.rows[0].welcome_email_sent_at != null;
  if (isNew || !alreadyWelcomed) {
    emailSent = await sendEmail(
      email,
      name || "Friend",
      `Welcome to ${BRAND_NAME} updates 🎉`,
      subscriberWelcomeEmailHtml(name, finalCategories),
    );
    if (emailSent) {
      await query(`UPDATE site_subscribers SET welcome_email_sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [result.rows[0].id]);
    }
  }

  return { id: result.rows[0].id, isNew, categories: finalCategories, emailSent };
}

// ---------------------------------------------------------------------------
// Campaigns (admin bulk send)
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 5;
const CHUNK_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendCategoryCampaign(opts: {
  category: string;
  subject: string;
  bodyHtml: string;
  createdBy: string | null;
}): Promise<{ campaignId: string; recipients: number; sent: number; failed: number }> {
  const category = String(opts.category || "").trim();
  if (!VALID_CATEGORIES.has(category)) throw new Error("Unknown subscriber category");
  const subject = String(opts.subject || "").trim().slice(0, 255);
  if (subject.length < 3) throw new Error("Subject is required");
  const bodyHtml = String(opts.bodyHtml || "").trim();
  if (bodyHtml.length < 10) throw new Error("Email body is required");

  const recipientsRes = await query(
    `SELECT email, name FROM site_subscribers WHERE is_active = TRUE AND $1 = ANY(categories)`,
    [category],
  );
  const recipients: Array<{ email: string; name: string | null }> = recipientsRes.rows;
  if (recipients.length === 0) {
    throw new Error("No active subscribers in this category yet");
  }

  const html = campaignWrapperHtml(subject, bodyHtml);

  const campaignRes = await query(
    `INSERT INTO site_email_campaigns (category, subject, body_html, recipients_count, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [category, subject, html, recipients.length, opts.createdBy],
  );
  const campaignId: string = campaignRes.rows[0].id;

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map((r) =>
        sendEmail(r.email, r.name || "Friend", subject, html)
          .then((ok) => (ok ? "sent" : "failed"))
          .catch(() => "failed"),
      ),
    );
    sent += results.filter((r) => r === "sent").length;
    failed += results.filter((r) => r === "failed").length;
    if (i + CHUNK_SIZE < recipients.length) await sleep(CHUNK_DELAY_MS);
  }

  await query(
    `UPDATE site_email_campaigns SET sent_count = $1, failed_count = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [sent, failed, campaignId],
  );

  return { campaignId, recipients: recipients.length, sent, failed };
}
