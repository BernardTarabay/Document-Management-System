// The retry button is the only part of triage that CREATES work, so it is
// the only part that can make things worse. The two ways it goes wrong:
//
//   restarting at the wrong stage -- re-extracting a file that was never
//   hashed leaves the exact gap that stalled it, so the retry appears to do
//   something and changes nothing.
//
//   offering to retry what cannot be retried -- a file whose bytes are gone
//   will fail again, every time, and a button that queues a certain failure
//   is worse than one that explains why it is disabled.
const test = require("node:test");
const assert = require("node:assert");

const { REASONS, REASON_KEYS, retryPlanFor } = require("../src/services/triageReasons");
const { JobType } = require("../src/models/enums");

// --- the reason vocabulary -------------------------------------------------

test("every reason has a label and an explanation", () => {
  for (const key of REASON_KEYS) {
    assert.ok(REASONS[key].label, `${key} has no label`);
    assert.ok(REASONS[key].explanation, `${key} has no explanation`);
  }
});

test("a non-retryable reason always says why", () => {
  for (const key of REASON_KEYS) {
    if (!REASONS[key].retryable) {
      assert.ok(REASONS[key].blockedMessage, `${key} is not retryable but offers no reason`);
    }
  }
});

test("severity order is most-serious-first and is what the SQL orders by", () => {
  // The repository passes REASON_KEYS straight to array_position(), so this
  // list IS the on-screen ordering. Pinned so a reordering is a deliberate
  // edit to a test rather than a silent reshuffle of the queue.
  assert.deepEqual(
    [...REASON_KEYS],
    ["missing", "job_failed", "extraction_failed", "stalled", "needs_ocr", "unreadable"]
  );
});

// --- the retry plan --------------------------------------------------------

test("a file that was never hashed restarts at hashing, not extraction", () => {
  const plan = retryPlanFor({ id: "f1", reason: "stalled", sha256_hash: null });
  assert.equal(plan.jobType, JobType.HASH);
  assert.deepEqual(plan.payload, { fileId: "f1" });
});

test("a hashed file with no content restarts at text extraction", () => {
  const plan = retryPlanFor({ id: "f2", reason: "stalled", sha256_hash: "abc" });
  assert.equal(plan.jobType, JobType.EXTRACT_TEXT);
});

test("unreadable and needs_ocr both re-extract", () => {
  for (const reason of ["unreadable", "needs_ocr", "extraction_failed"]) {
    const plan = retryPlanFor({ id: "f3", reason, sha256_hash: "abc" });
    assert.equal(plan.jobType, JobType.EXTRACT_TEXT, `${reason} should re-extract`);
  }
});

test("a failed job is re-run as itself, with its original payload", () => {
  // Rebuilding the payload as { fileId } would re-run detect_duplicates in
  // its EXACT phase instead of the probable phase that actually failed --
  // a different job wearing the same name.
  const plan = retryPlanFor({
    id: "f4",
    reason: "job_failed",
    sha256_hash: "abc",
    last_job_type: JobType.DETECT_DUPLICATES,
    last_job_payload: { fileId: "f4", phase: "probable" },
  });
  assert.equal(plan.jobType, JobType.DETECT_DUPLICATES);
  assert.deepEqual(plan.payload, { fileId: "f4", phase: "probable" });
});

test("a failed job with no recorded payload still targets the right file", () => {
  const plan = retryPlanFor({
    id: "f5",
    reason: "job_failed",
    sha256_hash: "abc",
    last_job_type: JobType.CLASSIFY,
    last_job_payload: null,
  });
  assert.deepEqual(plan.payload, { fileId: "f5" });
});

test("a job_failed row that somehow lost its job type falls back to a real stage", () => {
  // Rather than enqueueing `undefined` as a job type, which getQueue would
  // throw on at the point of retrying instead of here.
  const plan = retryPlanFor({ id: "f6", reason: "job_failed", sha256_hash: null, last_job_type: null });
  assert.equal(plan.jobType, JobType.HASH);
});

test("a missing file is not retryable and explains itself", () => {
  const plan = retryPlanFor({ id: "f7", reason: "missing", sha256_hash: "abc" });
  assert.equal(plan.jobType, undefined);
  assert.match(plan.blocked, /rescan/i);
});

test("a row with no reason is refused rather than given a default job", () => {
  assert.ok(retryPlanFor({ id: "f8", reason: null }).blocked);
  assert.ok(retryPlanFor({ id: "f9", reason: "not_a_reason" }).blocked);
  assert.ok(retryPlanFor(null).blocked);
});

test("every retryable reason produces a job type the queue actually knows", () => {
  const known = new Set(Object.values(JobType));
  for (const key of REASON_KEYS) {
    if (!REASONS[key].retryable) continue;
    const plan = retryPlanFor({ id: "f10", reason: key, sha256_hash: "abc" });
    assert.ok(known.has(plan.jobType), `${key} produced unknown job type ${plan.jobType}`);
  }
});
