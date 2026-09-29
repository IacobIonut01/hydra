import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInnoSilentArgs,
  resolveRepackInstallStrategy,
  sanitizeInstallDirName,
} from "./repack-install-strategy.js";

describe("resolveRepackInstallStrategy", () => {
  it("returns preinstalled for archive-style sources", () => {
    for (const downloadSourceName of [
      "OnlineFix",
      "Online-Fix",
      "online fix",
      "SteamRip",
      "steam-rip",
      "RUNE",
      "TENOKE",
    ]) {
      const strategy = resolveRepackInstallStrategy({ downloadSourceName });
      assert.equal(strategy, "preinstalled", downloadSourceName);
    }
  });

  it("returns splash-unlock for repackers with a key-gated splash", () => {
    for (const downloadSourceName of ["DODI Repacks", "dodi", "DODI Repack"]) {
      assert.equal(
        resolveRepackInstallStrategy({ downloadSourceName }),
        "splash-unlock",
        downloadSourceName
      );
    }
  });

  it("returns inno-silent for installer-based repackers", () => {
    for (const downloadSourceName of [
      "FitGirl Repacks",
      "fitgirl",
      "XATAB",
      "KaOsKrew",
      "Masquerade",
      "Darck Repacks",
      "Tiny Repacks",
      "ElAmigos",
      "GOG Offline",
      "R.G. Mechanics",
    ]) {
      assert.equal(
        resolveRepackInstallStrategy({ downloadSourceName }),
        "inno-silent",
        downloadSourceName
      );
    }
  });

  it("prefers preinstalled over inno-silent when both match", () => {
    assert.equal(
      resolveRepackInstallStrategy({
        downloadSourceName: "OnlineFix",
        repackTitle: "Some Game (FitGirl Repack)",
      }),
      "preinstalled"
    );
  });

  it("detects repacker from the repack title when the source name is generic", () => {
    assert.equal(
      resolveRepackInstallStrategy({
        downloadSourceName: "Community Uploads",
        repackTitle: "Some Game v1.2.3 (DODI Repack)",
      }),
      "splash-unlock"
    );
  });

  it("returns auto-attempt for unknown sources and missing metadata", () => {
    assert.equal(
      resolveRepackInstallStrategy({ downloadSourceName: "My FTP Box" }),
      "auto-attempt"
    );
    assert.equal(resolveRepackInstallStrategy({}), "auto-attempt");
    assert.equal(
      resolveRepackInstallStrategy({ downloadSourceName: null }),
      "auto-attempt"
    );
  });
});

describe("buildInnoSilentArgs", () => {
  it("produces silent Inno flags with quoted DIR and LOG paths", () => {
    const args = buildInnoSilentArgs("D:\\Games\\My Game", "C:\\logs\\i.log");

    assert.ok(args.includes("/VERYSILENT"));
    assert.ok(args.includes("/SUPPRESSMSGBOXES"));
    assert.ok(args.includes("/NORESTART"));
    assert.ok(args.includes("/SP-"));
    assert.ok(args.includes('/DIR="D:\\Games\\My Game"'));
    assert.ok(args.includes('/LOG="C:\\logs\\i.log"'));
  });
});

describe("sanitizeInstallDirName", () => {
  it("strips characters that are invalid in folder names but keeps spaces", () => {
    assert.equal(
      sanitizeInstallDirName("Grand Theft: Auto? V"),
      "Grand Theft Auto V"
    );
    assert.equal(sanitizeInstallDirName("  Weird   Spaces  "), "Weird Spaces");
    assert.equal(sanitizeInstallDirName("<>|"), "Game");
  });
});
