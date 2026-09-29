import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("identifyController", (_event, deviceId: string) =>
  ControllerService.identify(deviceId)
);
