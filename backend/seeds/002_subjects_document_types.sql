-- Illustrative starter taxonomy (docs/03-taxonomy.md §3.3). Deployments are
-- expected to edit/replace this seed for their own repository -- it is data,
-- not schema.

-- Subjects (top level)
INSERT INTO subjects (level, name, slug, materialized_path) VALUES
  ('subject', 'Finance', 'finance', 'finance'),
  ('subject', 'Academic', 'academic', 'academic'),
  ('subject', 'Administrative', 'administrative', 'administrative'),
  ('subject', 'Personal', 'personal', 'personal'),
  ('subject', 'Legal', 'legal', 'legal')
ON CONFLICT (slug) WHERE parent_id IS NULL DO NOTHING;

-- Categories under Finance
INSERT INTO subjects (parent_id, level, name, slug, materialized_path)
SELECT id, 'category', v.name, v.slug, materialized_path || '.' || v.slug
FROM subjects, (VALUES
  ('Budgets', 'budgets'), ('Taxes', 'taxes'), ('Invoices', 'invoices'), ('Reports', 'reports')
) AS v(name, slug)
WHERE subjects.slug = 'finance' AND subjects.parent_id IS NULL
ON CONFLICT (parent_id, slug) DO NOTHING;

-- Categories under Academic
INSERT INTO subjects (parent_id, level, name, slug, materialized_path)
SELECT id, 'category', v.name, v.slug, materialized_path || '.' || v.slug
FROM subjects, (VALUES
  ('Courses', 'courses'), ('Research', 'research'), ('Exams', 'exams'), ('Projects', 'projects')
) AS v(name, slug)
WHERE subjects.slug = 'academic' AND subjects.parent_id IS NULL
ON CONFLICT (parent_id, slug) DO NOTHING;

-- Categories under Administrative
INSERT INTO subjects (parent_id, level, name, slug, materialized_path)
SELECT id, 'category', v.name, v.slug, materialized_path || '.' || v.slug
FROM subjects, (VALUES
  ('Government', 'government'), ('Applications', 'applications'),
  ('Certificates', 'certificates'), ('Legal', 'legal')
) AS v(name, slug)
WHERE subjects.slug = 'administrative' AND subjects.parent_id IS NULL
ON CONFLICT (parent_id, slug) DO NOTHING;

-- Reference material (added after a real-world misclassification: a user
-- manual had no reasonable home in the original taxonomy and, on a single
-- incidental keyword hit, got force-matched into Administrative >
-- Certificates instead -- see classifyProcessor.js / namingService.js for
-- the scoring/naming-side fixes, this is the taxonomy-coverage side of it).
INSERT INTO subjects (level, name, slug, materialized_path) VALUES
  ('subject', 'Reference', 'reference', 'reference')
ON CONFLICT (slug) WHERE parent_id IS NULL DO NOTHING;

INSERT INTO subjects (parent_id, level, name, slug, materialized_path)
SELECT id, 'category', v.name, v.slug, materialized_path || '.' || v.slug
FROM subjects, (VALUES
  ('Manuals', 'manuals'), ('Guides', 'guides'), ('Books', 'books')
) AS v(name, slug)
WHERE subjects.slug = 'reference' AND subjects.parent_id IS NULL
ON CONFLICT (parent_id, slug) DO NOTHING;

-- Document types (orthogonal to subject; see docs/03-taxonomy.md §3.4)
INSERT INTO document_types (code, name, description) VALUES
  ('AnnualBudget',      'Annual Budget',        'Yearly budget document'),
  ('Invoice',           'Invoice',              'Billing document from or to a vendor/client'),
  ('TaxReturn',         'Tax Return',           'Filed tax return or supporting schedule'),
  ('Report',            'Report',               'General narrative or analytical report'),
  ('SpreadsheetModel',  'Spreadsheet Model',    'Structured financial/operational model'),
  ('Presentation',      'Presentation',         'Slide deck'),
  ('Certificate',       'Certificate',          'Issued certificate or credential'),
  ('Contract',          'Contract',             'Legal agreement between parties'),
  ('Exam',               'Exam',                 'Academic exam or assessment'),
  ('CourseMaterial',     'Course Material',      'Syllabus, notes, or coursework'),
  ('Correspondence',     'Correspondence',       'Letters, memos, official correspondence'),
  ('Manual',             'Manual / Guide',       'User manual, instruction guide, or how-to documentation'),
  ('Book',               'Book',                 'Book, ebook, or other long-form reference text')
ON CONFLICT (code) DO NOTHING;
