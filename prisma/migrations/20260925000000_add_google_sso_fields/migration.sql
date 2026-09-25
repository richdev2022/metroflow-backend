-- Add Google SSO support to users table
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "google_id" TEXT,
  ADD COLUMN IF NOT EXISTS "auth_provider" TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_key" ON "users"("google_id");

-- Index for faster provider lookups
CREATE INDEX IF NOT EXISTS "users_auth_provider_idx" ON "users"("auth_provider");
