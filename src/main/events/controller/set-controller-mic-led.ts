import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("setControllerMicLed", (_event, deviceId: string, mode: number) =>
  ControllerService.setMicLed(deviceId, mode)
);
