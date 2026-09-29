import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "setControllerVirtualOutput",
  (_event, deviceId: string, enabled: boolean) =>
    ControllerService.setVirtualOutput(deviceId, enabled)
);
