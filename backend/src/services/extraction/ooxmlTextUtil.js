// Shared helper for the two OOXML text-run formats we parse without a full
// XML parser dependency: strip tags, decode a handful of XML entities, and
// collapse whitespace. Kept intentionally simple/fast for large documents;
// a real XML parser can replace this later without changing the extractor
// interface.
function stripXmlToText(xml) {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { stripXmlToText };
