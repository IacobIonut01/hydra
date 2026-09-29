import { registerEvent } from "../register-event";
import { NativeAddon } from "@main/services";

const isProcessElevated = async () => NativeAddon.isProcessElevated();

registerEvent("isProcessElevated", isProcessElevated);
