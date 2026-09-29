import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("setControllerEnabled", (_event, enabled: boolean) =>
  ControllerService.setEnabled(enabled)
);
