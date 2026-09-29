import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("getControllerProfiles", () => ControllerService.listProfiles());
