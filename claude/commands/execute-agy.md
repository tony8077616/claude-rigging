---
description: Execute a multi-model implementation plan with agy (Antigravity) models while preserving Claude as the only filesystem writer.
---

# Execute (agy) - Multi-Model Collaborative Execution

Multi-model collaborative execution - Get prototype from plan → Claude refactors and implements → agy audit and delivery.

> **Prerequisite:** Requires the `agy` CLI on PATH and the role prompts in `~/.claude/prompts/agy/` (analyzer.md, architect.md, frontend.md, reviewer.md). Codex is not used in this command.

$ARGUMENTS

---

## Core Protocols

- **Language Protocol**: Use **English** when interacting with tools/models, communicate with user in their language
- **Code Sovereignty**: External models have **zero filesystem write access**, all modifications by Claude. They output Unified Diff only.
- **Dirty Prototype Refactoring**: Treat agy Unified Diff as "dirty prototype", must refactor to production-grade code
- **Stop-Loss Mechanism**: Do not proceed to next phase until current phase output is validated
- **Prerequisite**: Only execute after user explicitly replies "Y" to the plan output (if missing, must confirm first)
- **Stateless Calls**: agy calls keep no session. Every call must carry all needed context (plan, key files, constraints) in its prompt.

---

## Multi-Model Call Specification

**Per-phase model table** (model names come from `agy models`; override per phase if the user asks):

| Phase | Default model |
|-------|---------------|
| Analysis / Planning | `gemini-4-argon-high` |
| Implementation prototype | `gemini-3.8-flash-high` |
| Review / Audit | `gemini-3.8-flash-high` |

agy's Claude models (`claude-*`) are manual fallback only. They are NOT in the automatic path; use one only when the user explicitly asks.

**Call Syntax** (parallel: use `run_in_background: true`):

Step 1 - write the prompt file (role prompt + task) under `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/`. Keep each prompt under ~25KB; split larger inputs into several calls (e.g. per file or per module).

```
Bash({
  command: "mkdir -p \"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp\" && { cat ~/.claude/prompts/agy/<role>.md; cat <<'EOF'
DO NOT use any tools. Output text only.

<TASK>
Requirement: <task description>
Context: <plan content + target files + relevant code excerpts>
</TASK>
OUTPUT: Unified Diff Patch ONLY. Strictly prohibit any actual modifications.
EOF
} > \"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/prompt-<phase>.txt\"",
  description: "Write agy prompt file"
})
```

Step 2 - call agy. `--mode plan` MUST be present: since agy 1.5.7, headless runs default to Auto mode, which writes files. `--model` MUST come before `-p`. agy does not read stdin, so pass the file content via `$(cat ...)`.

```
Bash({
  command: "agy --mode plan --model <MODEL> -p \"$(cat \"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/prompt-<phase>.txt\")\"",
  run_in_background: true,
  timeout: 3600000,
  description: "Brief description"
})
```

**Failure rule**: the call FAILED if exit code is non-zero, stdout is empty, or stdout contains `antigravity-cli/brain/` or `implementation plan artifact` without a ```diff block (plan mode turned the reply into an artifact). Transient failures (non-zero exit, empty output, 429/503) retry the same model after a backoff of 30s, then 90s, run as a background Bash `sleep`. Artifact failures retry once immediately. When retries are exhausted, start each phase at its default model from the table, then move to the remaining untried models in the failover chain `gemini-4-argon-high` → `gemini-4-hydrogen-high` → `gemini-3.8-flash-high` (implementation and review default to `gemini-3.8-flash-high`, so they try argon and then hydrogen); if the whole chain fails, ask the user (AskUserQuestion) before doing the work Claude-only. Do not write the diff yourself to replace a failed agy call.

**Audit Call** (Code Review / Audit) - prompt file content:

```
<reviewer.md content>
DO NOT use any tools. Output text only.

