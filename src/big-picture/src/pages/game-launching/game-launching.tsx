import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type {
  GameLaunchErrorCode,
  GameLaunchPhase,
  GameLaunchState,
  GameShop,
  LibraryGame,
} from "@types";
import { Button, Typography, VerticalFocusGroup } from "../../components";
import { useNavigationScreenActions } from "../../hooks";
import { IS_DESKTOP } from "../../constants";
import {
  getBigPictureGameDetailsPath,
} from "../../helpers/game";
import { resolvePreferredGameAssets } from "../../helpers/preferred-assets";
import { NavigationAudioService } from "../../services";
import {
  GAME_LAUNCHING_GAME_PAGE_BUTTON_ID,
  GAME_LAUNCHING_LIBRARY_BUTTON_ID,
  GAME_LAUNCHING_PAGE_REGION_ID,
  GAME_LAUNCHING_RETRY_BUTTON_ID,
  GAME_LAUNCHING_RETURN_BUTTON_ID,
} from "./navigation";

import "./game-launching.scss";

const CANCELLABLE_PHASES: ReadonlySet<GameLaunchPhase> = new Set([
  "preparing",
  "syncing-saves",
  "checking-redistributables",
  "exporting-achievements",
  "launching",
]);

const PHASE_LABEL_KEYS: Record<GameLaunchPhase, string> = {
  preparing: "game_launching_status_preparing",
  "syncing-saves": "game_launching_status_syncing_saves",
  "checking-redistributables":
    "game_launching_status_checking_redistributables",
  "exporting-achievements": "game_launching_status_exporting_achievements",
  launching: "game_launching_status_launching",
  "awaiting-process": "game_launching_status_awaiting_process",
  running: "game_launching_status_running",
  failed: "game_launching_status_failed",
};

const ERROR_LABEL_KEYS: Record<GameLaunchErrorCode, string> = {
  "executable-not-found": "game_launching_error_executable_not_found",
  "spawn-failed": "game_launching_error_spawn_failed",
  "wine-failed": "game_launching_error_wine_failed",
  "steam-protocol-failed": "game_launching_error_steam_protocol_failed",
  "cloud-save-blocked": "game_launching_error_cloud_save_blocked",
  "process-not-detected": "game_launching_error_process_not_detected",
  cancelled: "game_launching_error_cancelled",
};

const ERROR_HINT_KEYS: Partial<Record<GameLaunchErrorCode, string>> = {
  "executable-not-found": "game_launching_error_hint_executable_not_found",
  "spawn-failed": "game_launching_error_hint_spawn_failed",
  "wine-failed": "game_launching_error_hint_wine_failed",
  "steam-protocol-failed":
    "game_launching_error_hint_steam_protocol_failed",
  "process-not-detected":
    "game_launching_error_hint_process_not_detected",
};

