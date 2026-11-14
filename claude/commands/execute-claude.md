---
description: Execute an implementation plan with pure Claude subagents (sonnet writes per file, opus reviews) while the main session only orchestrates and verifies.
---

# Execute (Claude) - Pure Claude Collaborative Execution

Plan → split by file → one sonnet subagent writes each file → main session verifies → opus reviews and delivers.

$ARGUMENTS

---

## Core Protocols

- **Language Protocol**: Use **English** in subagent prompts, communicate with the user in their language.
- **Single Writer per File**: Each file is assigned to exactly one sonnet subagent, which writes it directly with Write/Edit. Two writers on the same file at the same time are forbidden.
- **Main Session = Orchestrator**: The main session reads, plans the split, dispatches, verifies and reports. It does NOT write more than 30 lines of code itself; anything larger goes to a subagent. (Reason: large writes by the main session hit the delegation gate.)
- **Stop-Loss**: Do not proceed to the next phase until the current phase output is validated.
- **Prerequisite**: Only execute after the user explicitly replies "Y" to the plan output (if missing, must confirm first).
- **Stateless Subagents**: Subagents cannot see the main session. Every prompt must carry the full spec and the full current content of its file inline.
- **Direct Agent Calls Only**: Use the `Agent` tool directly. Every `Agent` call MUST carry `model` (`haiku` / `sonnet` / `opus`).
- **Temp Directory**: Always `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp` (the variable is empty in interactive sessions, so the fallback is required).

---

## Subagent Call Specification

Implementation subagent (one per file):

```
Agent({
  subagent_type: "mm-writer",
  model: "sonnet",
  description: "Write <file>",
  prompt: "<role + spec + constraints + FULL current content of the file>"
})
```

Reviewer subagent:

```
Agent({
  subagent_type: "mm-reviewer",
  model: "opus",
  description: "Review changed files",
  prompt: "<reviewer role + plan summary + FULL content of all changed files>"
})
```

Parallel dispatch: put all independent `Agent` calls in a single message.

**GateGuard**: If a subagent is blocked by GateGuard, tell it (in the retry prompt) to state the facts the gate asks for (file purpose, callers, data affected, user instruction quoted) and then retry the same Write/Edit.

---

## Execution Workflow

**Execute Task**: $ARGUMENTS

### Phase 0: Read Plan

`[Mode: Prepare]`

1. **Identify Input Type**: plan file path (e.g. `.claude/plan/xxx.md`) or direct task description.
2. **Read Plan Content**: if a path is given, read and parse it. Extract task type, implementation steps, key files, verification commands.
3. **Pre-Execution Confirmation**:
   - Direct task description, or plan missing key files: confirm with the user first.
   - Cannot confirm the user replied "Y" to the plan: must confirm again before proceeding.

---

### Phase 1: Quick Context Retrieval

`[Mode: Retrieval]`

Done by the main session. Read-only, no writes.

1. **Glob**: find target files from the plan's Implementation Steps (each step names its target files; the plans have no separate Key Files table).
2. **semble**: search key symbols, function names, type definitions and callers with `mcp__semble__search`, then `Read` the returned line. Do not Grep for content.
3. **Read**: read the target files completely, plus the types and helpers they depend on.
4. For broader exploration, call:

```
Agent({
  subagent_type: "mm-scout",
  model: "haiku",
  description: "Locate related code",
  prompt: "Locate <symbols/modules>. Return file paths and verbatim code excerpts, no summaries."
})
```

After retrieval: keep the verbatim content of every target file, you will inline it in Phase 3.

---

### Phase 2: Split Tasks by File

`[Mode: Split]`

1. Break the plan into per-file sub-tasks. One file = one sub-task = one sonnet subagent.
2. Write a table:

   | File | Operation | Responsible subagent | Depends on |
   |------|-----------|----------------------|------------|
   | path/a.ts | Modify | sonnet-A | - |
   | path/b.ts | Create | sonnet-B | a.ts exports |

