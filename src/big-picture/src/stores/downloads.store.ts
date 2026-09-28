import { create } from "zustand";
import type { DownloadProgress, SeedingStatus } from "@types";

const SPEED_HISTORY_SAMPLE_SIZE = 120;

interface BigPictureDownloadsStoreState {
  lastPacket: DownloadProgress | null;
  seedingStatuses: SeedingStatus[];
  extractionProgressByGameId: Record<string, number>;
  installProgressByGameId: Record<string, number>;
  speedHistoryByGameId: Record<string, number[]>;
  peakSpeedByGameId: Record<string, number>;
  setLastPacket: (packet: DownloadProgress | null) => void;
  setSeedingStatuses: (statuses: SeedingStatus[]) => void;
  setExtractionProgress: (
    shop: string,
    objectId: string,
    progress: number
  ) => void;
  clearExtractionProgress: (shop: string, objectId: string) => void;
  setInstallProgress: (
    shop: string,
    objectId: string,
    bytesWritten: number
  ) => void;
  clearInstallProgress: (shop: string, objectId: string) => void;
}

export const useBigPictureDownloadsStore =
  create<BigPictureDownloadsStoreState>((set) => ({
    lastPacket: null,
    seedingStatuses: [],
    extractionProgressByGameId: {},
    installProgressByGameId: {},
    speedHistoryByGameId: {},
    peakSpeedByGameId: {},
    setLastPacket: (packet) => {
      set((state) => {
        if (
          packet?.progress === 1 &&
          !packet.isCheckingFiles &&
          !packet.isDownloadingMetadata
        ) {
          return {
            ...state,
            lastPacket: null,
          };
        }

        if (
          !packet?.gameId ||
          packet.downloadSpeed == null ||
          packet.isCheckingFiles ||
          packet.isDownloadingMetadata
        ) {
          return {
            ...state,
            lastPacket: packet,
          };
        }

        const currentHistory = state.speedHistoryByGameId[packet.gameId] ?? [];
        const nextHistory = [...currentHistory, packet.downloadSpeed];

        if (nextHistory.length > SPEED_HISTORY_SAMPLE_SIZE) {
          nextHistory.splice(0, nextHistory.length - SPEED_HISTORY_SAMPLE_SIZE);
        }

        const currentPeak = state.peakSpeedByGameId[packet.gameId] ?? 0;

        return {
          ...state,
          lastPacket: packet,
          speedHistoryByGameId: {
            ...state.speedHistoryByGameId,
            [packet.gameId]: nextHistory,
          },
          peakSpeedByGameId: {
            ...state.peakSpeedByGameId,
            [packet.gameId]: Math.max(currentPeak, packet.downloadSpeed),
          },
        };
      });
    },
    setSeedingStatuses: (statuses) => {
      set((state) => ({
        ...state,
        seedingStatuses: statuses,
      }));
    },
    setExtractionProgress: (shop, objectId, progress) => {
      const gameId = `${shop}:${objectId}`;

      set((state) => ({
        ...state,
        extractionProgressByGameId: {
          ...state.extractionProgressByGameId,
          [gameId]: progress,
        },
      }));
    },
    clearExtractionProgress: (shop, objectId) => {
      const gameId = `${shop}:${objectId}`;

      set((state) => {
        if (!(gameId in state.extractionProgressByGameId)) {
          return state;
        }

        const nextExtractionProgressByGameId = {
          ...state.extractionProgressByGameId,
        };
        delete nextExtractionProgressByGameId[gameId];

        return {
          ...state,
          extractionProgressByGameId: nextExtractionProgressByGameId,
        };
      });
    },
    setInstallProgress: (shop, objectId, bytesWritten) => {
      const gameId = `${shop}:${objectId}`;

      set((state) => ({
        ...state,
        installProgressByGameId: {
          ...state.installProgressByGameId,
          [gameId]: bytesWritten,
        },
      }));
    },
    clearInstallProgress: (shop, objectId) => {
      const gameId = `${shop}:${objectId}`;

      set((state) => {
        if (!(gameId in state.installProgressByGameId)) {
          return state;
        }

        const nextInstallProgressByGameId = {
          ...state.installProgressByGameId,
        };
        delete nextInstallProgressByGameId[gameId];

        return {
          ...state,
          installProgressByGameId: nextInstallProgressByGameId,
        };
      });
    },
  }));

let downloadsStoreInitialized = false;

export function initializeBigPictureDownloadsStore() {
  if (downloadsStoreInitialized) return;
  if (typeof globalThis.window === "undefined") return;

  downloadsStoreInitialized = true;

  const store = useBigPictureDownloadsStore;

  globalThis.window.electron.onDownloadProgress((downloadProgress) => {
    store.getState().setLastPacket(downloadProgress);
  });

  globalThis.window.electron.onSeedingStatus((statuses) => {
    store.getState().setSeedingStatuses(statuses);
  });

  globalThis.window.electron.onExtractionProgress(
    (shop, objectId, progress) => {
      store.getState().setExtractionProgress(shop, objectId, progress);
    }
  );

  globalThis.window.electron.onExtractionComplete((shop, objectId) => {
    store.getState().clearExtractionProgress(shop, objectId);
  });

  globalThis.window.electron.onExtractionFailed((shop, objectId) => {
    store.getState().clearExtractionProgress(shop, objectId);
  });

  globalThis.window.electron.onInstallProgress(
    (shop, objectId, bytesWritten) => {
      store.getState().setInstallProgress(shop, objectId, bytesWritten);
    }
  );

  globalThis.window.electron.onInstallComplete((shop, objectId) => {
    store.getState().clearInstallProgress(shop, objectId);
  });

  globalThis.window.electron.onInstallFailed((shop, objectId) => {
    store.getState().clearInstallProgress(shop, objectId);
  });
}
