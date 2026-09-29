import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "setControllerLightbar",
  (
    _event,
    deviceId: string,
    r: number,
    g: number,
    b: number,
    flashOn?: number,
    flashOff?: number
  ) => ControllerService.setLightbar(deviceId, r, g, b, flashOn, flashOff)
);
