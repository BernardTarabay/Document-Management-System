-- Make "one EXACT duplicate group per content hash" a rule the database
-- enforces, rather than a property the application hopes for.
--
-- THE RACE THIS CLOSES
--
-- detectDuplicatesProcessor.detectExact looked for an existing group, found
-- none, and created one. Two files with identical bytes hash in parallel (the
-- hash queue runs four wide), both call detectExact, both see no group, and
-- both create one. The result was TWO open exact groups describing the same
-- set of bytes: the Duplicates page listed the pair twice, the reclaimable-
-- bytes figure double-counted it, and auto-resolve wrote a canonical decision
-- for each of them.
--
-- Nothing in the schema prevented it -- duplicate_group_members was unique on
-- (group, file), which says a file appears once WITHIN a group and nothing at
-- all about how many groups exist.
--
-- content_key is the sha256 for an exact group. A partial unique index on it
-- means the second concurrent insert loses, and the loser can simply take the
-- winner's row (ON CONFLICT ... DO UPDATE ... RETURNING). Probable groups are
-- excluded: they are similarity judgements, not a property of one hash, and
-- several of them can legitimately exist.

ALTER TABLE duplicate_groups
  ADD COLUMN IF NOT EXISTS content_key TEXT;

COMMENT ON COLUMN duplicate_groups.content_key IS
  'For exact groups: the shared sha256. NULL for probable groups. Unique among exact groups.';

-- Backfill from the members' shared hash so existing exact groups participate
-- in the constraint rather than sitting outside it.
UPDATE duplicate_groups dg
   SET content_key = sub.sha256_hash
  FROM (
    SELECT dgm.duplicate_group_id, min(f.sha256_hash) AS sha256_hash
      FROM duplicate_group_members dgm
      JOIN files f ON f.id = dgm.file_id
     WHERE f.sha256_hash IS NOT NULL
     GROUP BY dgm.duplicate_group_id
    HAVING count(DISTINCT f.sha256_hash) = 1
  ) sub
 WHERE dg.id = sub.duplicate_group_id
   AND dg.group_type = 'exact'
   AND dg.content_key IS NULL;

-- Collapse any duplicate exact groups that already exist, so the unique index
-- below can be created. Members are moved onto the oldest group for the hash;
-- the emptied groups are then removed. Runs before the index, and is a no-op
-- on a database that never hit the race.
WITH ranked AS (
  SELECT id, content_key,
         row_number() OVER (PARTITION BY content_key ORDER BY created_at, id) AS rn,
         first_value(id) OVER (PARTITION BY content_key ORDER BY created_at, id) AS keep_id
    FROM duplicate_groups
   WHERE group_type = 'exact' AND content_key IS NOT NULL
)
UPDATE duplicate_group_members dgm
   SET duplicate_group_id = ranked.keep_id
  FROM ranked
 WHERE dgm.duplicate_group_id = ranked.id
   AND ranked.rn > 1
   -- Skip where the file is already a member of the surviving group, or the
   -- move would violate uq_duplicate_group_members.
   AND NOT EXISTS (
     SELECT 1 FROM duplicate_group_members existing
      WHERE existing.duplicate_group_id = ranked.keep_id
        AND existing.file_id = dgm.file_id
   );

DELETE FROM duplicate_groups dg
 WHERE dg.group_type = 'exact'
   AND dg.content_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM duplicate_group_members m WHERE m.duplicate_group_id = dg.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_duplicate_groups_exact_content_key
  ON duplicate_groups(content_key)
  WHERE group_type = 'exact' AND content_key IS NOT NULL;
