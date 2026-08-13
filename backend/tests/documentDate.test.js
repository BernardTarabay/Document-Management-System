// Dates drive sorting, filtering and "prefer the newer copy" when resolving
// duplicates, so a silently wrong date is worse than no date: it looks
// authoritative and quietly reorders everything.
//
// The rejection tests matter as much as the parsing ones. Office files with
// an unset date report the FILETIME epoch (1601) and bad PDF tooling emits
// year 0000 or 30827 -- all of which parse "successfully" into a Date object
// and would sort a modern document to either end of the list.
const test = require("node:test");
const assert = require("node:assert");

const {
  resolveDocumentDate, parsePdfDate, parseExifDate, parseIsoDate, parseFileTime,
} = require("../src/services/extraction/documentDate");

const iso = (d) => (d ? d.toISOString() : null);

// --- PDF -------------------------------------------------------------------

test("a full PDF date with a timezone offset", () => {
  assert.equal(iso(parsePdfDate("D:20240315120000+02'00'")), "2024-03-15T10:00:00.000Z");
});

test("a PDF date with no offset is read as UTC", () => {
  assert.equal(iso(parsePdfDate("D:20240315120000")), "2024-03-15T12:00:00.000Z");
});

test("a truncated PDF date (year and month only)", () => {
  assert.equal(iso(parsePdfDate("D:202403")), "2024-03-01T00:00:00.000Z");
});

test("a negative PDF offset", () => {
  assert.equal(iso(parsePdfDate("D:20240315120000-05'00'")), "2024-03-15T17:00:00.000Z");
});

// --- EXIF ------------------------------------------------------------------

test("EXIF uses colons in the date part", () => {
  assert.equal(iso(parseExifDate("2024:03:15 12:00:00")), "2024-03-15T12:00:00.000Z");
});

// --- OLE FILETIME ----------------------------------------------------------

test("a Windows FILETIME converts to the right instant", () => {
  // 2024-03-15T12:00:00Z as 100ns ticks since 1601-01-01.
  const ticks = BigInt(Date.UTC(2024, 2, 15, 12, 0, 0) + 11644473600000) * 10000n;
  assert.equal(iso(parseFileTime(ticks)), "2024-03-15T12:00:00.000Z");
});

test("a zero FILETIME means 'never set', not the year 1601", () => {
  assert.equal(parseFileTime(0n), null);
  assert.equal(parseFileTime(0), null);
});

// --- implausible values must be rejected -----------------------------------

test("dates before 1900 are rejected", () => {
  assert.equal(parseIsoDate("1601-01-01T00:00:00Z"), null);
  assert.equal(parsePdfDate("D:00000000000000"), null);
});

test("dates far in the future are rejected", () => {
  assert.equal(parseIsoDate("30827-09-14T02:48:05Z"), null);
  assert.equal(parsePdfDate("D:99991231235959"), null);
});

test("junk parses to null rather than Invalid Date", () => {
  for (const junk of ["", null, undefined, "not a date", "D:", 42]) {
    assert.equal(parsePdfDate(junk), null, `pdf: ${junk}`);
    assert.equal(parseExifDate(junk), null, `exif: ${junk}`);
  }
});

// --- the priority order ----------------------------------------------------

test("an embedded date beats the filesystem", () => {
  const r = resolveDocumentDate(
    { created: "2019-05-02T09:30:00Z" },
    { modifiedAtFs: new Date("2026-01-01T00:00:00Z") }
  );
  assert.equal(r.source, "embedded");
  assert.equal(iso(r.date), "2019-05-02T09:30:00.000Z");
});

test("EXIF wins over everything -- a photo's own clock is the best evidence", () => {
  const r = resolveDocumentDate(
    { dateTimeOriginal: "2018:07:04 10:00:00", created: "2024-01-01T00:00:00Z" },
    {}
  );
  assert.equal(r.source, "exif");
});

test("created beats modified", () => {
  const r = resolveDocumentDate(
    { created: "2019-05-02T09:30:00Z", modified: "2025-11-11T00:00:00Z" },
    {}
  );
  assert.equal(iso(r.date), "2019-05-02T09:30:00.000Z");
});

test("an implausible embedded date falls through to the next candidate", () => {
  // The 1601 case: present, parseable, and meaningless.
  const r = resolveDocumentDate(
    { created: "1601-01-01T00:00:00Z", modified: "2022-02-02T00:00:00Z" },
    {}
  );
  assert.equal(r.source, "embedded-modified");
  assert.equal(iso(r.date), "2022-02-02T00:00:00.000Z");
});

test("the filesystem is used last and says so", () => {
  const r = resolveDocumentDate({}, { modifiedAtFs: new Date("2023-06-01T00:00:00Z") });
  assert.equal(r.source, "filesystem");
  assert.equal(iso(r.date), "2023-06-01T00:00:00.000Z");
});

test("the OLDER filesystem timestamp is preferred", () => {
  // Copying a file updates one of the two; the survivor is closer to the truth.
  const r = resolveDocumentDate({}, {
    createdAtFs: new Date("2026-01-01T00:00:00Z"), // the day it was copied here
    modifiedAtFs: new Date("2011-04-04T00:00:00Z"), // the day it was written
  });
  assert.equal(iso(r.date), "2011-04-04T00:00:00.000Z");
});

test("no date anywhere is reported honestly, not faked", () => {
  const r = resolveDocumentDate({}, {});
  assert.equal(r.date, null);
  assert.equal(r.source, "none");
});
