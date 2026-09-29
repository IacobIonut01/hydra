import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent("getVirtualOutputSupport", () =>
  ControllerService.getVirtualOutputSupport()
);
