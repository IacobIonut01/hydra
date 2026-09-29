import { registerEvent } from "../register-event";
import path from "node:path";
import { gamesSublevel, levelKeys } from "@main/level";
import { hideBigPictureForGame, NativeAddon } from "@main/services";
import type { GameShop } from "@types";

const focusRunningGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);
  if (!game) return false;

  const executableNames = [
    game.executablePath,
    ...(game.trackingExecutablePaths ?? []),
  ]
    .filter((executablePath): executablePath is string =>
      Boolean(executablePath)
    )
    .map((executablePath) => path.basename(executablePath));

  if (!executableNames.length) return false;

  const focused = NativeAddon.focusGameWindow(executableNames);
  if (focused) {
    hideBigPictureForGame(gameKey);
  }

  return focused;
};

registerEvent("focusRunningGame", focusRunningGame);
