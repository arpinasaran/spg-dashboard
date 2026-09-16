const express = require('express');
const router = express.Router();

const admin = require('../lib/admin');

function wrap(handler, defaultStatus = 503) {
  return (req, res) => {
    handler(req, res).catch(err => {
      console.error(err);
      res.status(err.status || defaultStatus).json({ error: err.message });
    });
  };
}

// One call for the whole board, same reasoning as /api/bootstrap: every panel on the page
// derives from the same attendance store, so asking for it once is both faster and the only
// way the numbers in the header can be guaranteed to agree with the grid below them.
router.get('/board', wrap(async (req, res) => {
  const days = Number(req.query.days) || undefined;
  res.json(await admin.getBoard({ days }));
}));

router.get('/session/:sessionId', wrap(async (req, res) => {
  res.json(await admin.getSessionDetail(req.params.sessionId));
}));

router.post('/review', wrap(async (req, res) => {
  const { sessionId, decision, reason, reviewer } = req.body || {};
  // Who reviewed is part of the record, so it comes from the session rather than the request
  // body wherever there is a session to take it from. A browser can claim anything; a signed
  // cookie cannot. Falls back to the submitted name on a laptop, where nobody is logged in.
  const result = await admin.review({
    sessionId, decision, reason, reviewer: req.spgOpsId || reviewer,
  });
  res.json({ ...result, session: await admin.getSessionDetail(sessionId) });
}, 400));

module.exports = { router };
