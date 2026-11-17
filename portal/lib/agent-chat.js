/**
 * Copilot Studio agent chat configuration.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { resolvePortalDataDir } from "./storage-config.js";

function getAgentChatConfigPath(env = process.env) {
  return resolve(resolvePortalDataDir(env), "agent-chat-config.json");
}

const DEFAULT_CONFIG = {
  tokenEndpoint: "",
  agentName: "Lab Assistant",
};

export function loadAgentChatConfig(env = process.env) {
  try {
    const configPath = getAgentChatConfigPath(env);
    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG, configured: false };
    }

    const raw = readFileSync(configPath, "utf8").trim();
    if (!raw) {
      return { ...DEFAULT_CONFIG, configured: false };
    }

    const config = JSON.parse(raw);
    const tokenEndpoint = String(config.tokenEndpoint || "").trim();
    const agentName = String(config.agentName || DEFAULT_CONFIG.agentName).trim() || DEFAULT_CONFIG.agentName;

    return {
      tokenEndpoint,
      agentName,
      configured: Boolean(tokenEndpoint),
    };
  } catch {
    return { ...DEFAULT_CONFIG, configured: false };
  }
}

export function saveAgentChatConfig(config, env = process.env) {
  const dataRoot = resolvePortalDataDir(env);
  mkdirSync(dataRoot, { recursive: true });

  const sanitized = {
    tokenEndpoint: String(config?.tokenEndpoint || "").trim(),
    agentName: String(config?.agentName || DEFAULT_CONFIG.agentName).trim() || DEFAULT_CONFIG.agentName,
  };

  writeFileSync(getAgentChatConfigPath(env), JSON.stringify(sanitized, null, 2));

  return {
    ...sanitized,
    configured: Boolean(sanitized.tokenEndpoint),
  };
}
