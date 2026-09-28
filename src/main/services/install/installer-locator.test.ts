import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstallerInFolder } from "./installer-locator.js";

describe("findInstallerInFolder", () => {
  let fixtureRoot: string;

  const makeGameDir = (name = "game") => {
    const gamePath = path.join(fixtureRoot, name);
    fs.mkdirSync(gamePath, { recursive: true });
    return gamePath;
  };

  const touch = (filePath: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
  };

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "installer-locator-"));
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns null when the folder does not exist", () => {
    assert.equal(
      findInstallerInFolder(path.join(fixtureRoot, "missing")),
      null
    );
  });

  it("returns null when the path is a file", () => {
    const filePath = path.join(fixtureRoot, "game.zip");
    touch(filePath);
    assert.equal(findInstallerInFolder(filePath), null);
  });

  it("prefers setup.exe at the root over other candidates", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "setup.exe"));
    touch(path.join(gamePath, "setup_game_1.0.exe"));
    touch(path.join(gamePath, "other.exe"));

    const result = findInstallerInFolder(gamePath);
    assert.deepEqual(result, {
      path: path.join(gamePath, "setup.exe"),
      kind: "setup",
    });
  });

  it("matches setup*.exe variants like GOG offline installers", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "setup_game_1.0_(64bit)_(12345).exe"));
    touch(path.join(gamePath, "readme.exe"));

    const result = findInstallerInFolder(gamePath);
    assert.equal(result?.kind, "setup");
    assert.equal(
      result?.path,
      path.join(gamePath, "setup_game_1.0_(64bit)_(12345).exe")
    );
  });

  it("matches setup*.exe case-insensitively", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "SETUP.EXE"));

    const result = findInstallerInFolder(gamePath);
    assert.equal(result?.kind, "setup");
  });

  it("falls back to a single root .exe as single-exe", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "bootstrapper.exe"));
    touch(path.join(gamePath, "data.bin"));

    const result = findInstallerInFolder(gamePath);
    assert.deepEqual(result, {
      path: path.join(gamePath, "bootstrapper.exe"),
      kind: "single-exe",
    });
  });

  it("does not treat multiple non-setup root exes as an installer", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "launcher.exe"));
    touch(path.join(gamePath, "uninstaller.exe"));

    assert.equal(findInstallerInFolder(gamePath), null);
  });

  it("finds setup*.exe one directory level deep", () => {
    const gamePath = makeGameDir();
    const nestedDir = path.join(gamePath, "Repack");
    touch(path.join(nestedDir, "setup_game.exe"));
    touch(path.join(nestedDir, "part1.bin"));

    const result = findInstallerInFolder(gamePath);
    assert.deepEqual(result, {
      path: path.join(nestedDir, "setup_game.exe"),
      kind: "setup",
    });
  });

  it("ignores single exes nested inside subdirectories", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "Repack", "bootstrapper.exe"));

    assert.equal(findInstallerInFolder(gamePath), null);
  });

  it("returns null for folders with no installer candidates", () => {
    const gamePath = makeGameDir();
    touch(path.join(gamePath, "game.iso"));
    touch(path.join(gamePath, "readme.txt"));

    assert.equal(findInstallerInFolder(gamePath), null);
  });
});
