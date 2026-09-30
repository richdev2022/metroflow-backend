-- Server-side (LiveKit Egress) recording tracking on the shared recordings table.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS egress_id TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS provider VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_recordings_egress ON recordings(egress_id) WHERE egress_id IS NOT NULL;
