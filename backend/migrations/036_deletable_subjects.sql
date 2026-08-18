-- A folder you no longer want can actually be deleted.
--
-- THE PROBLEM
--
-- `classification_results.classified_subject_id` referenced `subjects` with NO
-- ACTION, so a folder that had EVER held a file could not be dropped -- not
-- even one whose files had long since been moved elsewhere. The application
-- caught the resulting constraint error and told the user:
--
--   "Photos can't be deleted -- files have been filed under it in the past and
--    that history is kept for audit purposes. Rename it instead, or leave it in
--    place unused."
--
-- Which is not an answer to "I do not want this folder". It is the system
-- refusing on grounds the user cannot act on, and offering a workaround --
-- rename it -- that leaves the clutter in place under a different name. On a
-- library whose whole premise is that the tree is the USER'S, a folder that
-- cannot be removed is a folder the software owns.
--
-- WHAT REPLACES IT
--
-- ON DELETE SET NULL. Deleting a folder nulls the pointer on historical
-- classification rows; the rows themselves survive, with their method,
-- confidence, timestamps and raw model output intact. So the audit record that
-- actually mattered -- "this file was classified at this time, this way, with
-- this confidence" -- is kept. What is dropped is a reference to a folder that
-- no longer exists, which could not have been honoured anyway.
--
-- The consequence for current placement is the correct one and needs no extra
-- code: every consumer resolves a file's folder as "the latest classification
-- row" (repositories/fileFilters.js), so a file whose folder is deleted has a
-- latest row naming no subject, which is precisely the definition of unfiled.
-- The files reappear in the Unfiled pile rather than pointing at nothing.
--
-- `subjects.parent_id` is already ON DELETE CASCADE, so removing a folder
-- removes the branch beneath it in one statement. The service layer decides
-- whether that is allowed to happen silently -- see subjectService.remove,
-- which still refuses by default and requires an explicit confirmation that
-- names how many folders and documents are affected.
--
-- document_subjects.subject_id is left RESTRICT deliberately: that table
-- belongs to the older `documents` model, is not written by this pipeline, and
-- is empty. Loosening a constraint on a table nothing populates would be
-- widening the blast radius for no benefit.

ALTER TABLE classification_results
  DROP CONSTRAINT IF EXISTS classification_results_classified_subject_id_fkey;

ALTER TABLE classification_results
  ADD CONSTRAINT classification_results_classified_subject_id_fkey
  FOREIGN KEY (classified_subject_id) REFERENCES subjects(id) ON DELETE SET NULL;
