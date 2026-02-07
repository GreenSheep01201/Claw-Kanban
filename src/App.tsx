import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { Card, CardStatus, ProviderSettings, Role, TaskType, Provider, CliStatusMap } from "./api";
import { createCard, deleteCard, getLogs, getTerminal, listCards, patchCard, purgeByStatus, runCard, stopCard, reviewCard, getSettings, saveSettings, getCliStatus, DEFAULT_PROVIDER_SETTINGS } from "./api";

const STATUSES: CardStatus[] = ["Inbox", "Planned", "In Progress", "Review/Test", "Done", "Stopped"];
const ROLES: { value: Role; label: string }[] = [
  { value: "devops", label: "Dev Ops" },
  { value: "backend", label: "BackEnd" },
  { value: "frontend", label: "FrontEnd" },
];
const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: "new", label: "New" },
  { value: "modify", label: "Modify" },
  { value: "bugfix", label: "Bugfix" },
];
const PROVIDERS: { value: Provider; label: string; desc: string }[] = [
  { value: "claude", label: "Claude Code", desc: "Claude CLI" },
  { value: "codex", label: "Codex CLI", desc: "OpenAI Codex" },
  { value: "gemini", label: "Gemini CLI", desc: "Google Gemini" },
];

function fmtTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString();
}

function groupByStatus(cards: Card[]) {
  const m: Record<CardStatus, Card[]> = {
    "Inbox": [],
    "Planned": [],
    "In Progress": [],
    "Review/Test": [],
    "Done": [],
    "Stopped": []
  };
  for (const c of cards) m[c.status].push(c);
  for (const s of STATUSES) m[s].sort((a, b) => b.updated_at - a.updated_at);
  return m;
}