export default function GameLaunching() {
  const { shop, objectId } = useParams<{
    shop: GameShop;
    objectId: string;
  }>();
  const navigate = useNavigate();
  const { t } = useTranslation("big_picture");

  const [game, setGame] = useState<LibraryGame | null>(null);
  const [launchState, setLaunchState] = useState<GameLaunchState | null>(null);

  const gameDetailsPath = useMemo(
    () =>
      getBigPictureGameDetailsPath({
        shop: shop!,
        objectId: objectId!,
        title: game?.title ?? null,
      }),
    [shop, objectId, game?.title]
  );

  useEffect(() => {
    if (!IS_DESKTOP || !shop || !objectId) return;

    let mounted = true;

    globalThis.window.electron
      .getGameByObjectId(shop, objectId)
      .then((result) => {
        if (mounted) setGame(result);
      })
      .catch(() => {});

    return () => {
      mounted = false;
    };
  }, [shop, objectId]);

  useEffect(() => {
    if (!IS_DESKTOP || !shop || !objectId) return;

    let mounted = true;

    globalThis.window.electron
      .getGameLaunchState(shop, objectId)
      .then((state) => {
        if (mounted && state) setLaunchState(state);
      })
      .catch(() => {});

    const unsubscribe = globalThis.window.electron.onGameLaunchState(
      (state) => {
        if (state.shop === shop && state.objectId === objectId) {
          setLaunchState(state);
        }
      }
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [shop, objectId]);

  const phase: GameLaunchPhase = launchState?.phase ?? "preparing";
  const isFailed = phase === "failed";
  const isCancelled = isFailed && launchState?.error === "cancelled";
  const canCancel = !isFailed && CANCELLABLE_PHASES.has(phase);

  const exitToGamePage = useCallback(() => {
    navigate(gameDetailsPath, { replace: true });
  }, [navigate, gameDetailsPath]);

  const exitToLibrary = useCallback(() => {
    navigate(`${IS_DESKTOP ? "/big-picture" : ""}/library`, {
      replace: true,
    });
  }, [navigate]);

  const returnToGame = useCallback(() => {
    if (!IS_DESKTOP || !shop || !objectId) return;
    globalThis.window.electron.focusRunningGame(shop, objectId);
  }, [shop, objectId]);

  const cancelLaunch = useCallback(() => {
    if (!IS_DESKTOP || !shop || !objectId) return;
    globalThis.window.electron.cancelGameLaunch(shop, objectId);
    exitToGamePage();
  }, [shop, objectId, exitToGamePage]);

  const retryLaunch = useCallback(() => {
    if (!IS_DESKTOP || !game?.executablePath || !shop || !objectId) return;

    setLaunchState(null);
    NavigationAudioService.getInstance().play("launch");
    void globalThis.window.electron.openGame(
      shop,
      objectId,
      game.executablePath,
      game.launchOptions,
      "big-picture"
    );
  }, [game, shop, objectId]);

  useEffect(() => {
    if (isCancelled) exitToGamePage();
  }, [isCancelled, exitToGamePage]);

  useNavigationScreenActions(
    useMemo(
      () => ({
        press: {
          b: () => {
            if (canCancel) {
              cancelLaunch();
              return;
            }

            exitToGamePage();
          },
        },
      }),
      [canCancel, cancelLaunch, exitToGamePage]
    )
  );

  const preferredAssets = useMemo(
    () => resolvePreferredGameAssets(game, null),
    [game]
  );
  const heroImageUrl = preferredAssets.heroSrc || null;
  const title = game?.title ?? objectId ?? "";

  return (
    <VerticalFocusGroup regionId={GAME_LAUNCHING_PAGE_REGION_ID} asChild>
      <div className="game-launching-page">
        {heroImageUrl && (
          <div
            className="game-launching-page__artwork"
            style={{ backgroundImage: `url("${heroImageUrl}")` }}
          />
        )}
        <div className="game-launching-page__scrim" />

        <div className="game-launching-page__content">
          {game?.iconUrl && (
            <img
              className="game-launching-page__icon"
              src={game.iconUrl}
              alt=""
            />
          )}

          <Typography variant="h2" className="game-launching-page__title">
            {title}
          </Typography>

          {!isFailed && (
            <div className="game-launching-page__status">
              <span
                className={
                  phase === "running"
                    ? "game-launching-page__spinner game-launching-page__spinner--done"
                    : "game-launching-page__spinner"
                }
              />
              <Typography
                variant="h5"
                className="game-launching-page__status-text"
              >
                {t(PHASE_LABEL_KEYS[phase])}
              </Typography>
            </div>
          )}

          {!isFailed && canCancel && (
            <Typography
              variant="body"
              className="game-launching-page__hint"
            >
              {t("game_launching_cancel_hint")}
            </Typography>
          )}

          {!isFailed && phase === "running" && (
            <>
              <Typography
                variant="body"
                className="game-launching-page__hint"
              >
                {t("game_launching_running_hint")}
              </Typography>
              <div className="game-launching-page__actions">
                <Button
                  focusId={GAME_LAUNCHING_RETURN_BUTTON_ID}
                  variant="primary"
                  onClick={returnToGame}
                  stealFocusOnAppear
                >
                  {t("game_launching_return_to_game")}
                </Button>
              </div>
            </>
          )}

          {isFailed && !isCancelled && (
            <div className="game-launching-page__error">
              <WarningCircleIcon
                size={40}
                className="game-launching-page__error-icon"
              />
              <Typography
                variant="h5"
                className="game-launching-page__error-text"
              >
                {launchState?.error
                  ? t(ERROR_LABEL_KEYS[launchState.error])
                  : t("game_launching_error_spawn_failed")}
              </Typography>

              {launchState?.error &&
                ERROR_HINT_KEYS[launchState.error] && (
                  <Typography
                    variant="body"
                    className="game-launching-page__error-hint"
                  >
                    {t(ERROR_HINT_KEYS[launchState.error]!)}
                  </Typography>
                )}

              {launchState?.detail && (
                <Typography
                  variant="label"
                  className="game-launching-page__error-detail"
                >
                  {launchState.detail}
                </Typography>
              )}

              <div className="game-launching-page__actions">
                {game?.executablePath && (
                  <Button
                    focusId={GAME_LAUNCHING_RETRY_BUTTON_ID}
                    variant="primary"
                    onClick={retryLaunch}
                    stealFocusOnAppear
                  >
                    {t("game_launching_retry")}
                  </Button>
                )}
                <Button
                  focusId={GAME_LAUNCHING_GAME_PAGE_BUTTON_ID}
                  variant="secondary"
                  onClick={exitToGamePage}
                  stealFocusOnAppear={!game?.executablePath}
                >
                  {t("game_launching_open_game_page")}
                </Button>
                <Button
                  focusId={GAME_LAUNCHING_LIBRARY_BUTTON_ID}
                  variant="tertiary"
                  onClick={exitToLibrary}
                >
                  {t("game_launching_back_to_library")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </VerticalFocusGroup>
  );
}
