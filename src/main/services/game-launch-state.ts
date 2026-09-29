import type {
  GameLaunchErrorCode,
  GameLaunchPhase,
  GameLaunchState,
  GameShop,
  LaunchSource,
} from "@types";
import { levelKeys } from "@main/level";
import { logger } from "./logger";
import { WindowManager } from "./window-manager";

const AWAITING_PROCESS_TIMEOUT_MS = 45_000;
const BIG_PICTURE_HIDE_DELAY_MS = 1_500;

interface TrackedLaunch {
  shop: GameShop;
  objectId: string;
  launchSource: LaunchSource;
  gameMode: boolean;
  phase: GameLaunchPhase;
  error: GameLaunchErrorCode | null;
  detail: string | null;
  awaitingProcessTimer: NodeJS.Timeout | null;
  bigPictureHideTimer: NodeJS.Timeout | null;
  bigPictureHidden: boolean;
}

const trackedLaunches = new Map<string, TrackedLaunch>();
const cancelledGameKeys = new Set<string>();

const broadcast = (gameKey: string, launch: TrackedLaunch) => {
  const state: GameLaunchState = {
    gameKey,
    shop: launch.shop,
    objectId: launch.objectId,
    phase: launch.phase,
    error: launch.error,
    detail: launch.detail,
  };

  WindowManager.sendToAppWindows("on-game-launch-state", state);
};

const clearTimers = (launch: TrackedLaunch) => {
  if (launch.awaitingProcessTimer) {
    clearTimeout(launch.awaitingProcessTimer);
    launch.awaitingProcessTimer = null;
  }

  if (launch.bigPictureHideTimer) {
    clearTimeout(launch.bigPictureHideTimer);
    launch.bigPictureHideTimer = null;
  }
};

const armAwaitingProcessTimeout = (gameKey: string, launch: TrackedLaunch) => {
  launch.awaitingProcessTimer = setTimeout(() => {
    launch.awaitingProcessTimer = null;

    if (launch.phase !== "awaiting-process") return;

    logger.warn("Game launch timed out waiting for the process", {
      gameKey,
    });

    launch.phase = "failed";
    launch.error = "process-not-detected";
    launch.detail = null;
    broadcast(gameKey, launch);
  }, AWAITING_PROCESS_TIMEOUT_MS);
};

export const beginGameLaunch = (
  shop: GameShop,
  objectId: string,
  launchSource: LaunchSource,
  gameMode: boolean
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const previous = trackedLaunches.get(gameKey);
  if (previous) clearTimers(previous);

  const launch: TrackedLaunch = {
    shop,
    objectId,
    launchSource,
    gameMode,
    phase: "preparing",
    error: null,
    detail: null,
    awaitingProcessTimer: null,
    bigPictureHideTimer: null,
    bigPictureHidden: previous?.bigPictureHidden ?? false,
  };

  trackedLaunches.set(gameKey, launch);
  cancelledGameKeys.delete(gameKey);
  broadcast(gameKey, launch);
};

export const setGameLaunchPhase = (
  shop: GameShop,
  objectId: string,
  phase: GameLaunchPhase,
  detail: string | null = null
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const launch = trackedLaunches.get(gameKey);
  if (!launch || launch.phase === "failed") return;

  launch.phase = phase;
  launch.detail = detail;

  if (phase === "awaiting-process") {
    armAwaitingProcessTimeout(gameKey, launch);
  }

  broadcast(gameKey, launch);
};

export const failGameLaunch = (
  shop: GameShop,
  objectId: string,
  error: GameLaunchErrorCode,
  detail: string | null = null
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const launch = trackedLaunches.get(gameKey);
  if (!launch || launch.phase === "failed") return;

  clearTimers(launch);
  launch.phase = "failed";
  launch.error = error;
  launch.detail = detail;
  broadcast(gameKey, launch);
};

export const cancelGameLaunch = (shop: GameShop, objectId: string) => {
  const gameKey = levelKeys.game(shop, objectId);
  const launch = trackedLaunches.get(gameKey);
  if (!launch) return;

  if (launch.phase === "failed" || launch.phase === "running") return;

  cancelledGameKeys.add(gameKey);
};

export const consumeGameLaunchCancellation = (
  shop: GameShop,
  objectId: string
) => {
  const gameKey = levelKeys.game(shop, objectId);
  return cancelledGameKeys.delete(gameKey);
};

export const getGameLaunchState = (
  shop: GameShop,
  objectId: string
): GameLaunchState | null => {
  const gameKey = levelKeys.game(shop, objectId);
  const launch = trackedLaunches.get(gameKey);
  if (!launch) return null;

  return {
    gameKey,
    shop: launch.shop,
    objectId: launch.objectId,
    phase: launch.phase,
    error: launch.error,
    detail: launch.detail,
  };
};

export const markGameRunning = (gameKey: string) => {
  const launch = trackedLaunches.get(gameKey);
  if (!launch || launch.phase === "running") return;

  if (launch.phase === "failed" && launch.error !== "process-not-detected") {
    return;
  }

  clearTimers(launch);
  launch.phase = "running";
  launch.error = null;
  launch.detail = null;
  broadcast(gameKey, launch);

  if (!launch.gameMode || launch.launchSource !== "big-picture") return;

  launch.bigPictureHideTimer = setTimeout(() => {
    launch.bigPictureHideTimer = null;

    const bigPicture = WindowManager.bigPictureWindow;
    if (bigPicture?.isVisible()) {
      bigPicture.hide();
      launch.bigPictureHidden = true;
    }
  }, BIG_PICTURE_HIDE_DELAY_MS);
};

export const hideBigPictureForGame = (gameKey: string) => {
  const launch = trackedLaunches.get(gameKey);
  if (!launch || launch.phase !== "running") return;

  if (launch.bigPictureHideTimer) {
    clearTimeout(launch.bigPictureHideTimer);
    launch.bigPictureHideTimer = null;
  }

  const bigPicture = WindowManager.bigPictureWindow;
  if (bigPicture?.isVisible()) {
    bigPicture.hide();
    launch.bigPictureHidden = true;
  }
};

export const clearGameLaunch = (gameKey: string) => {
  const launch = trackedLaunches.get(gameKey);
  trackedLaunches.delete(gameKey);
  cancelledGameKeys.delete(gameKey);
  if (!launch) return;

  clearTimers(launch);

  if (!launch.bigPictureHidden) return;

  const bigPicture = WindowManager.bigPictureWindow;
  if (!bigPicture) return;

  if (!bigPicture.isVisible()) {
    bigPicture.show();
  }
  bigPicture.focus();
  bigPicture.webContents.send(
    "on-navigate",
    `/big-picture/game/${launch.shop}/${launch.objectId}`
  );
};
