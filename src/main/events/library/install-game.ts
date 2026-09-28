import { registerEvent } from "../register-event";
import {
  cancelGameInstall,
  enqueueGameInstall,
} from "@main/services/install/auto-install-manager";
import { GameShop } from "@types";

const installGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const result = await enqueueGameInstall(shop, objectId);
  return { ok: true, result };
};

const cancelInstallGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const cancelled = await cancelGameInstall(shop, objectId);
  return { ok: true, cancelled };
};

registerEvent("installGame", installGame);
registerEvent("cancelGameInstall", cancelInstallGame);
