import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("endControllerCapture", (_event, deviceId: string) =>
  ControllerService.endControllerCapture(deviceId)
);
