class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.statusCode = 400;
    this.publicMessage = message;
    this.details = details;
  }
}

module.exports = { ValidationError };
