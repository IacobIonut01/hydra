import { ControllerService } from "@main/services/controller";
import type { ControllerProfile } from "@types";

import { registerEvent } from "../register-event";

registerEvent(
  "saveControllerProfile",
  (
    _event,
    profile: Omit<ControllerProfile, "id" | "builtin"> & { id?: string }
  ) => ControllerService.saveProfile(profile)
);
