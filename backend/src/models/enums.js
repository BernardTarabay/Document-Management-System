// JS-side mirrors of the Postgres enum types defined in
// backend/migrations/001_extensions.sql. Centralizing these avoids magic
// strings scattered across services/controllers/validators.

const UserStatus = Object.freeze({ ACTIVE: "active", SUSPENDED: "suspended", INVITED: "invited" });

const ConfidenceLevel = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });

const StorageType = Object.freeze({
  LOCAL: "local", NAS: "nas", SERVER: "server", MANAGED: "managed", CLOUD: "cloud",
});

const StorageAccessMode = Object.freeze({ DIRECT: "direct", AGENT: "agent" });

const AgentStatus = Object.freeze({ ONLINE: "online", OFFLINE: "offline" });

const FileStatus = Object.freeze({
  ACTIVE: "active", MISSING: "missing", MOVED: "moved",
  CHANGED: "changed", DELETED: "deleted", ARCHIVED: "archived",
});

const ProcessingStatus = Object.freeze({
  PENDING: "pending", PROCESSING: "processing", COMPLETED: "completed",
  FAILED: "failed", SKIPPED: "skipped",
});

const DocumentStatus = Object.freeze({ ACTIVE: "active", ARCHIVED: "archived", DELETED: "deleted" });

const VersionStatus = Object.freeze({ DRAFT: "draft", CONFIRMED: "confirmed", SUPERSEDED: "superseded" });

const DetectionMethod = Object.freeze({
  MANUAL: "manual", FILENAME_HEURISTIC: "filename_heuristic",
  CONTENT_SIMILARITY: "content_similarity", METADATA: "metadata",
  HASH: "hash", USER_CONFIRMED: "user_confirmed",
});

const RelevanceType = Object.freeze({ PRIMARY: "primary", SECONDARY: "secondary" });

const AssignedByType = Object.freeze({ SYSTEM: "system", USER: "user" });

const RelatedDocRelationship = Object.freeze({
  RELATED: "related", SUPERSEDES: "supersedes", REFERENCES: "references",
});

const DuplicateGroupType = Object.freeze({ EXACT: "exact", PROBABLE: "probable" });

const DuplicateGroupStatus = Object.freeze({ OPEN: "open", REVIEWED: "reviewed", RESOLVED: "resolved" });

const JobType = Object.freeze({
  SCAN: "scan", HASH: "hash", EXTRACT_METADATA: "extract_metadata",
  EXTRACT_TEXT: "extract_text", CLASSIFY: "classify",
  DETECT_DUPLICATES: "detect_duplicates", DETECT_VERSIONS: "detect_versions",
  GENERATE_NAMES: "generate_names", BULK_RENAME: "bulk_rename",
  BULK_MOVE: "bulk_move", REINDEX: "reindex", BULK_DELETE: "bulk_delete",
  AUTO_RESOLVE_DUPLICATES: "auto_resolve_duplicates", EMAIL_SYNC: "email_sync",
  SYNC_MIRROR: "sync_mirror",
});

const JobStatus = Object.freeze({
  QUEUED: "queued", RUNNING: "running", COMPLETED: "completed",
  FAILED: "failed", CANCELLED: "cancelled", RETRYING: "retrying",
});

const JobItemStatus = Object.freeze({
  PENDING: "pending", SUCCEEDED: "succeeded", FAILED: "failed", SKIPPED: "skipped",
});

const ProposalStatus = Object.freeze({
  PENDING: "pending", APPROVED: "approved", REJECTED: "rejected",
  APPLIED: "applied", SUPERSEDED: "superseded",
});

const ClassificationStatus = Object.freeze({
  PROPOSED: "proposed", CONFIRMED: "confirmed", REJECTED: "rejected",
});

const ClassificationMethod = Object.freeze({ RULE: "rule", ML: "ml", LLM: "llm", MANUAL: "manual" });

const AuditStatus = Object.freeze({ SUCCESS: "success", FAILED: "failed" });

const SubjectLevel = Object.freeze({ SUBJECT: "subject", CATEGORY: "category", SUBCATEGORY: "subcategory" });

const EmailProvider = Object.freeze({ GMAIL: "gmail", OUTLOOK: "outlook" });

const EmailAccountStatus = Object.freeze({ CONNECTED: "connected", DISCONNECTED: "disconnected", ERROR: "error" });

const InboxMessageClassification = Object.freeze({ IMPORTANT: "important", JUNK: "junk" });

const InboxMessageStatus = Object.freeze({ KEPT: "kept", DELETED: "deleted" });

module.exports = {
  UserStatus, ConfidenceLevel, StorageType, StorageAccessMode, AgentStatus,
  FileStatus, ProcessingStatus, DocumentStatus, VersionStatus, DetectionMethod,
  RelevanceType, AssignedByType, RelatedDocRelationship, DuplicateGroupType,
  DuplicateGroupStatus, JobType, JobStatus, JobItemStatus, ProposalStatus,
  ClassificationStatus, ClassificationMethod, AuditStatus, SubjectLevel,
  EmailProvider, EmailAccountStatus, InboxMessageClassification, InboxMessageStatus,
};
