import { NativeAddon, logger } from "@main/services";
import { registerEvent } from "../register-event";

const sendVirtualKeyChord = async (_event: unknown, virtualKeys: number[]) => {
  if (!Array.isArray(virtualKeys) || virtualKeys.length === 0) return;

  try {
    NativeAddon.sendVirtualKeyChord(
      virtualKeys.map((key) => Number(key) & 0xff)
    );
  } catch (error) {
    logger.warn("Failed to send virtual key chord to game", error);
  }
};

registerEvent("sendVirtualKeyChord", sendVirtualKeyChord);
