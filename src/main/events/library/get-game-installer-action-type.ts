import path from "node:path";
import fs from "node:fs";

import { getDownloadsPath } from "../helpers/get-downloads-path";
import { registerEvent } from "../register-event";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { findInstallerInFolder } from "@main/services/install/installer-locator";
import { GameShop } from "@types";

const getGameInstallerActionType = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<"install" | "open-folder" | "installing"> => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);

  if (!download?.folderName) return "open-folder";

  const game = await gamesSublevel.get(downloadKey);
  if (game?.executablePath && fs.existsSync(game.executablePath)) {
    return "open-folder";
  }

  if (download.installing) {
    return "installing";
  }

  const gamePath = path.join(
    download.downloadPath ?? (await getDownloadsPath()),
    download.folderName
  );

  if (!fs.existsSync(gamePath)) {
    return "open-folder";
  }

  // macOS always opens folder
  if (process.platform === "darwin") {
    return "open-folder";
  }

  // If path is a file, it will show in folder (open-folder behavior)
  if (fs.lstatSync(gamePath).isFile()) {
    return "open-folder";
  }

  return findInstallerInFolder(gamePath) ? "install" : "open-folder";
};

registerEvent("getGameInstallerActionType", getGameInstallerActionType);
