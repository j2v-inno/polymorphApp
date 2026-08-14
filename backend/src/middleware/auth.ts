import type { NextFunction, Request, Response } from 'express';

const PARCEL_TOKEN_HEADER = 'x-fluid-parcel-token';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      parcelToken?: string;
    }
  }
}

/**
 * §10 security model:
 *  - Parcel mode: Orion's shell hands the browser a short-lived scoped token via
 *    customProps.apiToken; the frontend forwards it as `x-fluid-parcel-token`.
 *    This backend must "exchange/validate this token server-side" per §10, but
 *    the doc does not specify the validation endpoint/mechanism — that's not
 *    yet decided upstream. This middleware currently only checks *presence*,
 *    not validity. Do not treat this as a finished auth story; wire real
 *    validation in once the mechanism is confirmed.
 *  - Standalone mode: auth model is an explicit open blocker (§13 #6, §10) —
 *    "own login, or a short-lived signed launch token issued by Orion" — no
 *    decision made. Refuse rather than fabricate a login system.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const parcelToken = req.header(PARCEL_TOKEN_HEADER);

  if (parcelToken) {
    req.parcelToken = parcelToken;
    next();
    return;
  }

  if (process.env.ALLOW_UNAUTHENTICATED_STANDALONE === 'true') {
    next();
    return;
  }

  res.status(501).json({
    ok: false,
    error:
      'Standalone-mode auth is not implemented pending a decision (FLUID_APP_DEV_CONTEXT.md §13, open question #6). ' +
      'Set ALLOW_UNAUTHENTICATED_STANDALONE=true for local development only.',
  });
}
