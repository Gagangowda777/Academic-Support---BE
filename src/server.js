require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const {
  resumePendingPaperEvaluations,
} = require('./services/paperEvaluationWorker');

const configuredPort = Number(process.env.PORT);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 5000;

async function start() {
  try {
    await connectDB();

    const queuedCount = await resumePendingPaperEvaluations();
    if (queuedCount) {
      console.log(`[server] resumed ${queuedCount} pending paper evaluation(s)`);
    }

    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('[server] failed to start:', error.message);
    process.exit(1);
  }
}

start();