<TASK>
Scope: Audit the final code changes.
Inputs:
- The applied patch (git diff / final unified diff; in a non-git project, send the full file contents instead)
- The touched files (relevant excerpts if needed)
- The plan summary (agy is stateless, restate the intent)
Constraints:
- Do NOT modify any files.
- Do NOT output tool commands that assume filesystem access.
</TASK>
OUTPUT:
1) A prioritized list of issues (severity, file, rationale)
2) Concrete fixes; if code changes are needed, include a Unified Diff Patch in a fenced code block.
```

Run it with the Review model from the table above.

**Role Prompts**:

| Phase | Role prompt |
|-------|-------------|
| Implementation (frontend) | `~/.claude/prompts/agy/frontend.md` |
| Implementation (backend) | `~/.claude/prompts/agy/architect.md` |
| Analysis | `~/.claude/prompts/agy/analyzer.md` |
| Review | `~/.claude/prompts/agy/reviewer.md` |

**Wait for Background Tasks**: a background Bash call sends a completion notification. Do not poll.

```
Read({ file_path: "<output file path from the background-start message>" })
```

**IMPORTANT**:
- Pass `timeout: 3600000` on agy background calls; a background command stops at its own timeout (default 30 min, max 2 h)
- Do not kill a running agy process; wait for the completion notification
- If a background call was stopped at its timeout, **MUST call `AskUserQuestion` to ask whether to raise the timeout and rerun or split the work**
- If agy returns 503, the service is temporarily unavailable: wait and retry, do not treat it as a code problem

---

## Execution Workflow

**Execute Task**: $ARGUMENTS

### Phase 0: Read Plan

`[Mode: Prepare]`

1. **Identify Input Type**:
   - Plan file path (e.g., `.claude/plan/xxx.md`)
   - Direct task description

2. **Read Plan Content**:
   - If plan file path provided, read and parse
   - Extract: task type, implementation steps, key files

3. **Pre-Execution Confirmation**:
   - If input is "direct task description" or plan is missing key files: confirm with user first
   - If cannot confirm user replied "Y" to plan: must confirm again before proceeding

4. **Task Type Routing**:

   | Task Type | Detection | Route |
   |-----------|-----------|-------|
   | **Frontend** | Pages, components, UI, styles, layout | agy `frontend.md` |
   | **Backend** | API, interfaces, database, logic, algorithms | agy `architect.md` |
   | **Fullstack** | Contains both frontend and backend | agy `frontend.md` ∥ agy `architect.md` parallel |

**Preflight** (read-only, before any agy call): `agy --version` runs; `agy --help` lists `--mode`; `agy models` lists every ID in the failover chain. If any check fails, stop and report; write no prompt files.

---

### Phase 1: Quick Context Retrieval

`[Mode: Retrieval]`

**Retrieval** (semble, per CLAUDE.md):

Based on the "Key Files" list in the plan, call `mcp__semble__search` with a query built from the key files, modules and function names, then `Read` the file at the returned line.

**Retrieval Strategy**:
- Extract target paths from plan's "Key Files" table
- Build semantic query covering: entry files, dependency modules, related type definitions
- If results insufficient, add 1-2 recursive retrievals

**Fallback tools**:
1. **Glob**: find target files from the plan's "Key Files" table
2. **semble**: search key symbols, function names and type definitions (`mcp__semble__search`); do not Grep for content
3. **Read**: read the discovered files to gather complete context
4. **Agent (Explore)**: for broader exploration, `Agent({subagent_type: "mm-scout", model: "haiku", ...})`

**After Retrieval**:
- Organize retrieved code snippets
- Confirm complete context for implementation
- Proceed to Phase 2

---

### Phase 2: Prototype Acquisition

`[Mode: Prototype]`

**Route Based on Task Type** (model: Implementation prototype row of the table):

#### Route A: Frontend/UI/Styles → agy frontend.md

**Limit**: Context < 32k tokens, and each prompt file < ~25KB

1. Build prompt file from `~/.claude/prompts/agy/frontend.md`
2. Input: Plan content + retrieved context + target files (all inline, agy is stateless)
3. OUTPUT: `Unified Diff Patch ONLY. Strictly prohibit any actual modifications.`
4. **agy frontend is the design authority, its CSS/React/Vue prototype is the final visual baseline**
5. **WARNING**: Ignore its backend logic suggestions

#### Route B: Backend/Logic/Algorithms → agy architect.md

1. Build prompt file from `~/.claude/prompts/agy/architect.md`
2. Input: Plan content + retrieved context + target files (all inline)
3. OUTPUT: `Unified Diff Patch ONLY. Strictly prohibit any actual modifications.`
4. **architect.md is the backend logic authority, leverage its logical reasoning and debug capabilities**

#### Route C: Fullstack → Parallel Calls

1. **Parallel Calls** (`run_in_background: true`), one prompt file each (`prompt-frontend.txt`, `prompt-backend.txt`):
   - agy with `frontend.md`: Handle frontend part
   - agy with `architect.md`: Handle backend part
2. Wait for both completion notifications, then Read both output files
3. Each prompt restates the shared plan, since there is no session to resume

**Follow the `IMPORTANT` instructions in `Multi-Model Call Specification` above**

---

### Phase 3: Code Implementation

`[Mode: Implement]`

**Claude as Code Sovereign executes the following steps**:

1. **Read Diff**: Parse Unified Diff Patch returned by agy

2. **Mental Sandbox**:
   - Simulate applying Diff to target files
   - Check logical consistency
   - Identify potential conflicts or side effects

3. **Refactor and Clean**:
   - Refactor "dirty prototype" to **highly readable, maintainable, enterprise-grade code**
   - Remove redundant code
   - Ensure compliance with project's existing code standards
   - **Do not generate comments/docs unless necessary**, code should be self-explanatory

4. **Minimal Scope**:
   - Changes limited to requirement scope only
   - **Mandatory review** for side effects
   - Make targeted corrections

5. **Apply Changes**:
   - Use Edit/Write tools to execute actual modifications
   - **Only modify necessary code**, never affect user's other existing functionality

6. **Self-Verification** (strongly recommended):
   - Run project's existing lint / typecheck / tests (prioritize minimal related scope)
   - If failed: fix regressions first, then proceed to Phase 4

---

### Phase 4: Audit and Delivery

`[Mode: Audit]`

#### 4.1 Automatic Audit

**After changes take effect, MUST immediately call** agy reviewer for Code Review (Review model from the table):

1. **agy Review** (`run_in_background: true`):
   - Role prompt: `~/.claude/prompts/agy/reviewer.md`
   - Input: Changed Diff + target files + plan summary (non-git project: no diff is available, send the full file contents)
   - Verify each Critical finding by running the tests before acting on it; reviewer output can be wrong
   - Focus: Security, performance, error handling, logic correctness; for frontend changes also accessibility, design consistency, user experience
   - For fullstack changes, run backend and frontend reviews in parallel as two prompt files

Wait for the completion notifications, then Read the output files. Calls are stateless, so restate the context in each prompt.

#### 4.2 Integrate and Fix

1. Synthesize review feedback
2. Weigh by trust rules: Backend follows architect.md output, Frontend follows frontend.md output
3. Execute necessary fixes
4. Repeat Phase 4.1 as needed (until risk is acceptable)

#### 4.3 Cleanup and Delivery

Remove the prompt files this run wrote, by exact name (for example `rm -f "${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/prompt-frontend.txt"`). Do not use a glob: parallel runs may own other prompt files.

After audit passes, report to user:

```markdown
## Execution Complete

