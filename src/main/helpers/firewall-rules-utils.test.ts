import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getFirewallRuleName,
  parseShowRuleOutput,
  pathsMatch,
  sanitizeRuleNamePart,
} from "./firewall-rules-utils.ts";

describe("sanitizeRuleNamePart", () => {
  it("strips characters that would break the netsh argument", () => {
    assert.equal(sanitizeRuleNamePart('Half-Life "2"'), "Half-Life  2");
    assert.equal(sanitizeRuleNamePart("Line\nBreak"), "Line Break");
    assert.equal(
      sanitizeRuleNamePart("Carriage\r\nReturn"),
      "Carriage  Return"
    );
  });

  it("falls back to Game for empty titles", () => {
    assert.equal(sanitizeRuleNamePart(""), "Game");
    assert.equal(sanitizeRuleNamePart("   "), "Game");
  });
});

describe("getFirewallRuleName", () => {
  it("prefixes the title with the Hydra marker", () => {
    assert.equal(getFirewallRuleName("Celeste"), "Hydra - Celeste");
  });
});

describe("parseShowRuleOutput", () => {
  const sample = [
    "Rule Name:                            Hydra - Celeste",
    "----------------------------------------------------------------------",
    "Enabled:                              Yes",
    "Direction:                            In",
    "Profiles:                             Domain,Private,Public",
    "Grouping:",
    "LocalIP:                              Any",
    "RemoteIP:                             Any",
    "Protocol:                             Any",
    "Edge traversal:                       No",
    "Program:                              C:\\Games\\Celeste\\Celeste.exe",
    "Action:                               Allow",
    "",
    "Rule Name:                            Hydra - Celeste",
    "----------------------------------------------------------------------",
    "Enabled:                              Yes",
    "Direction:                            Out",
    "Program:                              C:\\Games\\Celeste\\celeste_launcher.exe",
    "Action:                               Allow",
    "",
  ].join("\r\n");

  it("pairs every rule name with its program line", () => {
    assert.deepEqual(parseShowRuleOutput(sample), [
      {
        name: "Hydra - Celeste",
        program: "C:\\Games\\Celeste\\Celeste.exe",
      },
      {
        name: "Hydra - Celeste",
        program: "C:\\Games\\Celeste\\celeste_launcher.exe",
      },
    ]);
  });

  it("leaves program null when the rule has no program line", () => {
    const output =
      "Rule Name:                            Hydra - Game\r\nAction:                               Allow\r\n";
    assert.deepEqual(parseShowRuleOutput(output), [
      { name: "Hydra - Game", program: null },
    ]);
  });

  it("returns an empty list for unrelated output", () => {
    assert.deepEqual(
      parseShowRuleOutput("No rules match the specified criteria."),
      []
    );
  });
});

describe("pathsMatch", () => {
  it("compares program paths case-insensitively", () => {
    assert.equal(
      pathsMatch(
        "C:\\Games\\Celeste\\Celeste.exe",
        "c:\\games\\celeste\\celeste.exe"
      ),
      true
    );
  });

  it("treats forward and back slashes as equal", () => {
    assert.equal(
      pathsMatch(
        "C:/Games/Celeste/Celeste.exe",
        "C:\\Games\\Celeste\\Celeste.exe"
      ),
      true
    );
  });

  it("rejects different programs", () => {
    assert.equal(
      pathsMatch(
        "C:\\Games\\Celeste\\Celeste.exe",
        "C:\\Games\\Celeste\\Old.exe"
      ),
      false
    );
  });
});
