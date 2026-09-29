import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("deleteControllerProfile", (_event, profileId: string) =>
  ControllerService.deleteProfile(profileId)
);