3. Rules:
   - A file appearing in more than one row is an overlap: merge into one sub-task, or run the rows sequentially. Never in parallel.
   - If B needs A's new interface, fix the interface in the spec up front (signatures inline) so both can run in parallel; otherwise run A first.
   - Minimal scope: only files needed by the plan.

---

### Phase 3: Parallel Implementation

`[Mode: Implement]`

Dispatch all non-overlapping sub-tasks in one message, one sonnet subagent per file. Each prompt MUST inline:

- Task background and the plan excerpt for this file
- The complete spec for this file (exact behavior, signatures, edge cases, error handling)
- The full current content of the file (or "file does not exist, create it")
- Interfaces of other files it touches (signatures only)
- Constraints: write ONLY this file; match existing code style; no comments/docs unless necessary; no unrelated changes; use Write/Edit directly; report a 3-line summary of what changed

```
Agent({
  subagent_type: "mm-writer",
  model: "sonnet",
  description: "Write path/a.ts",
  prompt: "You are the only writer of path/a.ts. Spec: ... Current content: ... Constraints: ..."
})
```

After results return:
1. Read each written file; check it matches the spec.
2. Failure or GateGuard block: re-dispatch only that file with the missing facts added. The retry must still be the single writer of that file.
3. The main session may fix tiny issues itself (30 lines or fewer in total); anything bigger goes back to a sonnet subagent.

---

### Phase 4: Verification

`[Mode: Verify]`

Executed by the main session:

1. Run the project's existing lint / typecheck / tests, minimal related scope first (single file or module before the whole project). Prefer the verification commands listed in the plan.
2. Scratch output (if any) goes to `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp`.
3. On failure: fix it (small fixes yourself, larger ones through a sonnet subagent per file, same single-writer rule), then re-run. Skipping a failing check is not allowed.
4. Proceed to Phase 5 only when verification passes.

---

### Phase 5: Audit and Delivery

`[Mode: Audit]`

#### 5.1 Automatic Audit

After verification passes, MUST call the opus reviewer. Paste ALL changed files in full into the prompt (subagents cannot read the main session's context) together with the plan summary.

```
Agent({
  subagent_type: "mm-reviewer",
  model: "opus",
  description: "Review changed files",
  prompt: "Act as a code reviewer. Do NOT modify any files. Plan summary: ... Changed files (full content): ... Focus: security, performance, error handling, logic correctness; for frontend also accessibility, design consistency, UX. Output: prioritized issues (severity, file, rationale) and concrete fixes."
})
```

- Every Critical item must be verified by running a test or reading the code before it is adopted; reviewer output can be wrong.
- Fullstack changes: run backend and frontend reviews as two parallel `Agent` calls, each with its own files inlined.

#### 5.2 Integrate and Fix

1. Synthesize the review feedback; discard items that fail verification.
2. Apply fixes (single writer per file, small fixes by the main session, larger via sonnet).
3. Re-run Phase 4, and repeat 5.1 as needed until the risk is acceptable.

#### 5.3 Delivery Confirmation

After the audit passes, report to the user:

```markdown
## Execution Complete

### Change Summary
| File | Operation | Description |
|------|-----------|-------------|
| path/to/file.ts | Modified | Description |

### Audit Results
- opus reviewer: <Passed/Found N issues>

### Recommendations
1. [ ] <Suggested test steps>
2. [ ] <Suggested verification steps>
```

---

## Key Rules

1. **Single Writer per File** – one sonnet subagent per file, no parallel writers on the same file
2. **Orchestrate, Don't Write** – the main session writes at most 30 lines of code in total
3. **Inline Everything** – each subagent prompt carries its file's full content and spec
4. **Model on Every Call** – every `Agent` call sets `model`
5. **Verify Before Review** – lint/tests must pass, never skipped
6. **Mandatory Audit** – opus review after changes; Critical items verified before adoption
7. **Prerequisite** – user must have replied "Y" to the plan

---

## Usage

```bash
# Execute plan file
/execute-claude .claude/plan/feature-name.md

# Execute task directly (for plans already discussed in context)
/execute-claude implement user authentication based on previous plan
```
