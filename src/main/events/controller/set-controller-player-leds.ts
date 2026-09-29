import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "setControllerPlayerLeds",
  (_event, deviceId: string, count: number) =>
    ControllerService.setPlayerLedCount(deviceId, count)
);
