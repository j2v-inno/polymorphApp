import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { errorHandler } from './middleware/error-handler.js';
import { requireAuth } from './middleware/auth.js';
import { acquisitionRouter } from './routes/acquisition.js';
import { batchSplitRouter } from './routes/batch-split.js';
import { bulkRegistrationRouter } from './routes/bulk-registration.js';
import { downloadRouter } from './routes/download.js';
import { launchRouter } from './routes/launch.js';
import { qualificationRouter } from './routes/qualification.js';
import { transformationRouter } from './routes/transformation.js';
import { taskContextRouter } from './routes/task-context.js';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: config.allowedOrigins,
      // The app token arrives as Authorization: Bearer (middleware/auth.ts).
      allowedHeaders: ['Authorization', 'Content-Type'],
    }),
  );
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // A tab Orion opened trades the launch code on its link for a session here,
  // before it has any bearer to show.
  app.use('/api/launch', launchRouter);
  // Every data call checks its bearer; health check is exempt.
  app.use('/api', requireAuth);
  app.use('/api/task-context', taskContextRouter);
  app.use('/api/acquisition', acquisitionRouter);
  app.use('/api/bulk-registration', bulkRegistrationRouter);
  app.use('/api/qualification', qualificationRouter);
  app.use('/api/batch', batchSplitRouter);
  app.use('/api/transformation', transformationRouter);
  app.use('/api/download', downloadRouter);

  app.use(errorHandler);

  return app;
}
