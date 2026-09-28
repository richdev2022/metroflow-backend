-- User-configurable timezone for date/time display across the app.
-- Defaults to UTC; clients send IANA names (e.g. "Africa/Lagos").
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'UTC';
