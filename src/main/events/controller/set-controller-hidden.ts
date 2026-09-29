import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "setControllerHidden",
  (_event, deviceId: string, enabled: boolean) =>
    ControllerService.setHidden(deviceId, enabled)
);
