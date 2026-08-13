const emailAccountService = require("../services/emailAccountService");
const env = require("../config/env");

async function list(req, res) {
  res.json(await emailAccountService.list(req.user.id));
}

async function connect(req, res) {
  const authUrl = emailAccountService.initiateConnect(req.params.provider, req.user.id);
  res.json({ authUrl });
}

/**
 * Hit directly by Google/Microsoft's own redirect -- no Authorization
 * header exists on this request (it's a top-level browser navigation
 * initiated by the provider, not an API call from our own frontend JS), so
 * this always ends in a redirect back to the frontend rather than a JSON
 * response the frontend could read directly. See emailAccountRoutes.js for
 * why this route is exempt from the router's normal authenticate middleware.
 */
async function callback(req, res) {
  const { provider } = req.params;
  const { code, state, error } = req.query;

  if (error) {
    res.redirect(`${env.frontendUrl}/inbox?error=${encodeURIComponent(String(error))}`);
    return;
  }

  try {
    const account = await emailAccountService.handleCallback(provider, code, state);
    res.redirect(`${env.frontendUrl}/inbox?connected=${encodeURIComponent(account.email_address)}`);
  } catch (err) {
    res.redirect(`${env.frontendUrl}/inbox?error=${encodeURIComponent(err.publicMessage || err.message)}`);
  }
}

async function sync(req, res) {
  const job = await emailAccountService.triggerSync(req.params.id, req.user.id);
  res.status(202).json({ processingJobId: job.id, status: job.status });
}

async function remove(req, res) {
  res.json(await emailAccountService.disconnect(req.params.id, req.user.id));
}

module.exports = { list, connect, callback, sync, remove };
