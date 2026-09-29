import { WindowManager } from "@main/services";
import { registerEvent } from "../register-event";

const hideKeyboardOverlay = async () => {
  WindowManager.hideKeyboardOverlay();
};

registerEvent("hideKeyboardOverlay", hideKeyboardOverlay);
