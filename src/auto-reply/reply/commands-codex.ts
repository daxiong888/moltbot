import crypto from "node:crypto";
import path from "node:path";

import { runExec } from "../../process/exec.js";
import { logVerbose } from "../../globals.js";
import { resolveWorkdir } from "../../agents/bash-tools.shared.js";
import type { CommandHandler } from "./commands-types.js";
import { recordCodexJob, popCodexJobs } from "./codex-jobs.js";

const CODEX_SCOPE_KEY = "moltbot-codex";

function shellEscape(value: string): string {
  const escaped = value.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

function hashSessionKey(sessionKey: string): string {
  return crypto.createHash("sha1").update(sessionKey).digest("hex").slice(0, 10);
}

function buildUnitBase(sessionKey: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  return `${CODEX_SCOPE_KEY}-${hashSessionKey(sessionKey)}-${timestamp}`;
}

function renderCodexUsage(): string {
  return [
    "⚙️ Usage:",
    "- /codex <topic>",
    "",
    "Tip: configure commands.codex.command to point at your runner (e.g., bin/clawdbot-obsidian-research.sh).",
  ].join("\n");
}

function buildCodexCommand(params: {
  baseCommand: string;
  topic: string;
  argsTemplate?: string;
}): string {
  const { baseCommand, topic, argsTemplate } = params;
  const escapedTopic = shellEscape(topic);
  if (argsTemplate && argsTemplate.includes("{topic}")) {
    const rendered = argsTemplate.replaceAll("{topic}", escapedTopic);
    return `${baseCommand} ${rendered}`.trim();
  }
  return `${baseCommand} --topic ${escapedTopic} --no-detached`.trim();
}

async function stopCodexJobsForSession(sessionKey: string): Promise<void> {
  const jobs = await popCodexJobs(sessionKey);
  if (jobs.length === 0) return;
  for (const job of jobs) {
    if (!job.systemdUnit) continue;
    try {
      await runExec("systemctl", ["--user", "stop", job.systemdUnit]);
    } catch (err) {
      logVerbose(
        `codex: failed to stop ${job.systemdUnit} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

export const handleCodexCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/codex" && !normalized.startsWith("/codex ")) return null;
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /codex from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const codexConfig = params.cfg.commands?.codex;
  if (!codexConfig?.enabled) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "⚠️ /codex is disabled.",
          "Enable it via commands.codex.enabled=true and set commands.codex.command.",
        ].join("\n"),
      },
    };
  }

  const baseCommand = codexConfig.command?.trim();
  if (!baseCommand) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Missing commands.codex.command (path or command to run).",
      },
    };
  }

  const rawArgs = normalized === "/codex" ? "" : normalized.slice("/codex".length).trim();
  if (!rawArgs) {
    return { shouldContinue: false, reply: { text: renderCodexUsage() } };
  }

  const warnings: string[] = [];
  const requestedWorkdir = codexConfig.workdir?.trim() || params.workspaceDir;
  const workdir = resolveWorkdir(requestedWorkdir, warnings);
  const command = buildCodexCommand({
    baseCommand,
    topic: rawArgs,
    argsTemplate: codexConfig.argsTemplate?.trim(),
  });

  const unitBase = buildUnitBase(params.sessionKey);
  const unitName = `${unitBase}.scope`;
  const envPath = process.env.PATH ?? "";
  const envHome = process.env.HOME ?? "";
  const systemdArgs = [
    "--user",
    "--scope",
    "--collect",
    "--no-block",
    "--quiet",
    "--unit",
    unitBase,
    "--setenv",
    `HOME=${envHome}`,
    "--setenv",
    `PATH=${envPath}`,
    "--working-directory",
    workdir,
    "bash",
    "-lc",
    command,
  ];

  try {
    await runExec("systemd-run", systemdArgs, 10_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Failed to start /codex job (systemd-run): ${message}`,
      },
    };
  }

  await recordCodexJob(params.sessionKey, {
    id: crypto.randomUUID(),
    systemdUnit: unitName,
    command,
    startedAt: Date.now(),
    workdir,
  });

  const warningText = warnings.length ? `${warnings.join("\n")}\n` : "";
  return {
    shouldContinue: false,
    reply: {
      text: [
        warningText + `⚙️ Codex job started in systemd (${unitName}).`,
        "Check logs: journalctl --user -u <unit> -n 200",
      ].join("\n"),
    },
  };
};

export async function handleCodexResetCleanup(sessionKey?: string) {
  if (!sessionKey) return;
  await stopCodexJobsForSession(sessionKey);
}
