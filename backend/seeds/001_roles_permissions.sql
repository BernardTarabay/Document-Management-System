-- Baseline RBAC. Idempotent (ON CONFLICT DO NOTHING) so it can be re-run safely.

INSERT INTO roles (name, description, is_system_role) VALUES
  ('Admin',   'Full system access, including user/role management and audit logs', true),
  ('Manager', 'Can approve bulk operations, manage duplicates/classifications', true),
  ('User',    'Can upload, browse, search, and propose changes for review', true),
  ('Viewer',  'Read-only access to documents and search', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
  ('document.view',            'View documents and their metadata'),
  ('document.download',        'Download original files'),
  ('document.upload',          'Upload / import new files'),
  ('document.rename',          'Apply rename proposals'),
  ('document.move',            'Move files between locations/paths'),
  ('document.delete',          'Delete (archive) documents'),
  ('document.restore',         'Restore archived/deleted documents'),
  ('duplicate.manage',         'Review, merge, and resolve duplicate groups'),
  ('classification.modify',    'Modify subject/category/tag assignments'),
  ('subject.manage',           'Create, rename, and delete taxonomy subjects/categories'),
  ('email.manage',             'Connect/disconnect email accounts and manage the Inbox page'),
  ('agent.manage',             'Register, revoke, and monitor Filesystem Agents'),
  ('scan.run',                 'Trigger repository scans'),
  ('bulk.approve',             'Approve bulk operations'),
  ('user.manage',              'Create/edit/deactivate users'),
  ('role.manage',              'Create/edit roles and permissions'),
  ('audit.view',               'View audit logs'),
  ('audit.manage',              'Clear/purge the audit log')
ON CONFLICT (key) DO NOTHING;

-- Admin: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;

-- Manager: everything except user/role management.
-- agent.manage is excluded alongside them deliberately: registering a
-- Filesystem Agent mints a long-lived credential that brokers filesystem
-- operations on a machine the backend cannot otherwise reach
-- (docs/04-storage-architecture.md §4.5). That is an administrative trust
-- decision, not day-to-day document management.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Manager' AND p.key NOT IN ('user.manage', 'role.manage', 'audit.manage', 'agent.manage')
ON CONFLICT DO NOTHING;

-- User: view/download/upload + propose (rename/classify are proposal-only at the
-- service layer regardless of this table; this grants the ability to submit them)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'User' AND p.key IN (
  'document.view', 'document.download', 'document.upload', 'classification.modify'
)
ON CONFLICT DO NOTHING;

-- Viewer: read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Viewer' AND p.key IN ('document.view', 'document.download')
ON CONFLICT DO NOTHING;
