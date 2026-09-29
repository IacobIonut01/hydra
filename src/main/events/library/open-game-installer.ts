import { shell } from "electron";
import path from "node:path";
import fs from "node:fs";

import { getDownloadsPath } from "../helpers/get-downloads-path";
import { registerEvent } from "../register-event";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { GameShop } from "@types";
import { Wine } from "@main/services";
import {
  executeGameInstaller,
  rescanAndBindExecutableAfterInstall,
  scheduleRescanPoll,
} from "@main/services/install/installer-runner";
import { findInstallerInFolder } from "@main/services/install/installer-locator";

const openGameInstaller = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);
  const game = await gamesSublevel.get(downloadKey).catch(() => null);
  const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );

  if (!download?.folderName) return true;

  const gamePath = path.join(
    download.downloadPath ?? (await getDownloadsPath()),
    download.folderName
  );

  if (!fs.existsSync(gamePath)) {
    return true;
  }

  if (process.platform === "darwin") {
    shell.openPath(gamePath);
    return true;
  }

  if (fs.lstatSync(gamePath).isFile()) {
    shell.showItemInFolder(gamePath);
    return true;
  }

  const installDirPath = download.installPath ?? null;

  const onInstallerExit = () => {
    void rescanAndBindExecutableAfterInstall(
      shop,
      objectId,
      gamePath,
      effectiveWinePrefixPath,
      installDirPath
    );
  };

  const onIndeterminateLaunch = () => {
    scheduleRescanPoll(
      shop,
      objectId,
      gamePath,
      effectiveWinePrefixPath,
      installDirPath
    );
  };

  const installer = findInstallerInFolder(gamePath);
  if (installer) {
    return await executeGameInstaller(installer.path, {
      gameId: objectId,
      winePrefixPath: effectiveWinePrefixPath,
      protonPath: game?.protonPath,
      onExit: onInstallerExit,
      onIndeterminateLaunch,
    });
  }

  shell.openPath(gamePath);
  return true;
};

registerEvent("openGameInstaller", openGameInstaller);
