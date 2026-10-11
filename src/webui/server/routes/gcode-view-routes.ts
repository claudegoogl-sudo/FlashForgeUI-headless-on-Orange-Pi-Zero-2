/**
 * @fileoverview Live G-code viewer routes.
 *
 * - GET /gcode-view/meta?file=NAME          layer table (byte ranges), bounds, tools, colours
 * - GET /gcode-view/layer?file=NAME&layer=N extrusion paths of one layer (1-based)
 *
 * NAME is the job file name the printer reports. The G-code is looked up in the
 * host-side job library and among the files kept from Upload Job; a job the WebUI
 * host has no copy of answers 404.
 */

import type { Response, Router } from 'express';
import { type GcodeViewService, getGcodeViewService } from '../../../services/GcodeViewService';
import { toAppError } from '../../../utils/error.utils';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendErrorResponse } from './route-helpers';

const NOT_AVAILABLE =
  'No G-code for this job on the WebUI host. Add the file to the Library under the same name, or start it with Upload Job.';

export function registerGcodeViewRoutes(
  router: Router,
  service: GcodeViewService = getGcodeViewService()
): void {
  router.get('/gcode-view/meta', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const fileName = typeof req.query.file === 'string' ? req.query.file : '';
      const resolved = await service.resolve(fileName);
      if (!resolved) {
        return sendErrorResponse(res, 404, NOT_AVAILABLE);
      }
      const index = await service.getIndex(resolved.gcodePath);
      return res.json({
        success: true,
        fileName,
        source: resolved.source,
        size: index.size,
        layers: index.layers.map((layer) => ({ z: layer.z, start: layer.start, end: layer.end })),
        bounds: index.bounds,
        modelBounds: index.modelBounds,
        tools: index.tools,
        colors: index.colors,
      });
    } catch (error) {
      return sendErrorResponse(res, 500, toAppError(error).message);
    }
  });

  router.get('/gcode-view/layer', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const fileName = typeof req.query.file === 'string' ? req.query.file : '';
      const layerNumber = Number.parseInt(
        typeof req.query.layer === 'string' ? req.query.layer : '',
        10
      );
      if (!Number.isInteger(layerNumber) || layerNumber < 1) {
        return sendErrorResponse(res, 400, 'layer must be a positive integer');
      }
      const resolved = await service.resolve(fileName);
      if (!resolved) {
        return sendErrorResponse(res, 404, NOT_AVAILABLE);
      }
      const index = await service.getIndex(resolved.gcodePath);
      if (layerNumber > index.layers.length) {
        return sendErrorResponse(res, 404, `Layer ${layerNumber} does not exist`);
      }
      const layer = await service.getLayer(resolved.gcodePath, layerNumber);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.json({ success: true, layer: layerNumber, ...layer });
    } catch (error) {
      return sendErrorResponse(res, 500, toAppError(error).message);
    }
  });
}
