import fs from "node:fs";

import { getDirectorySize } from "@main/events/helpers/get-directory-size";
import { logger } from "@main/services/logger";
import { WindowManager } from "@main/services/window-manager";
import type { GameShop } from "@types";

const PROGRESS_POLL_INTERVAL_MS = 5_000;

/**
 * Installer progress has no reliable percentage (Inno's /LOG file does not
 * expose one), so we report bytes written to the install directory instead.
 * Renderers show an indeterminate progress bar plus the "X GB written"
 * sublabel.
 */
export const startInstallProgressMonitor = (
  shop: GameShop,
  objectId: string,
  installDirPath: string
): (() => void) => {
  let lastBytesWritten = 0;
  let stopped = false;

  const emit = (bytesWritten: number) => {
    if (bytesWritten === lastBytesWritten) return;
    lastBytesWritten = bytesWritten;

    WindowManager.sendToAppWindows(
      "on-install-progress",
      shop,
      objectId,
      bytesWritten
    );
  };

  const timer = setInterval(() => {
    if (stopped) return;

    void (async () => {
      try {
        if (!fs.existsSync(installDirPath)) {
          emit(0);
          return;
        }

        emit(await getDirectorySize(installDirPath));
      } catch (error) {
        logger.warn(
          `[InstallProgressMonitor] Failed to measure ${installDirPath}`,
          error
        );
      }
    })();
  }, PROGRESS_POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
