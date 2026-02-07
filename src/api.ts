export type CardStatus = "Inbox" | "Planned" | "In Progress" | "Review/Test" | "Done" | "Stopped";
export type Assignee = "claude" | "codex" | "gemini" | null;
export type Role = "devops" | "backend" | "frontend";
export type Provider = "claude" | "codex" | "gemini";
export type TaskType = "new" | "modify" | "bugfix";

export interface ProviderSettings {
  roleProviders: {
    devops: Provider;
    backend: Provider;
    frontend: {
      new: Provider;
      modify: Provider;
      bugfix: Provider;
    };
  };
  stageProviders: {
    inProgress: Provider | null;
    reviewTest: Provider | null;
  };
  autoAssign: boolean;
}

export interface Card {
  id: string;
  created_at: number;
  updated_at: number;
  source: string;
  source_message_id?: string | null;
  source_author?: string | null;
  source_chat?: string | null;
  title: string;
  description: string;
  status: CardStatus;
  assignee?: Assignee;
  priority: number;
  role?: Role;
  task_type?: TaskType;
}

export interface CardLog {
  id: number;
  card_id: string;
  created_at: number;
  kind: string;
  message: string;
}

export interface CliToolStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authHint: string;
}

export type CliStatusMap = Record<Provider, CliToolStatus>;

const base = ""; // same origin (vite proxy)

export async function listCards(): Promise<Card[]> {
  const r = await fetch(`${base}/api/cards`);
  if (!r.ok) throw new Error(`listCards failed: ${r.status}`);
  const j = await r.json();
  return j.cards as Card[];
}

export async function createCard(input: {
  title: string;
  description: string;
  status?: CardStatus;
  assignee?: Exclude<Assignee, null>;
  priority?: number;
  role?: Role;
  task_type?: TaskType;
}): Promise<string> {
  const r = await fetch(`${base}/api/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "manual", ...input })
  });
  if (!r.ok) throw new Error(`createCard failed: ${r.status}`);
  const j = await r.json();
  return j.id as string;
}

export async function patchCard(id: string, patch: Partial<Pick<Card, "title" | "description" | "status" | "priority" | "assignee" | "role" | "task_type">>): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(`patchCard failed: ${r.status}`);
}

export async function deleteCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`deleteCard failed: ${r.status}`);
}

export async function purgeByStatus(status: CardStatus): Promise<number> {
  const r = await fetch(`${base}/api/cards/purge?status=${encodeURIComponent(status)}`, { method: "POST" });
  if (!r.ok) throw new Error(`purgeByStatus failed: ${r.status}`);
  const j = await r.json();
  return j.deleted as number;
}

export async function getLogs(id: string): Promise<CardLog[]> {
  const r = await fetch(`${base}/api/cards/${id}/logs`);
  if (!r.ok) throw new Error(`getLogs failed: ${r.status}`);
  const j = await r.json();
  return j.logs as CardLog[];
}

export async function getTerminal(id: string, lines = 400, pretty = true): Promise<{ exists: boolean; path: string; text: string }> {
  const r = await fetch(`${base}/api/cards/${id}/terminal?lines=${lines}&pretty=${pretty ? 1 : 0}`);
  if (!r.ok) throw new Error(`getTerminal failed: ${r.status}`);
  const j = await r.json();
  return { exists: j.exists as boolean, path: j.path as string, text: j.text as string };
}

export async function runCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}/run`, { method: "POST" });
  if (!r.ok) throw new Error(`runCard failed: ${r.status}`);
}

export async function stopCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}/stop`, { method: "POST" });
  if (!r.ok) throw new Error(`stopCard failed: ${r.status}`);
}

export async function reviewCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}/review`, { method: "POST" });
  if (!r.ok) throw new Error(`reviewCard failed: ${r.status}`);
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  roleProviders: {
    devops: "claude",
    backend: "codex",
    frontend: {
      new: "gemini",
      modify: "claude",
      bugfix: "claude",
    },
  },
  stageProviders: {
    inProgress: null,
    reviewTest: null,
  },
  autoAssign: true,
};

export async function getSettings(): Promise<ProviderSettings> {
  const r = await fetch(`${base}/api/settings`);
  if (!r.ok) throw new Error(`getSettings failed: ${r.status}`);
  const j = await r.json();
  return j.settings as ProviderSettings;
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  const r = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings)
  });
  if (!r.ok) throw new Error(`saveSettings failed: ${r.status}`);
}

export async function getCliStatus(refresh?: boolean): Promise<CliStatusMap> {
  const q = refresh ? "?refresh=1" : "";
  const r = await fetch(`${base}/api/cli-status${q}`);
  if (!r.ok) throw new Error(`getCliStatus failed: ${r.status}`);
  const j = await r.json();
  return j.providers as CliStatusMap;
}
