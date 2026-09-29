import { registerEvent } from "../register-event";
import { GameShop } from "@types";
import { getGameLaunchState } from "@main/services";

const getGameLaunchStateEvent = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  return getGameLaunchState(shop, objectId);
};

registerEvent("getGameLaunchState", getGameLaunchStateEvent);
