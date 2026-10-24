import { query } from "../../db";

/**
 * PERSONAL APP — schema for all Personal-only features.
 *
 * Sections:
 *   1. Identity model upgrade   — account_type ('personal'|'business'), nullable
 *                                 business_id, user-scoped transaction PIN,
 *                                 per-currency wallets.
 *   2. Bills Hub + Savings      — original dormant tables (unchanged contract).
 *   3. Social (Facebook-style)  — posts, media, comments (with replies),
 *                                 multi-type reactions, robust polls, boosts.
 *   4. Live (TikTok-style)      — sessions, viewers, chat, reactions,
 *                                 moderation, co-hosts.
 *   5. Marketplace              — listings, orders (escrow-lite), saves, boosts.
 *   6. Commerce providers       — gift card (Prestmit) buy/sell, crypto sales
 *                                 (Bitnob), virtual cards (Bitnob), eSIM/data.
 *   7. Boost engine config      — system_settings pricing + global toggles.
 *
 * Everything is idempotent and safe to run on every boot.
 */

export async function ensurePersonalSchema(): Promise<void> {
  // ------------------------------------------------------------------
  // 1. IDENTITY MODEL UPGRADE (must run before any personal data lands)
  // ------------------------------------------------------------------
  // Personal users exist WITHOUT a business: users.business_id becomes
  // nullable and account_type marks the account kind.
  await query(`ALTER TABLE users ALTER COLUMN business_id DROP NOT NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'business'`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_account_type ON users(account_type)`);
  // Personal transaction PIN (business users keep businesses.transaction_pin_hash).
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS transaction_pin_hash VARCHAR(255)`);
  // Sessions may now belong to a personal user (no business context).
  await query(`ALTER TABLE user_sessions ALTER COLUMN business_id DROP NOT NULL`);
  // Wallets become per-currency: (user_id, currency) / (business_id, currency).
  // Old constraints UNIQUE(user_id) / UNIQUE(business_id) are replaced so a
  // personal user holds NGN + USD wallets. NULLs never conflict in PG uniques,
  // so business rows keep their uniqueness semantics.
  await query(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_user_id_key`);
  await query(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_business_id_key`);
  // Clean zero-balance duplicates before adding per-currency uniques (idempotent;
  // any residual funded duplicates are skipped with a warning instead of breaking boot).
  await query(`
    DELETE FROM wallets w
    USING wallets w2
    WHERE w.user_id IS NOT NULL AND w.user_id = w2.user_id AND w.currency = w2.currency
      AND w.balance = 0 AND w2.balance > 0
  `);
  await query(`
    DELETE FROM wallets w
    USING wallets w2
    WHERE w.business_id IS NOT NULL AND w.business_id = w2.business_id AND w.currency = w2.currency
      AND w.balance = 0 AND w2.balance > 0
  `);
  await query(`
    DO $$ BEGIN
      ALTER TABLE wallets ADD CONSTRAINT wallets_user_currency_key UNIQUE (user_id, currency);
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; WHEN others THEN RAISE NOTICE 'wallets_user_currency_key skipped: %', SQLERRM; END $$;
  `);
  await query(`
    DO $$ BEGIN
      ALTER TABLE wallets ADD CONSTRAINT wallets_business_currency_key UNIQUE (business_id, currency);
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN unique_violation THEN NULL; WHEN others THEN RAISE NOTICE 'wallets_business_currency_key skipped: %', SQLERRM; END $$;
  `);
  // STABLECOIN WALLETS (USDT + USDC) replace the legacy USD wallet:
  //   - widen wallets.currency (VARCHAR(3) cannot hold "USDT"/"USDC")
  //   - legacy USD wallets migrate 1:1 into USDT (balance preserved) and are
  //     archived — stablecoins ARE the USD rails from here on
  //   - every personal user gets USDT + USDC wallets (idempotent)
  await query(`ALTER TABLE wallets ALTER COLUMN currency TYPE VARCHAR(8)`);
  // Rename USD -> USDT when the user has no USDT wallet yet (keeps balance in place).
  await query(`
    UPDATE wallets w
    SET currency = 'USDT', updated_at = CURRENT_TIMESTAMP
    WHERE UPPER(w.currency) = 'USD'
      AND w.user_id IS NOT NULL
      AND w.status <> 'archived'
      AND NOT EXISTS (
        SELECT 1 FROM wallets u2
        WHERE u2.user_id = w.user_id AND UPPER(u2.currency) = 'USDT' AND u2.id <> w.id
      )
  `);
  // Merge leftover USD balances into an existing USDT wallet, then archive the USD row.
  await query(`
    WITH moved AS (
      UPDATE wallets usd
      SET balance = 0, status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE UPPER(usd.currency) = 'USD'
        AND usd.user_id IS NOT NULL
        AND usd.status <> 'archived'
        AND usd.balance > 0
        AND EXISTS (
          SELECT 1 FROM wallets u2
          WHERE u2.user_id = usd.user_id AND UPPER(u2.currency) = 'USDT'
            AND u2.status = 'active' AND u2.id <> usd.id
        )
      RETURNING usd.user_id AS uid, usd.balance AS amt
    )
    UPDATE wallets usdt
    SET balance = usdt.balance + moved.amt, updated_at = CURRENT_TIMESTAMP
    FROM moved
    WHERE usdt.user_id = moved.uid AND UPPER(usdt.currency) = 'USDT' AND usdt.status = 'active'
  `);
  // Archive any USD row that survived the ladders (zero-balance leftovers).
  await query(`
    UPDATE wallets SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE UPPER(currency) = 'USD' AND user_id IS NOT NULL AND status <> 'archived'
  `);
  // Ensure every personal user owns USDT + USDC wallets going forward.
  await query(`
    INSERT INTO wallets (user_id, business_id, balance, currency, status)
    SELECT DISTINCT u.id, NULL, 0, c.currency, 'active'
    FROM users u
    CROSS JOIN (VALUES ('USDT'), ('USDC')) AS c(currency)
    WHERE u.account_type = 'personal' AND u.business_id IS NULL
    ON CONFLICT (user_id, currency) DO NOTHING
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(40)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)`);
  // Cross-app SSO tickets (Business <-> Personal switching).
  await query(`
    CREATE TABLE IF NOT EXISTS sso_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket VARCHAR(80) UNIQUE NOT NULL,
      user_id UUID NOT NULL,
      business_id VARCHAR(255),
      purpose VARCHAR(20) NOT NULL,
      next_url TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_sso_tickets_expiry ON sso_tickets(expires_at)`);

  // ------------------------------------------------------------------
  // 2. BILLS HUB + SAVINGS VAULTS (original dormant tables)
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      category VARCHAR(30) NOT NULL, -- airtime | data | tv | electricity | betting
      provider_code VARCHAR(60) NOT NULL, -- e.g. mtn, dstv, ikedc
      provider_name VARCHAR(120),
      plan_code VARCHAR(60),         -- data/TV plan code when applicable
      plan_name VARCHAR(160),
      customer_ref VARCHAR(160) NOT NULL, -- phone | smartcard | meter | user id
      customer_phone VARCHAR(50),
      amount DECIMAL(12,2) NOT NULL,
      fee DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending', -- pending | success | failed | refunded
      fulfilment_mode VARCHAR(20),   -- provider | simulated
      provider_reference VARCHAR(120),
      provider_response JSONB,
      failure_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_payments_business ON bill_payments(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_payments_user ON bill_payments(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bill_payments_status ON bill_payments(status)`);

  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS bills_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_bills_per_day INTEGER DEFAULT 3`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS bill_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Bill Payment Convenience Fee', 'bill', 'flat',
           '{"amount": 50}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'bill')
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS savings_vaults (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id VARCHAR(255),
      user_id UUID,
      name VARCHAR(120) NOT NULL,
      currency VARCHAR(3) DEFAULT 'NGN',
      balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      goal_amount DECIMAL(15,2),
      target_date DATE,
      status VARCHAR(20) DEFAULT 'active', -- active | paused | closed
      auto_save_enabled BOOLEAN DEFAULT FALSE,
      auto_save_amount DECIMAL(12,2),
      auto_save_frequency VARCHAR(20),     -- daily | weekly | monthly
      auto_save_wallet_id UUID,
      auto_save_next_run TIMESTAMP,
      auto_save_last_run TIMESTAMP,
      auto_save_failures INTEGER DEFAULT 0,
      withdrawn_at TIMESTAMP,
      total_deposited DECIMAL(15,2) NOT NULL DEFAULT 0,
      total_withdrawn DECIMAL(15,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_vaults_business ON savings_vaults(business_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_vaults_user ON savings_vaults(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_vaults_autosave ON savings_vaults(auto_save_next_run) WHERE auto_save_enabled = TRUE AND status = 'active'`);

  await query(`
    CREATE TABLE IF NOT EXISTS savings_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vault_id UUID NOT NULL REFERENCES savings_vaults(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,   -- deposit | withdrawal | auto_save | break_fee
      amount DECIMAL(15,2) NOT NULL,
      fee DECIMAL(15,2) NOT NULL DEFAULT 0,
      balance_after DECIMAL(15,2) NOT NULL,
      wallet_id UUID,
      reference VARCHAR(255) UNIQUE,
      status VARCHAR(20) DEFAULT 'success',
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_savings_transactions_vault ON savings_transactions(vault_id)`);

  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS savings_enabled BOOLEAN DEFAULT TRUE`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS max_savings_vaults INTEGER DEFAULT 1`);
  await query(`ALTER TABLE pricing_plans ADD COLUMN IF NOT EXISTS savings_break_fee_discount_percent DECIMAL(5,2) DEFAULT 0`);

  await query(`
    INSERT INTO fee_configurations (name, fee_type, config_type, config, currency)
    SELECT 'Savings Early Withdrawal Fee', 'savings_break', 'percentage_cap',
           '{"percentage": 2.0, "cap": 5000}'::jsonb, 'NGN'
    WHERE NOT EXISTS (SELECT 1 FROM fee_configurations WHERE fee_type = 'savings_break')
  `);

  // ------------------------------------------------------------------
  // 3. SOCIAL — Facebook-style feed
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      video_url TEXT,
      audience VARCHAR(20) NOT NULL DEFAULT 'public', -- public | followers
      status VARCHAR(20) NOT NULL DEFAULT 'active',   -- active | removed
      removed_reason TEXT,
      share_count INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_posts_recent ON social_posts(created_at DESC)`);

  // Community reports — users flag posts; admins review + decide end-to-end.
  await query(`
    CREATE TABLE IF NOT EXISTS social_post_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      reporter_id UUID NOT NULL,
      reason VARCHAR(30) NOT NULL,             -- spam|harassment|hate_speech|violence|nudity|misinformation|scam|other
      details TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | actioned | dismissed
      decision VARCHAR(30),                    -- remove_post | dismiss | warn_user
      decision_note TEXT,
      decided_by VARCHAR(64),
      decided_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, reporter_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_reports_status ON social_post_reports(status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_reports_post ON social_post_reports(post_id)`);

  // Post view ledger — powers profile/video analytics (views, unique viewers,
  // reach). One row per view event; `day` buckets allow unique-per-day counts.
  // `author_id` is denormalised so profile analytics never needs a join.
  await query(`
    CREATE TABLE IF NOT EXISTS social_post_views (
      id BIGSERIAL PRIMARY KEY,
      post_id UUID NOT NULL,
      author_id UUID NOT NULL,
      viewer_id UUID,
      source VARCHAR(20) NOT NULL DEFAULT 'feed', -- feed | deep_link | share | boost
      day DATE NOT NULL DEFAULT CURRENT_DATE,
      viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_views_post ON social_post_views(post_id, viewed_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_views_author_day ON social_post_views(author_id, day)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_views_day ON social_post_views(day)`);

  // Multi-media posts — a post may carry up to 10 photos/videos in an ordered
  // carousel. `social_posts.image_url`/`video_url` stay populated with the
  // FIRST media (back-compat for OG share previews + older clients); this
  // table is the ordered source of truth the feed renders from.
  await query(`
    CREATE TABLE IF NOT EXISTS social_post_media (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      media_type VARCHAR(10) NOT NULL DEFAULT 'image', -- image | video
      url TEXT NOT NULL,
      poster_url TEXT,                                 -- captured frame for videos
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_media_post ON social_post_media(post_id, position)`);

  // Saved posts — Facebook-style collections. A user files any post into one
  // or more named folders ("Videos", "Photos", or their own creations);
  // membership rows are idempotent per (collection, post).
  await query(`
    CREATE TABLE IF NOT EXISTS social_post_collections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(80) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, name)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_collections_user ON social_post_collections(user_id, updated_at DESC)`);
  await query(`
    CREATE TABLE IF NOT EXISTS social_post_collection_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection_id UUID NOT NULL REFERENCES social_post_collections(id) ON DELETE CASCADE,
      post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (collection_id, post_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_collection_items_coll ON social_post_collection_items(collection_id, saved_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_post_collection_items_post ON social_post_collection_items(post_id)`);

  // ------------------------------------------------------------------
  // 3b. ACCOUNT VERIFICATION BADGE — monthly subscription
  //     Badge status lives on users (verified_badge_status/verified_until);
  //     payments are ledgered in verification_subscriptions. Pricing is
  //     admin-configurable via system_settings `verification_badge_pricing`.
  // ------------------------------------------------------------------
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_badge_status VARCHAR(20) NOT NULL DEFAULT 'none'`); // none|active|expired|revoked
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_until TIMESTAMP`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_since TIMESTAMP`);
  // Where the badge came from: 'subscription' (paid), 'criteria' (earned via
  // the admin-configurable follower threshold — never expires), 'admin'
  // (manual grant). Guards criteria revocation on unfollow.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_badge_source VARCHAR(20)`);
  await query(`
    CREATE TABLE IF NOT EXISTS verification_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      price NUMERIC(14,2) NOT NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
      duration_days INTEGER NOT NULL DEFAULT 30,
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | expired | revoked
      reference VARCHAR(60),
      starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ends_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_verification_subs_user ON verification_subscriptions(user_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_badge ON users(verified_badge_status) WHERE verified_badge_status != 'none'`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_reactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'like', -- like|love|haha|wow|sad|angry
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_reactions_post ON social_reactions(post_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      parent_id UUID REFERENCES social_comments(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      like_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_comments_post ON social_comments(post_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_comments_parent ON social_comments(parent_id)`);

  // Per-user comment/reply likes — social_comments.like_count stays a
  // denormalized counter maintained by the toggle endpoint.
  await query(`
    CREATE TABLE IF NOT EXISTS social_comment_likes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      comment_id UUID NOT NULL REFERENCES social_comments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comment_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_comment_likes_comment ON social_comment_likes(comment_id)`);

  // Robust polls: up to 10 options, optional media, expiry, single/multi choice,
  // revocable votes, per-option image, closed/active status.
  await query(`
    CREATE TABLE IF NOT EXISTS social_polls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID REFERENCES social_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL,            -- [{text, image_url?}] (2..10)
      allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
      hide_results_until_closed BOOLEAN NOT NULL DEFAULT FALSE,
      ends_at TIMESTAMP,
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | closed | removed
      removed_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_polls_user ON social_polls(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_polls_post ON social_polls(post_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_poll_votes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id UUID NOT NULL REFERENCES social_polls(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      option_index INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(poll_id, user_id, option_index)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_poll_votes_poll ON social_poll_votes(poll_id)`);

  // Paid polls economics: voters pay per vote from their NGN wallet; the money
  // pools on the poll; at maturity the creator withdraws to their NGN wallet and
  // the admin-configured withdrawal fee lands in the platform revenue ledger.
  // poll_type: free | paid
  await query(`ALTER TABLE social_polls ADD COLUMN IF NOT EXISTS poll_type VARCHAR(10) NOT NULL DEFAULT 'free'`);
  await query(`ALTER TABLE social_polls ADD COLUMN IF NOT EXISTS vote_price NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE social_polls ADD COLUMN IF NOT EXISTS pool_earned NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE social_polls ADD COLUMN IF NOT EXISTS pool_withdrawn NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE social_polls ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  await query(`ALTER TABLE social_poll_votes ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_polls_paid_user ON social_polls(user_id) WHERE poll_type = 'paid'`);

  await query(`
    CREATE TABLE IF NOT EXISTS poll_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id UUID NOT NULL REFERENCES social_polls(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      amount NUMERIC(14,2) NOT NULL,        -- debited from the poll pool
      fee NUMERIC(14,2) NOT NULL DEFAULT 0, -- admin-configured fee → revenue ledger
      net_amount NUMERIC(14,2) NOT NULL,    -- credited to the creator's NGN wallet
      reference VARCHAR(80) UNIQUE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_poll_withdrawals_user ON poll_withdrawals(user_id, created_at DESC)`);

  // ------------------------------------------------------------------
  // 4. BOOST ENGINE (posts + marketplace listings share one engine)
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS boost_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      target_type VARCHAR(20) NOT NULL,     -- post | listing
      target_id UUID NOT NULL,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      budget DECIMAL(12,2) NOT NULL,
      duration_days INTEGER NOT NULL,
      daily_budget DECIMAL(12,2) NOT NULL,
      audience JSONB,                       -- {locations:[], age_min, age_max, interests:[]}
      pricing_snapshot JSONB NOT NULL,      -- pricing row used at purchase time
      estimated_reach INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- pending_payment|active|paused|completed|cancelled|rejected
      starts_at TIMESTAMP,
      ends_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_boost_orders_user ON boost_orders(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_boost_orders_target ON boost_orders(target_type, target_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_boost_orders_status ON boost_orders(status)`);

  // ------------------------------------------------------------------
  // 5. LIVE — TikTok-style streaming
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id UUID NOT NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT,
      category VARCHAR(40) NOT NULL DEFAULT 'general',
      call_code VARCHAR(20) UNIQUE NOT NULL,   -- rides the proven call-room stack
      status VARCHAR(20) NOT NULL DEFAULT 'live', -- live | ended | removed
      cohost_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      pinned_message TEXT,
      slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
      current_viewers INTEGER NOT NULL DEFAULT 0,
      peak_viewers INTEGER NOT NULL DEFAULT 0,
      total_views INTEGER NOT NULL DEFAULT 0,
      reaction_count INTEGER NOT NULL DEFAULT 0,
      gift_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS moderator_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
  // TikTok-style tap-to-like counter — incremented in small batches by the
  // room UI as viewers tap the stream (see POST /live/:id/likes).
  await query(`ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0`);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status, started_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_sessions_host ON live_sessions(host_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS live_viewers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      left_at TIMESTAMP,
      UNIQUE(session_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_viewers_session ON live_viewers(session_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS live_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      body TEXT NOT NULL,
      is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
      is_removed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_messages_session ON live_messages(session_id, created_at)`);

  await query(`
    CREATE TABLE IF NOT EXISTS live_reactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      emoji VARCHAR(20) NOT NULL DEFAULT 'heart',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_reactions_session ON live_reactions(session_id, created_at)`);

  // TikTok-style "clip this moment" highlights. The host (or a moderator)
  // bookmarks a timestamp mid-broadcast; the room UI and the stream summary
  // surface them so viewers can jump to / rewatch the good parts once VOD
  // recording lands. offset_seconds is measured from started_at.
  await query(`
    CREATE TABLE IF NOT EXISTS live_clips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      created_by UUID NOT NULL,
      label VARCHAR(120) NOT NULL DEFAULT '',
      offset_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_clips_session ON live_clips(session_id, offset_seconds)`);

  // VOD replays — the host's client records the composed stream (canvas +
  // mixed audio via MediaRecorder) and uploads the file when the recording
  // stops (or when the broadcast ends). Replays surface on the live wall
  // ("Replays" rail), the ended screen and the stream summary, and the clip
  // highlights (live_clips.offset_seconds) act as chapter markers inside the
  // recording so viewers can jump straight to the good parts.
  await query(`
    CREATE TABLE IF NOT EXISTS live_vods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      host_id UUID NOT NULL,
      url TEXT NOT NULL,
      poster_url TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      mime_type VARCHAR(60),
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_vods_session ON live_vods(session_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_vods_recent ON live_vods(created_at DESC)`);

  // ------------------------------------------------------------------
  // 6a. MARKETPLACE — Facebook-Marketplace-style
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS market_listings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id UUID NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      category VARCHAR(60) NOT NULL DEFAULT 'other',
      condition VARCHAR(30) NOT NULL DEFAULT 'used_good', -- new|like_new|used_good|used_fair
      price DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
      negotiable BOOLEAN NOT NULL DEFAULT TRUE,
      location_text VARCHAR(160),
      stock INTEGER,
      images JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["/files/..", ...]
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | sold | removed | suspended
      removed_reason TEXT,
      view_count INTEGER NOT NULL DEFAULT 0,
      save_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_market_listings_seller ON market_listings(seller_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_market_listings_status ON market_listings(status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_market_listings_category ON market_listings(category)`);

  // Richer item details — everything a buyer should see before deciding
  // (idempotent ladder so existing deployments gain the columns on boot).
  await query(`ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS brand VARCHAR(80)`);
  await query(`ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS model VARCHAR(80)`);
  await query(`ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS warranty_note VARCHAR(200)`);
  await query(`ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS pickup_ok BOOLEAN NOT NULL DEFAULT TRUE`);
  await query(`ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS delivery_ok BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0`);

  await query(`
    CREATE TABLE IF NOT EXISTS market_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reference VARCHAR(255) UNIQUE NOT NULL,
      listing_id UUID NOT NULL REFERENCES market_listings(id),
      buyer_id UUID NOT NULL,
      seller_id UUID NOT NULL,
      wallet_id UUID NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price DECIMAL(12,2) NOT NULL,
      fee DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
      delivery_address TEXT,
      delivery_phone VARCHAR(50),
      status VARCHAR(24) NOT NULL DEFAULT 'paid',
      -- paid | shipped | completed | cancelled | refunded | disputed
      payment_released_at TIMESTAMP,
      cancelled_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_market_orders_buyer ON market_orders(buyer_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_market_orders_seller ON market_orders(seller_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS market_saves (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id UUID NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(listing_id, user_id)
    )
  `);

  // ------------------------------------------------------------------
  // 6b. COMMERCE PROVIDERS — gift cards / crypto / virtual cards / eSIM
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS giftcard_sell_trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,           -- our reference (MF-GCS-..)
      provider_reference VARCHAR(120),                  -- Prestmit SGC..
      giftcard_id VARCHAR(40) NOT NULL,
      giftcard_name VARCHAR(160),
      amount DECIMAL(12,2) NOT NULL,
      rate DECIMAL(12,2),
      payout_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      payout_method VARCHAR(20) NOT NULL DEFAULT 'NAIRA',
      currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      -- pending | processing | approved | rejected | settled | failed
      comments TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      rejection_reason TEXT,
      provider_response JSONB,
      credited_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_gc_sell_user ON giftcard_sell_trades(user_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS giftcard_buy_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      provider_reference VARCHAR(160),
      giftcard_sku VARCHAR(40) NOT NULL,
      giftcard_name VARCHAR(160),
      quantity INTEGER NOT NULL DEFAULT 1,
      card_price DECIMAL(12,2) NOT NULL,
      fee DECIMAL(12,2) NOT NULL DEFAULT 0,
      total_charged DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
      payment_method VARCHAR(20) NOT NULL DEFAULT 'NAIRA',
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      -- pending | completed | failed | refunded
      card_codes JSONB,
      provider_response JSONB,
      failure_reason TEXT,
      refunded_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_gc_buy_user ON giftcard_buy_orders(user_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS crypto_sales (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',
      provider_reference VARCHAR(160),
      from_asset VARCHAR(10) NOT NULL,         -- USDT | USDC | BTC
      usd_debit DECIMAL(15,2) NOT NULL,
      settlement_amount DECIMAL(15,2) NOT NULL,
      settlement_currency VARCHAR(5) NOT NULL DEFAULT 'NGN',
      rate DECIMAL(18,6),
      bank_code VARCHAR(20),
      bank_name VARCHAR(120),
      account_number VARCHAR(30),
      account_name VARCHAR(160),
      beneficiary JSONB,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      -- pending | processing | completed | failed | refunded
      provider_response JSONB,
      failure_reason TEXT,
      completed_at TIMESTAMP,
      refunded_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_crypto_sales_user ON crypto_sales(user_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS virtual_cards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'bitnob',
      provider_card_id VARCHAR(120),
      provider_customer_id VARCHAR(120),
      name VARCHAR(120),
      currency VARCHAR(5) NOT NULL DEFAULT 'USD',
      card_brand VARCHAR(20) DEFAULT 'visa',
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      -- pending | active | frozen | terminated | failed
      masked_pan VARCHAR(30),
      balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      meta JSONB,
      failure_reason TEXT,
      terminated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_virtual_cards_user ON virtual_cards(user_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS virtual_card_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      card_id UUID NOT NULL REFERENCES virtual_cards(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      type VARCHAR(20) NOT NULL,               -- fund | withdraw | spend | refund
      amount DECIMAL(15,2) NOT NULL,
      currency VARCHAR(5) NOT NULL DEFAULT 'USD',
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      description TEXT,
      reference VARCHAR(255),
      provider_txn_id VARCHAR(160),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vcard_txn_card ON virtual_card_transactions(card_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS esim_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      wallet_id UUID NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'flutterwave',
      provider_reference VARCHAR(160),
      package_code VARCHAR(60) NOT NULL,
      package_name VARCHAR(160),
      country_code VARCHAR(5) NOT NULL DEFAULT 'NG',
      country_name VARCHAR(80),
      data_amount_mb INTEGER,
      validity_days INTEGER,
      customer_ref VARCHAR(160) NOT NULL,
      total DECIMAL(12,2) NOT NULL,
      fee DECIMAL(12,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      activation_details JSONB,
      provider_response JSONB,
      failure_reason TEXT,
      refunded_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_esim_orders_user ON esim_orders(user_id)`);

  // ------------------------------------------------------------------
  // 7. BOOST ENGINE + PERSONAL SERVICES CONFIG (system_settings defaults)
  // ------------------------------------------------------------------
  // Post/listing boost pricing. price_per_1000 = what the user pays per
  // 1,000 estimated impressions; min/max_budget guard rails in NGN.
  await query(`
    INSERT INTO system_settings (key, value, description)
    SELECT 'personal_boost_pricing', $1::jsonb,
           'Boost engine pricing for posts + marketplace listings (personal app)'
    WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'personal_boost_pricing')
  `, [
    JSON.stringify({
      currency: "NGN",
      post: { price_per_1000: 250, min_budget: 500, max_budget: 200000, allowed_durations: [1, 3, 7, 14] },
      listing: { price_per_1000: 200, min_budget: 300, max_budget: 100000, allowed_durations: [1, 3, 7, 14] },
      audience_multiplier: { national: 1.0, state: 0.65, city: 0.5 },
      engagement_boost_factor: 1.35, // posts with reactions rank higher per impression
    }),
  ]);

  // ------------------------------------------------------------------
  // 6. ACCOUNT PRIVACY + FRIENDSHIPS (public/private accounts)
  //    - users.account_privacy: 'public' (default, chat-open) | 'private'
  //      (chat locked until an accepted friendship exists)
  //    - friend_requests: pending/accepted/declined requests. An ACCEPTED
  //      row in EITHER direction = symmetric friendship.
  // ------------------------------------------------------------------
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_privacy VARCHAR(10) NOT NULL DEFAULT 'public'`);
  await query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id UUID NOT NULL,
      addressee_id UUID NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | accepted | declined
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP,
      CONSTRAINT friend_requests_pair UNIQUE (requester_id, addressee_id),
      CONSTRAINT friend_requests_not_self CHECK (requester_id <> addressee_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_addressee ON friend_requests (addressee_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_requester ON friend_requests (requester_id, status)`);

  // ------------------------------------------------------------------
  // 8. TIKTOK-STYLE SOCIAL GRAPH + LIVE MONETISATION
  //    - users.username / users.bio for shareable public profiles (/u/:username)
  //    - social_follows: asymmetric TikTok follow graph (follow / follow-back)
  //    - social_follow_requests: follow requests INTO private accounts
  //    - live_battles: PK battles between two live streamers (gift-driven score)
  //    - live_gift_pockets: per-streamer earnings pocket → withdraw to NGN
  //    - live_pocket_withdrawals: withdrawal ledger (fee applied here)
  // ------------------------------------------------------------------
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(32)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username)) WHERE username IS NOT NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id UUID NOT NULL,
      following_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id),
      CONSTRAINT social_follows_not_self CHECK (follower_id <> following_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_follows_following ON social_follows(following_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_follows_follower ON social_follows(follower_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_follow_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id UUID NOT NULL,
      target_id UUID NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | accepted | declined
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP,
      CONSTRAINT social_follow_requests_pair UNIQUE (requester_id, target_id),
      CONSTRAINT social_follow_requests_not_self CHECK (requester_id <> target_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_follow_requests_target ON social_follow_requests (target_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_follow_requests_requester ON social_follow_requests (requester_id, status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS live_battles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_a_id UUID NOT NULL,                 -- initiator's live session
      session_b_id UUID,                          -- opponent's live session (set on accept)
      host_a_id UUID NOT NULL,
      host_b_id UUID,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      -- pending | active | ended | declined | cancelled | expired
      duration_seconds INTEGER NOT NULL DEFAULT 300,
      started_at TIMESTAMP,
      ends_at TIMESTAMP,
      score_a NUMERIC(14,2) NOT NULL DEFAULT 0,   -- gifting points, side A
      score_b NUMERIC(14,2) NOT NULL DEFAULT 0,   -- gifting points, side B
      winner VARCHAR(4),                          -- 'a' | 'b' | 'tie'
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_battles_session_a ON live_battles(session_a_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_battles_session_b ON live_battles(session_b_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_battles_host_a ON live_battles(host_a_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_battles_host_b ON live_battles(host_b_id, status)`);

  // Per-streamer earnings pocket. available = total_earned − total_withdrawn.
  await query(`
    CREATE TABLE IF NOT EXISTS live_gift_pockets (
      user_id UUID PRIMARY KEY,
      total_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_withdrawn NUMERIC(14,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS live_pocket_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      amount NUMERIC(14,2) NOT NULL,              -- debited from the pocket
      fee NUMERIC(14,2) NOT NULL DEFAULT 0,       -- admin-configured withdrawal fee
      net_amount NUMERIC(14,2) NOT NULL,          -- credited to the NGN wallet
      reference VARCHAR(80) UNIQUE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_pocket_withdrawals_user ON live_pocket_withdrawals(user_id, created_at DESC)`);

  // Raise-hand / "bring me on stage" requests. A viewer asks to join the
  // broadcast; the host approves → the viewer lands in cohost_ids (media
  // publishing unlocks) or declines. One row per (session, user) — a declined
  // request can be re-raised (status flips back to pending).
  await query(`
    CREATE TABLE IF NOT EXISTS live_join_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL,
      user_id UUID NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | approved | declined | cancelled
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT live_join_requests_pair UNIQUE (session_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_live_join_requests_session ON live_join_requests(session_id, status, created_at)`);

  // Gift split columns (commission goes to the platform, net to the host pocket)
  await query(`ALTER TABLE live_gifts ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE live_gifts ADD COLUMN IF NOT EXISTS host_amount NUMERIC(14,2) NOT NULL DEFAULT 0`);

  // Admin-configurable live economics (fees, gift prices, battle defaults)
  await query(`
    INSERT INTO system_settings (key, value, description)
    SELECT 'live_settings', $1::jsonb,
           'Livestream economics: gift prices, withdrawal fee, gift commission, battle defaults'
    WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'live_settings')
  `, [
    JSON.stringify({
      currency: "NGN",
      gift_prices: {},                 // { rose: 20, ... } — overrides the built-in catalog
      gift_commission_percent: 0,      // platform cut on every gift (0 = host keeps everything)
      withdrawal_fee_percent: 0,       // charged when withdrawing pocket → NGN wallet
      withdrawal_fee_flat: 0,          // flat component of the withdrawal fee
      withdrawal_min: 1000,            // minimum pocket withdrawal
      battle_duration_seconds: 300,    // default PK round length
      battle_multiplier: 2,            // gifting points multiplier during a battle (x2)
    }),
  ]);

  // Admin-configurable poll economics (vote price bounds + withdrawal fees)
  await query(`
    INSERT INTO system_settings (key, value, description)
    SELECT 'poll_settings', $1::jsonb,
           'Poll economics: default/max vote price, withdrawal fee (percent + flat) and minimum'
    WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'poll_settings')
  `, [
    JSON.stringify({
      currency: "NGN",
      default_vote_price: 100,     // pre-filled when a creator picks a paid poll
      min_vote_price: 20,          // per-vote floor
      max_vote_price: 100000,      // per-vote ceiling
      withdrawal_fee_percent: 10,  // charged at pool withdrawal → revenue ledger
      withdrawal_fee_flat: 0,      // flat component of the withdrawal fee
      withdrawal_min: 500,         // minimum pool withdrawal
    }),
  ]);

  // ------------------------------------------------------------------
  // 8. DONATIONS (fundraising)
  // ------------------------------------------------------------------
  // Users create fundraising campaigns; other users contribute from their NGN
  // wallet; the creator redeems the raised amount to their NGN wallet (the
  // admin-configured redemption fee lands in the platform revenue ledger).
  await query(`
    CREATE TABLE IF NOT EXISTS donations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      creator_id UUID NOT NULL,
      title VARCHAR(160) NOT NULL,
      description TEXT NOT NULL,
      cover_url TEXT,                       -- optional cover image
      category VARCHAR(40) NOT NULL DEFAULT 'other',
      goal_amount NUMERIC(14,2) NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
      deadline TIMESTAMP,                   -- optional end date
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | ended | suspended
      status_reason TEXT,
      amount_raised NUMERIC(14,2) NOT NULL DEFAULT 0,
      amount_redeemed NUMERIC(14,2) NOT NULL DEFAULT 0,
      redeemed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_donations_creator ON donations(creator_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_donations_category ON donations(category)`);

  await query(`
    CREATE TABLE IF NOT EXISTS donation_contributions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      donation_id UUID NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
      donor_id UUID NOT NULL,
      amount NUMERIC(14,2) NOT NULL,        -- debited from the donor's NGN wallet
      fee NUMERIC(14,2) NOT NULL DEFAULT 0, -- admin-configured contribution fee → revenue ledger
      net_amount NUMERIC(14,2) NOT NULL,    -- amount that lands in the fundraiser pool
      currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
      reference VARCHAR(80) UNIQUE NOT NULL,
      message TEXT,                          -- optional words of support
      anonymous BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_donation_contributions_donation ON donation_contributions(donation_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_donation_contributions_donor ON donation_contributions(donor_id, created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS donation_redemptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      donation_id UUID NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      amount NUMERIC(14,2) NOT NULL,        -- debited from the fundraiser pool
      fee NUMERIC(14,2) NOT NULL DEFAULT 0, -- admin-configured redemption fee → revenue ledger
      net_amount NUMERIC(14,2) NOT NULL,    -- credited to the creator's NGN wallet
      reference VARCHAR(80) UNIQUE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_donation_redemptions_user ON donation_redemptions(user_id, created_at DESC)`);

  // Admin-configurable donation economics (contribution bounds + fees)
  await query(`
    INSERT INTO system_settings (key, value, description)
    SELECT 'donation_settings', $1::jsonb,
           'Donation economics: contribution bounds + contribution/redemption fees (percent + flat), minimum redemption'
    WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'donation_settings')
  `, [
    JSON.stringify({
      currency: "NGN",
      min_donation: 100,           // per-contribution floor
      max_donation: 5000000,       // per-contribution ceiling
      contribution_fee_percent: 0, // charged on each contribution → revenue ledger (0 = donors give in full)
      contribution_fee_flat: 0,
      redemption_fee_percent: 5,   // charged at redemption → revenue ledger
      redemption_fee_flat: 0,
      redemption_min: 1000,        // minimum redemption amount
      max_active_per_user: 5,      // concurrent active fundraisers per creator
    }),
  ]);

  // ------------------------------------------------------------------
  // 8. SOCIAL GROUPS & PAGES (Facebook-style communities)
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS social_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(120) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      privacy VARCHAR(20) NOT NULL DEFAULT 'public', -- public | private
      cover_url TEXT,
      avatar_url TEXT,
      creator_id UUID NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | removed
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_groups_creator ON social_groups(creator_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_group_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'member',   -- owner | admin | member
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | pending
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_group_members_user ON social_group_members(user_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_pages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(120) NOT NULL,
      category VARCHAR(80) NOT NULL DEFAULT 'Business',
      description TEXT NOT NULL DEFAULT '',
      cover_url TEXT,
      avatar_url TEXT,
      owner_id UUID NOT NULL,
      follower_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | removed
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_pages_owner ON social_pages(owner_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS social_page_follows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id UUID NOT NULL REFERENCES social_pages(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_page_follows_user ON social_page_follows(user_id)`);

  // Group/page posts reuse the whole social post engine (reactions, comments,
  // media carousels, reports) via nullable container columns.
  await query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES social_groups(id) ON DELETE CASCADE`);
  await query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS page_id UUID REFERENCES social_pages(id) ON DELETE CASCADE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_posts_group ON social_posts(group_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_social_posts_page ON social_posts(page_id, created_at DESC)`);

  console.log("[Migrations] Personal (identity + bills + savings + social + live + marketplace + boosts + commerce + donations + groups/pages) schema applied");
}
