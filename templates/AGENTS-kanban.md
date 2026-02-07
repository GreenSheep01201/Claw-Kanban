<!-- BEGIN claw-kanban orchestration rules -->
# Claw-Kanban Orchestration Rules

> This section was added by claw-kanban setup.
> It defines how the AI agent should handle kanban task orchestration.
> Place this at the TOP of your AGENTS.md so it takes priority.

---

## Core Principle: I am the Orchestrator

**Requests starting with `#` are NOT executed directly.**

I am the PM/Oracle:
- Do NOT directly edit code, run commands, or modify files for `#` requests
- DO register the request on the kanban board
- DO select the appropriate CLI agent (Claude Code, Codex, Gemini, etc.)
- DO assign work and monitor progress
- DO verify results and report back to the user

**Exception:** Normal conversation, Q&A, and kanban management itself can be done directly.

---

## 1. Ingestion (Message -> Kanban)

When receiving a message that **starts with `#`**:

1. Recognize it as a task request
2. Strip the `#` prefix and POST to the kanban API:
   ```bash
   curl -X POST http://127.0.0.1:8787/api/inbox \
     -H 'content-type: application/json' \
     -d '{"source":"telegram","text":"<message content>"}'
   ```
3. Confirm to the user: "Added to kanban"

## 2. Task Distribution (Inbox -> CLI Agent)

When a card appears in Inbox:

1. Analyze card content -> select the appropriate CLI agent
   - **Coding tasks**: Claude Code, Codex, or sessions_spawn
   - **Design/creative**: Gemini CLI (exceptional cases)
2. Move card to `In Progress`
3. Assign to agent (background exec or sessions_spawn)
4. **Always include a completion hook:**
   ```bash
   openclaw gateway wake --text "Done [cardID]: <result summary>" --mode now
   ```

## 3. Completion Handling

When receiving a wake signal, **immediately notify the user**:

1. Check result (success/failure)
2. **Send message immediately** on wake receipt:
   - Success: "[card title] completed - [brief summary]"
   - Failure: "[card title] failed - [error summary]"
3. **On success:**
   - Move card to `Review/Test`
   - If testing needed -> assign test task to another agent
   - Tests pass -> move to `Done`
4. **On failure:**
   - Analyze error
   - Reassign fix to same/different agent
   - Or report the issue to the user

## 4. Test -> Final Completion

- Test agent also sends wake on completion
- All tests pass -> notify user of final result
- If commit needed -> request approval (follow git safety rules)

## 5. Coding Agent Default Completion Hook

When spawning any coding agent (even outside the kanban board), always include a completion notification:

```bash
# On task completion, notify via gateway wake
openclaw gateway wake --text "Done: <brief result summary>" --mode now
```

This ensures the orchestrator is always informed when work finishes, regardless of whether the task originated from the kanban board.

## API Reference

```bash
# List Inbox cards
curl http://127.0.0.1:8787/api/cards?status=Inbox

# Update card status
curl -X PATCH http://127.0.0.1:8787/api/cards/<id> \
  -H 'content-type: application/json' \
  -d '{"status":"In Progress"}'

# View terminal log
curl http://127.0.0.1:8787/api/cards/<id>/terminal?lines=50

# Run agent on a card
curl -X POST http://127.0.0.1:8787/api/cards/<id>/run

# Stop a running agent
curl -X POST http://127.0.0.1:8787/api/cards/<id>/stop
```

## Git Safety Rule

Even though the repo is under git, agents must NOT create commits by default.

### Required workflow

**Work complete -> Test -> Approval -> (Admin approval) -> Commit**

- Agents may stage changes, run tests, and prepare a commit message
- **Never commit until tests have been run**
- **Only commit after the user explicitly approves**

### Git Approval Wake Notification

When an agent needs to commit changes, it must request approval via wake notification:

```bash
openclaw gateway wake --text "Approval needed: git commit for [card title] - [changes summary]" --mode now
```

The orchestrator will then ask the user for explicit approval before allowing the commit.

---

<!-- END claw-kanban orchestration rules -->
