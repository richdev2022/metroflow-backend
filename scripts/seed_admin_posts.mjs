#!/usr/bin/env node
/**
 * seed_admin_posts.mjs — seed 10 realistic posts for the platform's own
 * account (metricorexlimited@gmail.com): 3 text-only, 4 photo posts (one is a
 * two-image carousel), 3 video posts. Media is written BOTH to
 * social_post_media (the ordered source of truth the feed renders) and to
 * social_posts.image_url/video_url (legacy first-media back-compat for OG
 * previews + older clients).
 *
 * Idempotent: a post whose exact body already exists for the admin is skipped.
 *
 * DRY RUN by default — pass --apply to insert.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnv() {
  for (const f of [".env", ".env.local"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      const cur = process.env[m[1]];
      if (!cur || (/neon\.tech/.test(val) && !/neon\.tech/.test(cur))) process.env[m[1]] = val;
    }
  }
}
loadEnv();
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl) { console.error("No DATABASE_URL found — run from metroflow-backend with .env present"); process.exit(1); }

const IMG = "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt";
const VID = "https://media.w3.org/2010/05";
const JELLY = "https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4";

// type: text | image | video ; images/videos are arrays (ordered carousel)
const HOURS_AGO = [3, 26, 51, 74, 98, 122, 147, 170, 196, 221];
const VIEWS = [462, 341, 288, 254, 197, 166, 121, 98, 76, 53];
const SHARES = [23, 17, 12, 9, 7, 5, 3, 2, 1, 0];

const POSTS = [
  { type: "text",
    body: "Your money, your rules. With Metricorex Personal you can split any bill with a single link - no long story, no \"send my share first\". Open your wallet and try Split Payments today. #Metricorex #SplitPayments #Fintech" },
  { type: "image",
    images: [`${IMG}/436f863c9852.jpg`],
    body: "From Lagos to Kano, we are building for all 36 states and the FCT. Next stop for the Metricorex community tour - where should we pop up? Drop your city below. #Metricorex #MadeInNigeria" },
  { type: "image",
    images: [`${IMG}/0572936583bd.jpg`],
    body: "Every trader deserves banking that keeps up. USSD transfers, instant settlement and zero downtime - even when NEPA takes the light. That is the Metricorex promise to our market people. #Metricorex #MarketMoney" },
  { type: "video",
    videos: [{ url: `${VID}/sintel/trailer.mp4` }],
    body: "60 seconds is all we need. Watch the full tour of the Metricorex wallet - cards, transfers, savings and crypto, all in one place. #Metricorex #WalletTour" },
  { type: "text",
    body: "PSA: your Transaction PIN is YOURS alone - and on Metricorex, every user on a business workspace has their own PIN, own wallet, own OTP line. We will never call you or ask for it. Stay sharp, stay safe. #SecurityFirst #Metricorex" },
  { type: "image",
    images: [`${IMG}/017b3a684d04.jpg`, `${IMG}/6dcaa6929529.jpg`],
    body: "Old school or new wave? The naira in your hand or one-tap transfers at your fingertip. On Metricorex you do not have to choose - cash in, cash out, both worlds work. #Fintech #Metricorex" },
  { type: "video",
    videos: [{ url: `${VID}/bunny/trailer.mp4` }],
    body: "Something big is loading for Metricorex Business. Teaser below - can you guess what it does? First correct answer gets a shoutout from this page. #ComingSoon #Metricorex" },
  { type: "text",
    body: "Community check: over 12,000 groups and pages were created on Metricorex this month alone. From anonces to alumni sets to ajo savings circles - start yours today from the Groups tab. #Community #Metricorex" },
  { type: "image",
    images: [`${IMG}/dfb768ffec77.jpg`],
    body: "Friday loading... Whether it is jollof at the office party or suya with the guys, scan any Metricorex QR and pay in seconds. Owa m! #WeekendVibes #ScanAndPay" },
  { type: "video",
    videos: [{ url: JELLY }],
    body: "Calm mind, clean code, clear money. Behind every transfer that lands in seconds is a team that ships every week. This is your product, built properly. #Metricorex #BuildInPublic" },
];

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const admin = await client.query(`SELECT id, name FROM users WHERE LOWER(email) = 'metricorexlimited@gmail.com' LIMIT 1`);
if (!admin.rows.length) { console.error("metricorexlimited@gmail.com NOT FOUND"); process.exit(1); }
const adminId = admin.rows[0].id;
console.log(`Seeding ${POSTS.length} posts for ${admin.rows[0].name} (${adminId}) — mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

let inserted = 0, skipped = 0;
for (let i = 0; i < POSTS.length; i++) {
  const p = POSTS[i];
  const dup = await client.query(`SELECT id FROM social_posts WHERE user_id = $1 AND body = $2 LIMIT 1`, [adminId, p.body]);
  if (dup.rows.length) { console.log(`  skip (exists): "${p.body.slice(0, 48)}..."`); skipped++; continue; }

  const createdAt = new Date(Date.now() - HOURS_AGO[i] * 3600_000);
  const firstImage = p.images?.[0] || null;
  const firstVideo = p.videos?.[0]?.url || null;

  if (!APPLY) {
    const kind = p.type === "image" ? `image x${p.images.length}` : p.type;
    console.log(`  [${HOURS_AGO[i]}h ago] ${kind.padEnd(10)} "${p.body.slice(0, 48)}..."`);
    continue;
  }

  const post = await client.query(
    `INSERT INTO social_posts (user_id, body, image_url, video_url, audience, status, share_count, view_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'public', 'active', $5, $6, $7, $7) RETURNING id`,
    [adminId, p.body, firstImage, firstVideo, SHARES[i], VIEWS[i], createdAt],
  );
  const postId = post.rows[0].id;

  const media = [
    ...(p.images || []).map((url) => ({ media_type: "image", url })),
    ...(p.videos || []).map((v) => ({ media_type: "video", url: v.url })),
  ];
  for (let pos = 0; pos < media.length; pos++) {
    await client.query(
      `INSERT INTO social_post_media (post_id, media_type, url, poster_url, position) VALUES ($1, $2, $3, NULL, $4)`,
      [postId, media[pos].media_type, media[pos].url, pos],
    );
  }
  inserted++;
  console.log(`  + [${HOURS_AGO[i]}h ago] ${p.type.padEnd(5)} x${media.length} media -> ${postId}`);
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${inserted} inserted, ${skipped} skipped (already present).`);
const total = await client.query(`SELECT COUNT(*)::int AS n FROM social_posts WHERE user_id = $1`, [adminId]);
console.log(`Admin now owns ${total.rows[0].n} posts total.`);
await client.end();
