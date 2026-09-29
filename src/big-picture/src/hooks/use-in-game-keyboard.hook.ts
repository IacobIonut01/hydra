import { useEffect } from "react";
import { GamepadButtonType } from "../types";
import { useBigPictureRunningGamesStore } from "../stores";
import { useGamepad } from "./use-gamepad.hook";
import { useUserPreferences } from "./use-user-preferences.hook";

/**
 * Watches for the Guide + X chord while a game is running and toggles the
 * in-game keyboard overlay. Big Picture keeps polling gamepads while hidden
 * (`backgroundThrottling: false` on the window), so the chord stays live
 * during play.
 */
export function useInGameKeyboardChord(enabled: boolean) {
  const { isButtonPressed, onButtonPressed, isActiveGamepadEvent } =
    useGamepad();
  const userPreferences = useUserPreferences();
  const runningGamesById = useBigPictureRunningGamesStore(
    (state) => state.runningGamesById
  );

  const hasRunningGame = Object.keys(runningGamesById).length > 0;
  const isEnabled =
    enabled &&
    hasRunningGame &&
    (userPreferences?.bigPictureGameModeEnabled ?? false) &&
    (userPreferences?.bigPictureInGameKeyboardEnabled ?? true);

  useEffect(() => {
    if (!isEnabled) return;
    if (typeof globalThis.window.electron?.toggleKeyboardOverlay !== "function")
      return;

    return onButtonPressed(GamepadButtonType.BUTTON_X, (event) => {
      if (!isActiveGamepadEvent(event)) return;
      if (!isButtonPressed(GamepadButtonType.HOME)) return;

      void globalThis.window.electron.toggleKeyboardOverlay();
    });
  }, [isEnabled, isButtonPressed, isActiveGamepadEvent, onButtonPressed]);
}
