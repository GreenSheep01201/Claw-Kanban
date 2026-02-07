import { useState } from "react";
import type { Role, TaskType } from "./api";
import { createCard } from "./api";

const ROLES: { value: Role; label: string }[] = [
  { value: "devops", label: "Dev Ops" },
  { value: "backend", label: "BackEnd" },
  { value: "frontend", label: "FrontEnd" },
];

const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: "new", label: "New Feature" },
  { value: "modify", label: "Modify / Improve" },
  { value: "bugfix", label: "Bugfix" },
];

interface NewCardModalProps {
  onClose: () => void;
  onSuccess: () => void;
  initialTitle?: string;
  initialDesc?: string;
  initialRole?: Role | "";
  initialTaskType?: TaskType | "";
}

export default function NewCardModal({
  onClose,
  onSuccess,
  initialTitle = "",
  initialDesc = "",
  initialRole = "",
  initialTaskType = "",
}: NewCardModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [desc, setDesc] = useState(initialDesc);
  const [role, setRole] = useState<Role | "">(initialRole);
  const [taskType, setTaskType] = useState<TaskType | "">(initialTaskType);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      await createCard({
        title: title.trim(),
        description: desc.trim(),
        status: "Inbox",
        role: role || undefined,
        task_type: taskType || undefined,
      });
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal newCardModal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Create New Card</div>
            <div className="modalSub">Add a new task card to the board</div>
          </div>
          <div className="modalActions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="newCardForm">
          {error && <div className="error">{error}</div>}

          <div className="formGroup">
            <label htmlFor="cardTitle">Title <span className="required">*</span></label>
            <input
              id="cardTitle"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Fix login page responsive layout issue"
              autoFocus
              required
            />
          </div>

          <div className="formRow">
            <div className="formGroup">
              <label htmlFor="cardRole">Role</label>
              <select
                id="cardRole"
                value={role}
                onChange={(e) => setRole(e.target.value as Role | "")}
              >
                <option value="">None</option>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            <div className="formGroup">
              <label htmlFor="cardTaskType">Task Type</label>
              <select
                id="cardTaskType"
                value={taskType}
                onChange={(e) => setTaskType(e.target.value as TaskType | "")}
                disabled={role !== "frontend"}
              >
                <option value="">None</option>
                {TASK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              {role !== "frontend" && role !== "" && (
                <span className="fieldHint">Only available for FrontEnd role</span>
              )}
            </div>
          </div>

          <div className="formGroup">
            <label htmlFor="cardDesc">Description</label>
            <textarea
              id="cardDesc"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Detailed description of the task..."
              rows={8}
            />
          </div>

          <div className="formActions">
            <button type="button" className="btn secondary" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={isLoading || !title.trim()}>
              {isLoading ? "Creating..." : "Create Card"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
