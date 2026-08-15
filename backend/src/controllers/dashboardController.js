const dashboardService = require("../services/dashboardService");

async function summary(req, res) {
  res.json(await dashboardService.summary(req.user.id));
}

module.exports = { summary };
