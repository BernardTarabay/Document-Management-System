-- Subjects stop being a fixed three-level taxonomy.
--
-- WHY
--
-- The tree was Subject -> Category -> Subcategory, exactly three levels, and
-- new accounts inherited six seeded Subjects (Academic, Administrative,
-- Finance, Legal, Personal, Reference). Both were load-bearing assumptions in
-- the classifier: every document had to land in one of those buckets, so a
-- set of insurance papers became "Administrative, because it's the closest
-- one". A taxonomy that cannot say "this doesn't fit" produces filing nobody
-- trusts, and the fix is not a better prompt -- it is letting the tree grow.
--
-- WHAT CHANGES
--
--  * `depth` replaces `level` as the structural fact. `level` is kept and
--    still maintained (subject/category/subcategory for depths 0/1/2+) so the
--    existing enum, queries and UI keep working unchanged -- nothing reads a
--    level that stops being written.
--  * Nesting is no longer capped. A folder can sit as deep as the documents
--    warrant.
--  * `created_by_ai` records that a folder was the assistant's idea, so the
--    UI can say so rather than presenting a machine's guess as the user's own
--    structure.
--
-- The seeded six are NOT deleted -- they are useful defaults and some are in
-- use. They simply stop being the only options, and they are now deletable
-- like any other folder.

ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS depth        INTEGER NOT NULL DEFAULT 0,
  -- 'user' | 'ai' | 'seed'. Who decided this folder should exist.
  ADD COLUMN IF NOT EXISTS origin       TEXT NOT NULL DEFAULT 'user',
  -- Set when the assistant proposed the folder and a human accepted it, so
  -- "you created this" and "you approved this" stay distinguishable.
  ADD COLUMN IF NOT EXISTS ai_rationale TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Backfill depth from the materialized path already maintained by the
-- trg_subject_materialized_path trigger: 'finance' -> 0, 'finance.taxes' -> 1.
UPDATE subjects
   SET depth = length(materialized_path) - length(replace(materialized_path, '.', ''))
 WHERE depth = 0 AND materialized_path LIKE '%.%';

UPDATE subjects SET origin = 'seed'
 WHERE materialized_path IN (
   'academic','administrative','finance','legal','personal','reference',
   'academic.courses','academic.exams','academic.projects','academic.research',
   'administrative.applications','administrative.certificates',
   'administrative.government','administrative.legal',
   'finance.budgets','finance.invoices','finance.reports','finance.taxes',
   'reference.books','reference.guides','reference.manuals'
 );

-- Depth and level are derived from the parent, in the same trigger that
-- already derives materialized_path -- one place decides a row's position in
-- the tree, so they cannot disagree.
CREATE OR REPLACE FUNCTION set_subject_materialized_path()
RETURNS TRIGGER AS $$
DECLARE
  parent_path  TEXT;
  parent_depth INTEGER;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.materialized_path := NEW.slug;
    NEW.depth := 0;
  ELSE
    SELECT materialized_path, depth INTO parent_path, parent_depth
      FROM subjects WHERE id = NEW.parent_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'parent subject % does not exist', NEW.parent_id;
    END IF;
    NEW.materialized_path := parent_path || '.' || NEW.slug;
    NEW.depth := parent_depth + 1;
  END IF;

  -- `level` is now a projection of depth, kept for the enum's existing
  -- readers. Anything below the third tier is reported as 'subcategory'
  -- because the enum has no deeper name -- depth is the honest number.
  NEW.level := CASE NEW.depth WHEN 0 THEN 'subject' WHEN 1 THEN 'category'
                              ELSE 'subcategory' END::subject_level;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subject_materialized_path ON subjects;
CREATE TRIGGER trg_subject_materialized_path
  BEFORE INSERT OR UPDATE OF parent_id, slug ON subjects
  FOR EACH ROW EXECUTE FUNCTION set_subject_materialized_path();

CREATE INDEX IF NOT EXISTS idx_subjects_owner_depth ON subjects(owner_user_id, depth);
CREATE INDEX IF NOT EXISTS idx_subjects_owner_recent
  ON subjects(owner_user_id, last_used_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- Duplicate groups: the exact-content key becomes per-owner
-- ---------------------------------------------------------------------------
--
-- migration 027 made content_key globally unique among exact groups, which
-- was right when there was one corpus. With ownership it is a cross-tenant
-- collision: two accounts that both hold the same PDF would fight over one
-- group row, and the loser's copy would be filed into a stranger's group.

DROP INDEX IF EXISTS uq_duplicate_groups_exact_content_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_duplicate_groups_owner_content_key
  ON duplicate_groups(owner_user_id, content_key)
  WHERE group_type = 'exact' AND content_key IS NOT NULL;
