import type { ControllerProfile } from "@types";
import { db } from "../level";
import { levelKeys } from "./keys";

export const controllerProfilesSublevel = db.sublevel<
  string,
  ControllerProfile
>(levelKeys.controllerProfiles, { valueEncoding: "json" });
