import { registerEvent } from "../register-event";
import { GameShop } from "@types";
import { cancelGameLaunch } from "@main/services";

const cancelGameLaunchEvent = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  cancelGameLaunch(shop, objectId);
};

registerEvent("cancelGameLaunch", cancelGameLaunchEvent);