### Change Summary
| File | Operation | Description |
|------|-----------|-------------|
| path/to/file.ts | Modified | Description |

### Audit Results
- agy reviewer: <Passed/Found N issues>

### Recommendations
1. [ ] <Suggested test steps>
2. [ ] <Suggested verification steps>
```

---

## Key Rules

1. **Code Sovereignty** – All file modifications by Claude, external models have zero write access
2. **Dirty Prototype Refactoring** – agy output treated as draft, must refactor
3. **Trust Rules** – Backend follows architect.md, Frontend follows frontend.md
4. **Minimal Changes** – Only modify necessary code, no side effects
5. **Mandatory Audit** – Must run agy reviewer after changes
6. **Stateless** – No session IDs; pass context in every prompt

---

## Usage

```bash
# Execute plan file
/execute-agy .claude/plan/feature-name.md

# Execute task directly (for plans already discussed in context)
/execute-agy implement user authentication based on previous plan
```

---

## 已驗證事實

- `agy --mode plan --model <MODEL>` 必須放在 `-p` 之前。
- agy 1.5.7 起 headless `-p` 預設為 Auto 模式，不加 `--mode plan` 時會直接寫檔（2026-11-14 實測）。`--mode plan` 實測可擋寫入，且分析與 diff 輸出仍回傳 stdout 文字。
- Claude Code 2.1.277 起已移除 `TaskOutput`，背景 Bash 完成時會通知，改用 Read 讀輸出檔。
- 本指令直接呼叫 agy CLI，不經過 wrapper（`codeagent-wrapper` 已移除）。
- `agy -p` 不讀取 stdin，prompt 必須用 `-p "$(cat file)"` 傳入。
- agy 回傳 503 代表服務暫時不可用，稍後重試即可。
- 本指令不使用 Codex（Codex is not used）。
