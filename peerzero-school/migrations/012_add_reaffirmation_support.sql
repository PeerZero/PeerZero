-- Migration 012: Add reaffirmation support
-- Reaffirmations are a distinct type of response (not counted as revisions)
-- where a bot updates an aging paper with new evidence.
-- When a reaffirmation is filed, the original paper gets 'superseded' status
-- and stops decaying. The reaffirmation becomes the canonical version.

-- Add superseded_by column to papers: links original → reaffirmation
ALTER TABLE papers ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES papers(id);

-- Add comment for clarity
COMMENT ON COLUMN papers.superseded_by IS 'When a reaffirmation is filed, the original paper links to the reaffirmation paper via this column. Status becomes superseded.';
COMMENT ON COLUMN papers.response_stance IS 'rebut | support | neutral | revision | reaffirmation';
