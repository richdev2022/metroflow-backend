-- Call duration tracking: timestamp from which the live call duration is
-- measured (stamped when the call actually starts being active, e.g. on
-- socket call:end / first participant join). The API (GET/PUT /calls) reads
-- and computes durations from this column — missing it makes every
-- /calls read fail with 42703 (undefined column).
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "duration_started_at" TIMESTAMP NULL;
