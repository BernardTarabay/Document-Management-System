-- Email inbox triage feature: connect a Gmail/Outlook account, auto-sync
-- and classify incoming mail, auto-trash junk, surface the rest as a
-- curated "Inbox" view. See docs/10-email-inbox.md for the full design.
--
-- ADD VALUE IF NOT EXISTS is safe inside migrate.js's per-migration
-- transaction on Postgres 12+ as long as the new value isn't used in the
-- SAME transaction -- see the note in 014_bulk_delete.sql. Same reasoning
-- applies to every ADD VALUE below.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'email_sync';

DO $$ BEGIN
  CREATE TYPE email_provider AS ENUM ('gmail', 'outlook');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE email_account_status AS ENUM ('connected', 'disconnected', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE inbox_message_classification AS ENUM ('important', 'junk');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE inbox_message_status AS ENUM ('kept', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per connected mailbox. Deliberately stores only the REFRESH
-- token (encrypted at rest, see utils/tokenCrypto.js) -- an access token is
-- exchanged on demand at the start of each sync and kept only in memory
-- for that run, never persisted, so there's one fewer credential sitting
-- in the database at any given time.
CREATE TABLE IF NOT EXISTS email_accounts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                  email_provider NOT NULL,
  email_address             TEXT NOT NULL,
  status                    email_account_status NOT NULL DEFAULT 'connected',
  refresh_token_encrypted   TEXT,  -- NULL once disconnected (see emailAccountService.disconnect)
  scopes                    TEXT,
  -- Provider-specific incremental-sync cursor: Gmail's historyId or
  -- Outlook/Graph's deltaLink. NULL means "never synced" -- the first sync
  -- does a bounded initial listing instead of a delta fetch.
  sync_cursor               TEXT,
  last_synced_at            TIMESTAMPTZ,
  last_error                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_email_accounts_provider_address UNIQUE (provider, email_address)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_user_id ON email_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_status ON email_accounts(status) WHERE status = 'connected';

-- The curated/triaged view. A 'deleted' row is NOT erased when the
-- underlying message is trashed -- it's kept exactly like every other
-- "history is additive" table in this schema, so there's always an
-- auditable answer to "what did the auto-triage actually remove."
CREATE TABLE IF NOT EXISTS inbox_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id      UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider_message_id   TEXT NOT NULL,
  thread_id             TEXT,
  from_address          TEXT,
  from_name             TEXT,
  subject               TEXT,
  snippet               TEXT,
  received_at           TIMESTAMPTZ,
  has_attachments       BOOLEAN NOT NULL DEFAULT false,
  classification        inbox_message_classification NOT NULL,
  -- 'rule' | 'ai' -- which tier decided (docs/10-email-inbox.md) -- plain
  -- text (not an enum) since it's informational metadata, not something
  -- other rows join against.
  classification_method TEXT NOT NULL,
  confidence_level       confidence_level,
  status                inbox_message_status NOT NULL DEFAULT 'kept',
  -- Deep link back to the provider's own web UI (Gmail's permalink shape,
  -- or Graph's own `webLink` field for Outlook) -- opening a message
  -- always leaves the actual mailbox, never renders the body in-app.
  provider_web_link     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inbox_messages_account_message UNIQUE (email_account_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_account_id ON inbox_messages(email_account_id);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_received_at ON inbox_messages(received_at DESC);

-- Migration 011's bulk "apply set_updated_at to every table with the
-- column" DO block already ran (it only walks tables that existed at that
-- point in time) -- a table added in a later migration needs its own
-- trigger wired up explicitly, same as this.
DROP TRIGGER IF EXISTS trg_set_updated_at ON email_accounts;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
