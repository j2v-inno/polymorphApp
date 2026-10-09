import { Router } from 'express';
import { startTabSession } from '../middleware/auth.js';

export const launchRouter = Router();

/**
 * Opened by Orion in its own tab, this app's link carries one thing: `ct`, a
 * launch code. The screen posts it here once, when the tab loads. This server
 * exchanges it with Orion, using its API token, and answers with a session
 * for the tab and the work Orion opened it for: the operator, the task, the
 * file and the screen. None of that is on the link, and none of it is taken
 * from the browser.
 *
 * Mounted ahead of requireAuth: this is where a tab gets its bearer.
 */
launchRouter.post('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const ct = typeof body.ct === 'string' ? body.ct : '';
  const session = typeof body.session === 'string' ? body.session : undefined;

  if (!ct) {
    res.status(400).json({ ok: false, error: 'No launch code. Open this task from Orion.' });
    return;
  }

  const launched = await startTabSession(ct, session);
  if (!launched.ok) {
    res.status(launched.status).json({ ok: false, error: launched.error });
    return;
  }

  const { web_app, context, actor } = launched.contract;
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    data: {
      session: launched.session,
      context: {
        appScreen: web_app.screen ?? undefined,
        taskId: context.task.id,
        taskUid: context.task.uid,
        fileId: context.file?.id,
        projectId: context.project.id,
        projectCode: context.project.code ?? '',
        workflowId: context.workflow?.id,
        workflowCode: context.workflow?.code ?? undefined,
        userId: actor.user_id,
        userLoginId: actor.login_id,
      },
    },
  });
});
