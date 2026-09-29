import { WindowManager } from "@main/services";
import { registerEvent } from "../register-event";

const toggleKeyboardOverlay = async () =>
  WindowManager.toggleKeyboardOverlay();

registerEvent("toggleKeyboardOverlay", toggleKeyboardOverlay);
