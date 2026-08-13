-- Phase 5: identity, RBAC, JWT lifecycle

-- users.email uses citext for case-insensitive uniqueness/lookup.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             CITEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  status            user_status NOT NULL DEFAULT 'active',
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT UNIQUE NOT NULL,          -- Admin, Manager, User, Viewer
  description       TEXT,
  is_system_role    BOOLEAN NOT NULL DEFAULT false, -- protects seed roles from deletion
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key               TEXT UNIQUE NOT NULL,          -- e.g. 'document.rename', 'duplicate.merge'
  description       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id           UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id     UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id           UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by        UUID REFERENCES users(id),
  PRIMARY KEY (user_id, role_id)
);

-- Refresh token lifecycle: JWT access tokens stay short-lived and stateless;
-- refresh tokens are stored (hashed) so they can be revoked/rotated server-side.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  replaced_by_token_id UUID REFERENCES refresh_tokens(id),
  ip_address        INET,
  user_agent        TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON role_permissions(permission_id);
