const dashboardService = require("../services/dashboardService");

async function summary(req, res) {
  res.json(await dashboardService.summary());
}

module.exports = { summary };
