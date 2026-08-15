-- Persistent AI conversations, and the memory the pre-move duplicate guard
-- needs in order to stop nagging.

-- ---------------------------------------------------------------------------
-- 1. Conversations
-- ---------------------------------------------------------------------------
--
-- The assistant was stateless: the frontend kept the last few turns in React
-- state and posted them back, so closing the tab ended the conversation and
-- nothing was ever recoverable. Anything the assistant worked out with you
-- about how your documents should be filed was gone by the next visit.
--
-- Conversations belong to a user, full stop. There is no sharing model here
-- and no "public" flag to get wrong -- every read is scoped by owner, and the
-- one query that fetches a conversation takes the owner as a parameter rather
-- than checking ownership after the fact.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Auto-derived from the opening message, renameable by the user.
  title          TEXT NOT NULL DEFAULT 'New conversation',
  title_is_auto  BOOLEAN NOT NULL DEFAULT true,
  archived_at    TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_recent
  ON ai_conversations(owner_user_id, last_message_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- The actions the assistant proposed on this turn, as returned. Stored so
  -- reopening a conversation shows what was suggested AND whether it was
  -- applied -- a transcript that silently drops the proposals is a transcript
  -- of half the conversation.
  actions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which files/subjects were in scope when this turn was sent, so "it said
  -- that about which document?" has an answer later.
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
  ON ai_messages(conversation_id, created_at ASC);

-- Search over your own conversations. English-only stemming would be wrong
-- for this corpus (the documents, and therefore the questions about them, are
-- largely French and Arabic), so 'simple' is used: no stemming, no stop-word
-- list, exact token matching in every script.
CREATE INDEX IF NOT EXISTS idx_ai_messages_search
  ON ai_messages USING gin (to_tsvector('simple', content));

-- ---------------------------------------------------------------------------
-- 2. "These are not duplicates" -- remembered
-- ---------------------------------------------------------------------------
--
-- The pre-move guard compares an incoming file against what is already filed
-- and refuses to let a duplicate slip silently into the Subjects tree. Useful
-- exactly once per pair: if the user looks at both, decides they are
-- genuinely different documents, and says "keep both", asking again on the
-- next move is not caution, it is noise -- and noise is what trains people to
-- click through the warning that mattered.
--
-- The pair is stored with the lower id first so (A,B) and (B,A) are one row
-- and one lookup.

CREATE TABLE IF NOT EXISTS duplicate_dismissals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id_a      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  file_id_b      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  -- 'distinct'  -- different documents that happen to look alike
  -- 'version'   -- same document, different revision; both are kept on purpose
  relationship   TEXT NOT NULL DEFAULT 'distinct',
  note           TEXT,
  decided_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_duplicate_dismissals_ordered CHECK (file_id_a < file_id_b),
  CONSTRAINT uq_duplicate_dismissals_pair UNIQUE (file_id_a, file_id_b)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_dismissals_owner
  ON duplicate_dismissals(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_dismissals_b ON duplicate_dismissals(file_id_b);

-- ---------------------------------------------------------------------------
-- 3. How a file came to be where it is
-- ---------------------------------------------------------------------------
--
-- Requirement: the user must be able to tell an AI suggestion from their own
-- choice from something applied automatically. That is a property of the
-- PLACEMENT, so it is recorded on the file rather than inferred from whichever
-- audit row happens to be most recent.

ALTER TABLE files
  -- 'user' | 'ai_suggested' | 'ai_auto' | 'rule' | NULL (not yet filed)
  ADD COLUMN IF NOT EXISTS placement_source TEXT,
  ADD COLUMN IF NOT EXISTS placement_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS placement_note   TEXT;

COMMENT ON COLUMN files.placement_source IS
  'Who decided this file belongs where it is: user (chose it), ai_suggested (AI proposed, human accepted), ai_auto (applied without review under an explicit opt-in), rule (deterministic classifier).';
