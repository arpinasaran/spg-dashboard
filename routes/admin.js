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
  const result = await admin.review({ sessionId, decision, reason, reviewer });
  res.json({ ...result, session: await admin.getSessionDetail(sessionId) });
}, 400));

module.exports = { router };
