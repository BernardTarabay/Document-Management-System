-- Indexes and housekeeping for paths that are hit on every request or every
-- page load, plus the integrity constraint that makes refresh-token rotation
-- safe to do atomically (see services/authService.refresh).

-- ---------------------------------------------------------------------------
-- refresh_tokens.token_hash
-- ---------------------------------------------------------------------------
-- Every /auth/refresh looks a token up by its hash, and 002 indexed only
-- user_id -- so the lookup was a sequential scan of a table that is only ever
-- appended to. Nothing ever deleted from it either: a single-user install had
-- accumulated 98 rows, most of them long expired, and that number only grows
-- (a new row per login and per rotation, i.e. potentially every 15 minutes).
--
-- UNIQUE rather than a plain index because the value is 48 bytes of
-- crypto.randomBytes and a repeat is not a thing that happens -- so this is
-- free, and it turns "two rows share a token hash" from an invisible
-- corruption into an error at the moment it is written. authService's rotation
-- relies on a hash identifying at most one row.
--
-- Defensive dedupe first: creating the index would fail on any pre-existing
-- duplicate and roll the whole migration back. Keeps the newest row per hash.
DELETE FROM refresh_tokens a
 USING refresh_tokens b
 WHERE a.token_hash = b.token_hash
   AND a.issued_at < b.issued_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_tokens_token_hash
  ON refresh_tokens(token_hash);

-- One-off cleanup of tokens that can never authenticate anyone again: expired,
-- or revoked more than 30 days ago. Kept as a bounded window rather than
-- "delete everything revoked" so a recent rotation chain stays inspectable if
-- someone is investigating a session. Ongoing pruning happens in
-- refreshTokenRepository.pruneExpired, called at login.
DELETE FROM refresh_tokens
 WHERE expires_at < now() - interval '30 days'
    OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days');

-- ---------------------------------------------------------------------------
-- files.imported_at
-- ---------------------------------------------------------------------------
-- The Files page's default listing (fileRepository.listNotDeleted) and the
-- filename search both end in `ORDER BY f.imported_at DESC LIMIT n`, and
-- nothing indexed that column -- so every page load sorted the whole table to
-- return 25 rows. Partial, matching the queries' own `status != 'deleted'`, so
-- it stays small and is usable by exactly the reads that need it.
CREATE INDEX IF NOT EXISTS idx_files_imported_at
  ON files(imported_at DESC)
  WHERE status <> 'deleted';

-- ---------------------------------------------------------------------------
-- rename_proposals (file_id, status)
-- ---------------------------------------------------------------------------
-- 009 indexed file_id and status separately, but the two hot lookups
-- (renameProposalRepository.findPendingForFile and findRejectedMatch, both run
-- per file by generateNamesProcessor) filter on the pair.
CREATE INDEX IF NOT EXISTS idx_rename_proposals_file_status
  ON rename_proposals(file_id, status);