export default function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [logs, setLogs] = useState<Array<{ id: number; created_at: number; kind: string; message: string }>>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const [termOpen, setTermOpen] = useState(false);
  const [termText, setTermText] = useState("");
  const [termPath, setTermPath] = useState<string | null>(null);
  const [termFollow, setTermFollow] = useState(true);
  const termRef = useRef<HTMLPreElement | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null);
  const [cliLoading, setCliLoading] = useState(false);

  const [newRole, setNewRole] = useState<Role | "">("");
  const [newTaskType, setNewTaskType] = useState<TaskType | "">("");

  async function refresh() {
    const cs = await listCards();
    setCards(cs);
    if (selected) {
      const next = cs.find((c) => c.id === selected.id) ?? null;
      setSelected(next);
      if (next) setLogs(await getLogs(next.id));
    }
  }

  async function loadSettings() {
    try {
      const s = await getSettings();
      setSettings(s);
    } catch {
      setSettings(DEFAULT_PROVIDER_SETTINGS);
    }
  }

  async function loadCliStatus(refresh?: boolean) {
    setCliLoading(true);
    try {
      const s = await getCliStatus(refresh);
      setCliStatus(s);
    } catch {
      // keep previous state on error
    } finally {
      setCliLoading(false);
    }
  }

  // Provider is available if authenticated (or if CLI status not yet loaded, assume available)
  const isProviderAvailable = (p: Provider) => cliStatus?.[p]?.authenticated ?? true;

  async function handleSaveSettings() {
    setSettingsLoading(true);
    try {
      await saveSettings(settings);
      setSettingsOpen(false);
    } catch (e) {
      const err = e as { message?: string };
      setErr(err?.message ?? String(e));
    } finally {
      setSettingsLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e)));
    loadSettings().catch(() => {});
    const t = setInterval(() => refresh().catch(() => {}), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!termOpen || !selected) return;
    let alive = true;

    async function tick() {
      try {
        const sel = selected;
        if (!sel) return;
        const t = await getTerminal(sel.id, 800, true);
        if (!alive) return;
        setTermPath(t.path);
        setTermText(t.text);
      } catch {
        // ignore
      }
    }

    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [termOpen, selected]);

  useEffect(() => {
    if (!termOpen) return;
    if (!termFollow) return;
    const el = termRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [termText, termOpen, termFollow]);

  const columns = useMemo(() => groupByStatus(cards), [cards]);

  async function move(card: Card, status: CardStatus) {
    if (card.status === status) return;
    await patchCard(card.id, { status });
    await refresh();
  }

  async function openCard(card: Card) {
    setSelected(card);
    setLogs(await getLogs(card.id));
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div className="titleGroup">
          <img src="/kanban-claw.svg" alt="Claw Kanban" className="titleIcon" />
          <div>
            <div className="title">Claw Kanban</div>
            <div className="subtitle">AI Agent Orchestration Board - Claude / Codex / Gemini</div>
          </div>
        </div>
        <div className="right">
          <button
            className="btn"
            onClick={() => {
              loadSettings();
              loadCliStatus();
              setSettingsOpen(true);
            }}
          >Settings</button>
          <button
            className="btn"
            onClick={async () => {
              if (!confirm("Purge all Inbox cards?")) return;
              await purgeByStatus("Inbox");
              await refresh();
            }}
          >Clear Inbox</button>
          <button className="btn" onClick={() => refresh()}>Refresh</button>
        </div>
      </header>

      {err ? <div className="error">{err}</div> : null}

      <section className="newcard">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New card title (e.g. fix hero card gray border bug)"
        />
        <input
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          placeholder="Description / requirements (optional)"
        />
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as Role | "")}
          className="newcard-select"
        >
          <option value="">Select Role</option>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        {newRole === "frontend" && (
          <select
            value={newTaskType}
            onChange={(e) => setNewTaskType(e.target.value as TaskType | "")}
            className="newcard-select"
          >
            <option value="">Task Type</option>
            {TASK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        )}
        <button
          className="btn primary"
          disabled={!newTitle.trim()}
          onClick={async () => {
            const title = newTitle.trim();
            if (!title) return;
            try {
              await createCard({
                title,
                description: newDesc,
                status: "Inbox",
                role: newRole || undefined,
                task_type: newTaskType || undefined,
              });
              setNewTitle("");
              setNewDesc("");
              setNewRole("");
              setNewTaskType("");
              await refresh();
            } catch (e) {
              setErr(String((e as Error).message ?? e));
            }
          }}
        >+ Add</button>
      </section>

      <main className="board">
        {STATUSES.map((s) => (
          <div key={s} className="col">
            <div className="colHeader">
              <span>{s}</span>
              <span className="badge">{columns[s].length}</span>
            </div>
            <div className="colBody">
              {columns[s].map((c) => (
                <div key={c.id} className={"card" + (selected?.id === c.id ? " selected" : "")}
                     onClick={() => openCard(c)}>
                  <div className="cardTitle">{c.title}</div>
                  <div className="cardMeta">
                    <span>{c.assignee ?? "unassigned"}</span>
                    {c.role && <span className="cardRole">{ROLES.find(r => r.value === c.role)?.label}</span>}
                    <span>·</span>
                    <span>{fmtTime(c.updated_at)}</span>
                  </div>
                  <div className="cardActions" onClick={(e) => e.stopPropagation()}>
                    <select value={c.status} onChange={(e) => move(c, e.target.value as CardStatus)}>
                      {STATUSES.map((st) => (
                        <option key={st} value={st}>{st}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>

      {selected && (
        <aside className="side">
          <div className="sideInner">
            <div className="sideHeader">
              <div className="sideTitle">{selected.title}</div>
              <button
                className="sideClose"
                onClick={() => {
                  setSelected(null);
                  setLogs([]);
                }}
                aria-label="Close"
              >×</button>
            </div>
            <div className="sideMeta">
              <div><b>ID</b> {selected.id}</div>
              <div><b>Source</b> {selected.source} {selected.source_message_id ? `(msg ${selected.source_message_id})` : ""}</div>
              <div><b>Author</b> {selected.source_author ?? "-"}</div>
              <div><b>Chat</b> {selected.source_chat ?? "-"}</div>
            </div>
            <div className="sideFieldGroup">
              <label>Role</label>
              <select
                value={selected.role || ""}
                onChange={async (e) => {
                  const role = e.target.value as Role | "";
                  setSelected({ ...selected, role: role || undefined });
                  await patchCard(selected.id, { role: role || undefined });
                  await refresh();
                }}
              >
                <option value="">None</option>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {selected.role === "frontend" && (
              <div className="sideFieldGroup">
                <label>Task Type</label>
                <select
                  value={selected.task_type || ""}
                  onChange={async (e) => {
                    const taskType = e.target.value as TaskType | "";
                    setSelected({ ...selected, task_type: taskType || undefined });
                    await patchCard(selected.id, { task_type: taskType || undefined });
                    await refresh();
                  }}
                >
                  <option value="">None</option>
                  {TASK_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="sideFieldGroup">
              <label>Provider (Assignee)</label>
              <select
                value={selected.assignee || ""}
                onChange={async (e) => {
                  const assignee = e.target.value as Provider | "";
                  setSelected({ ...selected, assignee: assignee || null });
                  await patchCard(selected.id, { assignee: assignee || undefined });
                  await refresh();
                }}
              >
                <option value="">Auto-assign</option>
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                    {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={selected.description}
              onChange={(e) => setSelected({ ...selected, description: e.target.value })}
              rows={8}
            />
            <div className="sideBtns">
              <button
                className="btn"
                onClick={async () => {
                  await patchCard(selected.id, { description: selected.description });
                  await refresh();
                }}
              >Save Description</button>
              <button
                className="btn"
                onClick={async () => {
                  setLogs(await getLogs(selected.id));
                }}
              >Refresh Logs</button>
              <button
                className="btn"
                onClick={() => setTermOpen(true)}
              >Terminal</button>

              {(selected.status === "Inbox" || selected.status === "Planned" || selected.status === "Stopped") && (
                <button
                  className="btn primary"
                  onClick={async () => {
                    if (!confirm("Start this task (run agent)?")) return;
                    await runCard(selected.id);
                    await refresh();
                    setTermOpen(true);
                  }}
                >{selected.status === "Stopped" ? "Restart" : "Start"}</button>
              )}

              {selected.status === "Review/Test" && (
                <button
                  className="btn primary"
                  onClick={async () => {
                    if (!confirm("Re-run review/test?")) return;
                    await reviewCard(selected.id);
                    await refresh();
                    setTermOpen(true);
                  }}
                >Re-review</button>
              )}

              {selected.status === "In Progress" && (
                <button
                  className="btn"
                  onClick={async () => {
                    if (!confirm("Stop this task (kill process)?")) return;
                    await stopCard(selected.id);
                    await refresh();
                  }}
                >Stop</button>
              )}

              <button
                className="btn danger"
                onClick={async () => {
                  if (!confirm("Delete this card?")) return;
                  await deleteCard(selected.id);
                  setSelected(null);
                  setLogs([]);
                  await refresh();
                }}
              >Delete</button>
            </div>

            <div className="logs">
              <div className="logsHeader">Logs (latest 500)</div>
              {logs.length === 0 ? <div className="logRow dim">(no logs)</div> : null}
              {logs.map((l) => (
                <div key={l.id} className="logRow">
                  <span className="logTime">{fmtTime(l.created_at)}</span>
                  <span className="logKind">[{l.kind}]</span>
                  <span className="logMsg">{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      )}
      {termOpen ? (
        <div className="modalOverlay" onClick={() => setTermOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Terminal · {selected?.title ?? ""}</div>
                <div className="modalSub">{termPath ?? ""}</div>
              </div>
              <div className="modalActions">
                <label className="toggle">
                  <input type="checkbox" checked={termFollow} onChange={(e) => setTermFollow(e.target.checked)} />
                  <span>follow</span>
                </label>
                <button
                  className="btn"
                  onClick={() => {
                    const el = termRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                  }}
                >Scroll to bottom</button>
                <button className="btn" onClick={() => setTermOpen(false)}>Close</button>
              </div>
            </div>
            <pre ref={termRef} className="terminal">{termText || "(no terminal log yet)"}</pre>
          </div>
        </div>
      ) : null}

      {settingsOpen && (
        <div className="modalOverlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal settingsModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Provider Settings</div>
                <div className="modalSub">Configure role-based and stage-based provider mapping</div>
              </div>
              <div className="modalActions">
                <button className="btn" onClick={() => setSettingsOpen(false)}>Close</button>
              </div>
            </div>
            <div className="settingsContent">
              <div className="settingsSection">
                <div className="settingsSectionTitle">AI Providers</div>
                <div className="cliProviders">
                  {PROVIDERS.map((p) => {
                    const st = cliStatus?.[p.value];
                    const cls = !st || cliLoading
                      ? "cliCard loading"
                      : st.installed && st.authenticated
                        ? "cliCard ready"
                        : st.installed
                          ? "cliCard warning"
                          : "cliCard missing";
                    return (
                      <div key={p.value} className={cls}>
                        <div className="cliCardName">{p.label}</div>
                        <div className="cliCardVersion">
                          {cliLoading ? "..." : st?.version ?? (st?.installed ? "installed" : "not installed")}
                        </div>
                        <div className={`cliBadge ${!st || cliLoading ? "loading" : st.installed && st.authenticated ? "ready" : st.installed ? "warning" : "missing"}`}>
                          {cliLoading
                            ? "Checking..."
                            : st?.installed && st?.authenticated
                              ? "\u2713 Ready"
                              : st?.installed
                                ? "\u26A0 Login needed"
                                : "Not installed"}
                        </div>
                        {st && !st.authenticated && st.installed && !cliLoading && (
                          <div className="cliHint">{st.authHint}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  className="btn secondary cliRecheck"
                  onClick={() => loadCliStatus(true)}
                  disabled={cliLoading}
                >{cliLoading ? "Checking..." : "Re-check"}</button>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">Auto-assign</div>
                <label className="settingsToggle">
                  <input
                    type="checkbox"
                    checked={settings.autoAssign}
                    onChange={(e) => setSettings({ ...settings, autoAssign: e.target.checked })}
                  />
                  <span>Enable role-based provider auto-assignment</span>
                </label>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">Role-based Providers</div>
                <div className="settingsGrid">
                  <div className="settingsField">
                    <label>Dev Ops</label>
                    <select
                      value={settings.roleProviders.devops}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: { ...settings.roleProviders, devops: e.target.value as Provider }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Overall orchestration and logic</span>
                  </div>

                  <div className="settingsField">
                    <label>BackEnd</label>
                    <select
                      value={settings.roleProviders.backend}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: { ...settings.roleProviders, backend: e.target.value as Provider }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Backend-focused tasks</span>
                  </div>
                </div>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">FrontEnd Providers (by task type)</div>
                <div className="settingsGrid">
                  <div className="settingsField">
                    <label>New Feature</label>
                    <select
                      value={settings.roleProviders.frontend.new}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: {
                          ...settings.roleProviders,
                          frontend: { ...settings.roleProviders.frontend, new: e.target.value as Provider }
                        }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">New UI/feature development</span>
                  </div>

                  <div className="settingsField">
                    <label>Modify / Improve</label>
                    <select
                      value={settings.roleProviders.frontend.modify}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: {
                          ...settings.roleProviders,
                          frontend: { ...settings.roleProviders.frontend, modify: e.target.value as Provider }
                        }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Modify/improve existing code</span>
                  </div>

                  <div className="settingsField">
                    <label>Bugfix</label>
                    <select
                      value={settings.roleProviders.frontend.bugfix}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: {
                          ...settings.roleProviders,
                          frontend: { ...settings.roleProviders.frontend, bugfix: e.target.value as Provider }
                        }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Bug fixes and issue resolution</span>
                  </div>
                </div>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">Stage-based Providers (optional)</div>
                <div className="settingsGrid">
                  <div className="settingsField">
                    <label>In Progress</label>
                    <select
                      value={settings.stageProviders.inProgress ?? ""}
                      onChange={(e) => setSettings({
                        ...settings,
                        stageProviders: {
                          ...settings.stageProviders,
                          inProgress: e.target.value ? e.target.value as Provider : null
                        }
                      })}
                    >
                      <option value="">Follow role settings</option>
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Default provider for In Progress stage</span>
                  </div>

                  <div className="settingsField">
                    <label>Review/Test</label>
                    <select
                      value={settings.stageProviders.reviewTest ?? ""}
                      onChange={(e) => setSettings({
                        ...settings,
                        stageProviders: {
                          ...settings.stageProviders,
                          reviewTest: e.target.value ? e.target.value as Provider : null
                        }
                      })}
                    >
                      <option value="">Follow role settings</option>
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Default provider for Review/Test stage</span>
                  </div>
                </div>
              </div>

              <div className="settingsActions">
                <button
                  className="btn"
                  onClick={() => setSettings(DEFAULT_PROVIDER_SETTINGS)}
                >Reset Defaults</button>
                <button
                  className="btn"
                  onClick={handleSaveSettings}
                  disabled={settingsLoading}
                >{settingsLoading ? "Saving..." : "Save"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
