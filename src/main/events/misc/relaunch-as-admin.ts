import { app } from "electron";
import { registerEvent } from "../register-event";
import { logger, NativeAddon } from "@main/services";

const relaunchAsAdmin = async () => {
  if (process.platform !== "win32") return false;
  if (NativeAddon.isProcessElevated()) return true;

  const relaunched = NativeAddon.relaunchElevated(app.getPath("exe"));
  if (!relaunched) return false;

  logger.info("Relaunching Hydra with administrator privileges");
  setImmediate(() => app.quit());
  return true;
};

registerEvent("relaunchAsAdmin", relaunchAsAdmin);
