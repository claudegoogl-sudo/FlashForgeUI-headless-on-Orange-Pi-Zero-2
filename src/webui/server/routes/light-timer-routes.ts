/**
 * @fileoverview Light timer routes (auto-off of the printer light).
 *
 * - GET  /light-timer            settings, pending timer, light state of the printers
 * - POST /light-timer            { dailyOff?: { enabled?, time? }, skipWhilePrinting? }
 * - POST /light-timer/off-in     { minutes }   one-shot timer, 1 minute to 12 hours
 * - POST /light-timer/cancel     drop the one-shot timer
 *
 * Times are in the WebUI host's local time zone; GET reports the host's clock so the
 * UI can show which clock the daily time refers to.
 */

import type { Response, Router } from 'express';
import {
  createPrinterLightActions,
  getLightTimerService,
  type LightTimerActions,
  type LightTimerService,
  MAX_OFF_IN_MINUTES,
} from '../../../services/LightTimerService';
import { toAppError } from '../../../utils/error.utils';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendErrorResponse } from './route-helpers';

interface LightTimerBody {
  dailyOff?: { enabled?: unknown; time?: unknown };
  skipWhilePrinting?: unknown;
}

export function registerLightTimerRoutes(
  router: Router,
  service: LightTimerService = getLightTimerService(),
  actions: LightTimerActions = createPrinterLightActions()
): void {
  const describeState = async () => {
    const state = await service.getState();
    const contexts = actions.contexts();
    let lightOn: boolean | undefined;
    for (const contextId of contexts) {
      const on = await actions.isLightOn(contextId).catch(() => undefined);
      if (on === true) {
        lightOn = true;
        break;
      }
      if (on === false) lightOn = false;
    }
    return {
      success: true,
      supported: contexts.length > 0,
      lightOn,
      ...state,
      remainingSeconds:
        state.config.offAt === null
          ? null
          : Math.max(0, Math.round((state.config.offAt - state.now) / 1000)),
    };
  };

  router.get('/light-timer', async (_req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await describeState());
    } catch (error) {
      return sendErrorResponse(res, 500, toAppError(error).message);
    }
  });

  router.post('/light-timer', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as LightTimerBody;
      const daily = body.dailyOff ?? {};
      if (daily.enabled !== undefined && typeof daily.enabled !== 'boolean') {
        return sendErrorResponse(res, 400, 'dailyOff.enabled must be true or false');
      }
      if (body.skipWhilePrinting !== undefined && typeof body.skipWhilePrinting !== 'boolean') {
        return sendErrorResponse(res, 400, 'skipWhilePrinting must be true or false');
      }
      if (daily.time !== undefined && typeof daily.time !== 'string') {
        return sendErrorResponse(res, 400, 'dailyOff.time must be HH:MM (24 h)');
      }
      try {
        await service.setDaily({
          enabled: daily.enabled as boolean | undefined,
          time: daily.time as string | undefined,
          skipWhilePrinting: body.skipWhilePrinting as boolean | undefined,
        });
      } catch (error) {
        return sendErrorResponse(res, 400, (error as Error).message);
      }
      return res.json(await describeState());
    } catch (error) {
      return sendErrorResponse(res, 500, toAppError(error).message);
    }
  });

  router.post('/light-timer/off-in', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const minutes = (req.body as { minutes?: unknown } | undefined)?.minutes;
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > MAX_OFF_IN_MINUTES
      ) {
        return sendErrorResponse(
          res,
          400,
          `minutes must be a whole number from 1 to ${MAX_OFF_IN_MINUTES}`
        );
      }
      await service.offIn(minutes);
      return res.json(await describeState());
    } catch (error) {
      return sendErrorResponse(res, 500, toAppError(error).message);
    }
  });

  router.post('/light-timer/cancel', async (_req: AuthenticatedRequest, res: Response) => {
    try {
      await service.cancelOffIn();
      return res.json(await describeState());
    } catch (error) {
      return sendErrorResponse(res, 500, toAppError(error).message);
    }
  });
}
