import { WindowManager } from "@main/services";
import { registerEvent } from "../register-event";

const showKeyboardOverlay = async () => {
  WindowManager.showKeyboardOverlay();
};

registerEvent("showKeyboardOverlay", showKeyboardOverlay);
