import { NativeAddon, logger } from "@main/services";
import { registerEvent } from "../register-event";

const sendTextInput = async (_event: unknown, text: string) => {
  if (typeof text !== "string" || text.length === 0) return;

  try {
    NativeAddon.sendTextInput(text);
  } catch (error) {
    logger.warn("Failed to send text input to game", error);
  }
};

registerEvent("sendTextInput", sendTextInput);
