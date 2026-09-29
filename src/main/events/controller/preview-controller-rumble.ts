import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "previewControllerRumble",
  (
    _event,
    deviceId: string,
    light: number,
    heavy: number,
    durationMs?: number
  ) => ControllerService.previewRumble(deviceId, light, heavy, durationMs)
);
