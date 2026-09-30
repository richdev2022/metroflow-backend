-- Multi-provider calling architecture (LiveKit + MediaSoup)
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "provider" VARCHAR(20);
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "provider" VARCHAR(20);

CREATE TABLE IF NOT EXISTS "meeting_transcripts" (
    "id" UUID PRIMARY KEY,
    "meeting_id" UUID NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
    "speaker_id" VARCHAR(200),
    "speaker_name" VARCHAR(120),
    "text" TEXT NOT NULL,
    "language" VARCHAR(20),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_meeting_transcripts_meeting" ON "meeting_transcripts"("meeting_id", "created_at");

CREATE TABLE IF NOT EXISTS "meeting_notes" (
    "id" UUID PRIMARY KEY,
    "meeting_id" UUID NOT NULL UNIQUE REFERENCES "meetings"("id") ON DELETE CASCADE,
    "summary" TEXT,
    "key_points" JSONB DEFAULT '[]'::jsonb,
    "decisions" JSONB DEFAULT '[]'::jsonb,
    "action_items" JSONB DEFAULT '[]'::jsonb,
    "important_timestamps" JSONB DEFAULT '[]'::jsonb,
    "model" VARCHAR(100),
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
