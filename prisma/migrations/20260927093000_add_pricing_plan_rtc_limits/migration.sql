-- RTC / capacity limit columns on pricing_plans.
--
-- The base migration (20260708085840_add_meeting_chat_call_models) created
-- pricing_plans BEFORE these columns were added to schema.prisma, and no
-- follow-up migration ever existed. Any environment provisioned with
-- `prisma migrate deploy` was therefore missing them — every query that
-- selects pricing_plans.max_meeting_duration / max_participants failed with
-- 42703 (undefined column), which surfaced as:
--   POST /calls        -> 500 "Failed to create call"
--   POST /calls/:id/join / leave -> 500
--   call:join / meeting:join socket handlers -> "Failed to join call"
--
-- Idempotent so it can run against databases that already have the columns
-- (e.g. provisioned via `prisma db push`).
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "max_meeting_duration" INTEGER;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "max_participants" INTEGER;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "max_recording_duration" INTEGER;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "max_recording_storage" INTEGER;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "waiting_room_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "recording_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "screen_sharing_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "breakout_rooms_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "virtual_backgrounds" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pricing_plans" ADD COLUMN IF NOT EXISTS "live_captions" BOOLEAN NOT NULL DEFAULT false;
