-- Phase 5: cross-cutting search support + updated_at maintenance triggers

-- Generic "touch updated_at" trigger, applied to every table that has the column.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;
       CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t
    );
  END LOOP;
END $$;

-- Materialized-path maintenance for subjects: recompute on insert/update of parent_id.
CREATE OR REPLACE FUNCTION set_subject_materialized_path()
RETURNS TRIGGER AS $$
DECLARE
  parent_path TEXT;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.materialized_path := NEW.slug;
  ELSE
    SELECT materialized_path INTO parent_path FROM subjects WHERE id = NEW.parent_id;
    NEW.materialized_path := parent_path || '.' || NEW.slug;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subject_materialized_path ON subjects;
CREATE TRIGGER trg_subject_materialized_path
  BEFORE INSERT OR UPDATE OF parent_id, slug ON subjects
  FOR EACH ROW EXECUTE FUNCTION set_subject_materialized_path();
