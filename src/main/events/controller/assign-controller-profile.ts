import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "assignControllerProfile",
  (_event, deviceId: string, profileId: string | null) =>
    ControllerService.assignProfile(deviceId, profileId)
);
