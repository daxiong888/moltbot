import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

type CodexJob = {
  id: string;
  systemdUnit?: string;
  command: string;
  startedAt: number;
  workdir?: string;
};

type CodexSessionEntry = {
  jobs: CodexJob[];
  updatedAt: number;
};

type CodexJobStore = {
  version: 1;
  sessions: Record<string, CodexSessionEntry>;
};

const CODEX_JOBS_VERSION = 1;
const MAX_JOBS_PER_SESSION = 20;

function resolveCodexJobsPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
) {
  const stateDir = resolveStateDir(env, homedir);
  return path.join(stateDir, "codex", "session-jobs.json");
}

function normalizeStore(input?: Partial<CodexJobStore> | null): CodexJobStore {
  if (!input || input.version !== CODEX_JOBS_VERSION) {
    return { version: CODEX_JOBS_VERSION, sessions: {} };
  }
  return {
    version: CODEX_JOBS_VERSION,
    sessions: input.sessions ?? {},
  };
}

function dedupeJobs(jobs: CodexJob[]): CodexJob[] {
  const seen = new Set<string>();
  const filtered: CodexJob[] = [];
  for (const job of jobs) {
    if (!job?.id) continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    filtered.push(job);
  }
  return filtered;
}

async function loadStore(): Promise<{ store: CodexJobStore; filePath: string }> {
  const filePath = resolveCodexJobsPath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CodexJobStore;
    return { store: normalizeStore(parsed), filePath };
  } catch {
    return { store: normalizeStore(null), filePath };
  }
}

async function saveStore(store: CodexJobStore, filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(filePath, payload, { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best-effort on platforms without chmod.
  }
}

export async function recordCodexJob(sessionKey: string, job: CodexJob): Promise<void> {
  const { store, filePath } = await loadStore();
  const entry = store.sessions[sessionKey];
  const jobs = dedupeJobs([job, ...(entry?.jobs ?? [])]).slice(0, MAX_JOBS_PER_SESSION);
  store.sessions[sessionKey] = {
    jobs,
    updatedAt: Date.now(),
  };
  await saveStore(store, filePath);
}

export async function popCodexJobs(sessionKey: string): Promise<CodexJob[]> {
  const { store, filePath } = await loadStore();
  const entry = store.sessions[sessionKey];
  if (!entry) return [];
  delete store.sessions[sessionKey];
  await saveStore(store, filePath);
  return entry.jobs ?? [];
}
