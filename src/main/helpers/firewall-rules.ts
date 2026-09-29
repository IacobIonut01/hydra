import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { logger } from "@main/services";
import {
  getFirewallRuleName,
  parseShowRuleOutput,
  pathsMatch,
  type FirewallRule,
} from "./firewall-rules-utils";

const execFileAsync = promisify(execFile);

const runNetsh = async (args: string[]) =>
  execFileAsync("netsh", args, { windowsHide: true });

/**
 * Ensures an inbound allow firewall rule exists for the game executable.
 * Best-effort: failures are logged and never block the launch.
 * Requires an elevated process on Windows; callers must check elevation first.
 */
export const ensureFirewallAllowRule = async (
  executablePath: string,
  title: string
) => {
  if (process.platform !== "win32") return;

  const ruleName = getFirewallRuleName(title);

  try {
    let existingRules: FirewallRule[] = [];

    try {
      const { stdout } = await runNetsh([
        "advfirewall",
        "firewall",
        "show",
        "rule",
        `name=${ruleName}`,
        "verbose",
      ]);
      existingRules = parseShowRuleOutput(stdout);
    } catch {
      // `show rule` exits non-zero when no rule matches the name.
    }

    if (
      existingRules.some(
        (rule) => rule.program && pathsMatch(rule.program, executablePath)
      )
    ) {
      return;
    }

    if (existingRules.length) {
      await runNetsh([
        "advfirewall",
        "firewall",
        "delete",
        "rule",
        `name=${ruleName}`,
      ]);
    }

    await runNetsh([
      "advfirewall",
      "firewall",
      "add",
      "rule",
      `name=${ruleName}`,
      "dir=in",
      "action=allow",
      `program=${executablePath}`,
      "enable=yes",
      "profile=any",
    ]);

    logger.info("Firewall allow rule created", {
      ruleName,
      program: executablePath,
      executableName: path.basename(executablePath),
    });
  } catch (error) {
    logger.warn("Failed to ensure firewall allow rule", {
      ruleName,
      executablePath,
      error,
    });
  }
};
