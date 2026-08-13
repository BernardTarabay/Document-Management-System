// Path traversal protection (spec §29). Every operation that touches the
// filesystem on behalf of a Storage Location must resolve through here.
// A user must never be able to escape a Storage Location's root_path by
// manipulating an API request (e.g. "../../etc/passwd" or an absolute path
// that happens to point elsewhere).
const path = require("path");

/**
 * Resolve `relativePath` against `rootPath` and guarantee the result is still
 * inside `rootPath`. Throws if it isn't.
 * @param {string} rootPath - the Storage Location's root_path (trusted, from DB)
 * @param {string} relativePath - untrusted-ish path fragment (e.g. a proposed new name/path)
 * @returns {string} absolute, validated path
 */
function resolveWithinRoot(rootPath, relativePath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, relativePath);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new PathTraversalError(
      `Resolved path "${target}" escapes storage root "${root}"`
    );
  }
  return target;
}

class PathTraversalError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathTraversalError";
    this.statusCode = 400;
    this.publicMessage = "Invalid path";
  }
}

module.exports = { resolveWithinRoot, PathTraversalError };
