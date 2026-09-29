export const FIREWALL_RULE_NAME_PREFIX = "Hydra - ";

export const sanitizeRuleNamePart = (value: string) =>
  value.replace(/[\r\n"]/g, " ").trim() || "Game";

export const getFirewallRuleName = (title: string) =>
  `${FIREWALL_RULE_NAME_PREFIX}${sanitizeRuleNamePart(title)}`;

export interface FirewallRule {
  name: string;
  program: string | null;
}

export const parseShowRuleOutput = (output: string): FirewallRule[] => {
  const rules: FirewallRule[] = [];
  let current: FirewallRule | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("Rule Name:")) {
      current = {
        name: line.slice("Rule Name:".length).trim(),
        program: null,
      };
      rules.push(current);
      continue;
    }

    if (line.startsWith("Program:") && current) {
      current.program = line.slice("Program:".length).trim();
    }
  }

  return rules;
};

export const pathsMatch = (left: string, right: string) =>
  left.replaceAll("/", "\\").toLowerCase() ===
  right.replaceAll("/", "\\").toLowerCase();
