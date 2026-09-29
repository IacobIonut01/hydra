import type {
  GameLaunchErrorCode,
  GameLaunchPhase,
  GameLaunchState,
  GameShop,
  LaunchSource,
} from "@types";
import path from "node:path";
import { gamesSublevel, levelKeys } from "@main/level";
import { logger } from "./logger";
import { NativeAddon } from "./native-addon";
import { WindowManager } from "./window-manager";

const AWAITING_PROCESS_TIMEOUT_MS = 45_000;
const BIG_PICTURE_HIDE_DELAY_MS = 1_500;
const BIG_PICTURE_FOREGROUND_POLL_MS = 400;

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
  bigPictureForegroundTimer: NodeJS.Timeout | null;
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

  if (launch.bigPictureForegroundTimer) {
    clearInterval(launch.bigPictureForegroundTimer);
    launch.bigPictureForegroundTimer = null;
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
    bigPictureForegroundTimer: null,
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

    // The entry may have been cleared by an early close (e.g. a launcher
    // wrapper exiting while the game keeps running) — hiding BP for a stale
    // launch would leave it hidden with no restore path.
    if (trackedLaunches.get(gameKey) !== launch) return;

    const bigPicture = WindowManager.bigPictureWindow;
    if (bigPicture?.isVisible()) {
      bigPicture.hide();
      launch.bigPictureHidden = true;
      void armBigPictureForegroundWatch(gameKey, launch);
    }
  }, BIG_PICTURE_HIDE_DELAY_MS);
};

// While BP is hidden for a running game, watch whether a game process still
// owns the foreground window. A game tearing down drops foreground well
// before its pid actually dies, so restoring here beats waiting on process
// exit — the user lands back on BP instead of the desktop. Two consecutive
// misses are required so a launcher handoff or a transient focus steal
// (UAC, overlays) doesn't pop BP mid-launch.
const armBigPictureForegroundWatch = async (
  gameKey: string,
  launch: TrackedLaunch
) => {
  if (launch.bigPictureForegroundTimer) return;

  const game = await gamesSublevel.get(gameKey);
  const executableNames = game
    ? [game.executablePath, ...(game.trackingExecutablePaths ?? [])]
        .filter((executablePath): executablePath is string =>
          Boolean(executablePath)
        )
        .map((executablePath) => path.basename(executablePath))
    : [];

  if (!executableNames.length) return;
  if (trackedLaunches.get(gameKey) !== launch || !launch.bigPictureHidden) {
    return;
  }

  let misses = 0;
  launch.bigPictureForegroundTimer = setInterval(() => {
    const disarm = () => {
      if (launch.bigPictureForegroundTimer) {
        clearInterval(launch.bigPictureForegroundTimer);
        launch.bigPictureForegroundTimer = null;
      }
    };

    if (trackedLaunches.get(gameKey) !== launch || !launch.bigPictureHidden) {
      disarm();
      return;
    }

    misses = NativeAddon.isGameForeground(executableNames) ? 0 : misses + 1;
    if (misses < 2) return;

    disarm();
    launch.bigPictureHidden = false;

    const bigPicture = WindowManager.bigPictureWindow;
    if (bigPicture && !bigPicture.isVisible()) {
      bigPicture.show();
      if (bigPicture.isMinimized()) bigPicture.restore();
    }
  }, BIG_PICTURE_FOREGROUND_POLL_MS);
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
    void armBigPictureForegroundWatch(gameKey, launch);
  }
};

export const clearGameLaunch = (gameKey: string) => {
  const launch = trackedLaunches.get(gameKey);
  trackedLaunches.delete(gameKey);
  cancelledGameKeys.delete(gameKey);
  if (launch) clearTimers(launch);

  const bigPicture = WindowManager.bigPictureWindow;
  if (!bigPicture) return;

  // Nothing else hides the BP window, so a hidden BP on game exit was hidden
  // for gameplay — restore it even when the tracked flag didn't survive. A
  // visible BP only gets pulled forward for launches that came from BP.
  const hidden = !bigPicture.isVisible();
  if (!hidden && launch?.launchSource !== "big-picture") return;

  if (hidden) bigPicture.show();
  if (bigPicture.isMinimized()) bigPicture.restore();
  bigPicture.focus();

  if (launch?.launchSource === "big-picture") {
    bigPicture.webContents.send(
      "on-navigate",
      `/big-picture/game/${launch.shop}/${launch.objectId}`
    );
  }
};
