import { ControllerService } from "@main/services/controller";

import { registerEvent } from "../register-event";

registerEvent(
  "setControllerTriggerEffect",
  (
    _event,
    deviceId: string,
    side: "left" | "right",
    mode: number,
    params: number[]
  ) => ControllerService.setTriggerEffect(deviceId, side, mode, params)
);
