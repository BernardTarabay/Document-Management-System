// Wraps an async route/controller so rejected promises reach Express's error
// handler instead of becoming unhandled rejections. Every controller in this
// project uses this rather than repeating try/catch.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
