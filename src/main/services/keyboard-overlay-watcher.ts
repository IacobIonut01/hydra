import { db, levelKeys } from "@main/level";
import type { UserPreferences } from "@types";
import { logger } from "./logger";
import { NativeAddon } from "./native-addon";
import { WindowManager } from "./window-manager";

/**
 * Auto-summons the in-game keyboard when the foreground window parks focus on
 * an editable field (Windows UIA). The chord (Guide + X) stays available for
 * games that expose no accessible focus, and manual dismissal is respected:
 * hiding the overlay while a field stays focused suppresses re-summon until
 * focus leaves the field and returns.
 */
const FOCUS_POLL_INTERVAL_MS = 700;
const FOCUS_MISSES_TO_HIDE = 2;

let pollTimer: NodeJS.Timeout | null = null;
let overlayAutoShown = false;
let summonSuppressed = false;
let consecutiveFocusMisses = 0;

async function isAutoSummonEnabled(): Promise<boolean> {
  if (process.platform !== "win32") return false;

  const preferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  return (
    (preferences?.bigPictureGameModeEnabled ?? false) &&
    (preferences?.bigPictureInGameKeyboardEnabled ?? true)
  );
}

async function pollFocus() {
  if (!(await isAutoSummonEnabled())) {
    stopKeyboardOverlayWatcher();
    return;
  }

  const visible = WindowManager.isKeyboardOverlayVisible();

  if (NativeAddon.isTextInputFocused()) {
    consecutiveFocusMisses = 0;

    if (visible) return;

    if (overlayAutoShown) {
      // It was auto-shown and someone closed it while the field stayed
      // focused — don't fight the user, wait for a fresh focus edge.
      overlayAutoShown = false;
      summonSuppressed = true;
      return;
    }

    if (!summonSuppressed) {
      WindowManager.showKeyboardOverlay();
      overlayAutoShown = true;
      logger.info("In-game keyboard auto-summoned on text focus");
    }
    return;
  }

  consecutiveFocusMisses += 1;
  summonSuppressed = false;

  if (overlayAutoShown && consecutiveFocusMisses >= FOCUS_MISSES_TO_HIDE) {
    WindowManager.hideKeyboardOverlay();
    overlayAutoShown = false;
    consecutiveFocusMisses = 0;
  }
}

export function startKeyboardOverlayWatcher() {
  if (pollTimer || process.platform !== "win32") return;

  pollTimer = setInterval(() => void pollFocus(), FOCUS_POLL_INTERVAL_MS);
  void pollFocus();
}

export function stopKeyboardOverlayWatcher() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  overlayAutoShown = false;
  summonSuppressed = false;
  consecutiveFocusMisses = 0;
  WindowManager.hideKeyboardOverlay();
}

export function syncKeyboardOverlayWatcher(hasRunningGame: boolean) {
  if (hasRunningGame) {
    startKeyboardOverlayWatcher();
  } else {
    stopKeyboardOverlayWatcher();
  }
}
