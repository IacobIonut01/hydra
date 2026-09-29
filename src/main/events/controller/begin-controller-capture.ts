import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("beginControllerCapture", (_event, deviceId: string) =>
  ControllerService.beginCapture(deviceId)
);
