---
description: Create a Claude-only multi-perspective implementation plan (haiku extraction, sonnet red team, opus synthesis) without modifying production code.
---

# Plan (Claude) - Claude-Only Multi-Perspective Planning

Claude-only planning - haiku extracts context → sonnet attacks it (Red Team) → opus synthesizes one plan. No external model, no wrapper.

$ARGUMENTS

---

## Core Protocols

- **Language Protocol**: Use **English** when prompting sub-agents, communicate with the user in their language.
- **Read-only**: This command never modifies production code. The only file it writes is the plan draft and temp files.
- **Every `Agent` call MUST set `model`** (`haiku` / `sonnet` / `opus`). Never omit it.
- **Model on every agent call**: every `Agent` call, and every `agent()` if you run a phase in a Workflow, sets `model`. Workflow is allowed (user choice). `dispatch-workflow.js` warns when a Workflow `agent()` lacks `model`, but the direct-Agent quota (`dispatch-ratio.js`) does not count Workflow agents: keep the haiku/sonnet/opus ratio yourself.
- **Sub-agents are blind**: A sub-agent cannot see this session's context. Every prompt must carry all inputs inline (task, plan content, code, prior reports).
- **Temp directory**: always `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp` (`CLAUDE_JOB_DIR` is empty in interactive sessions, so the fallback is required). Never write to a bare system temp path; parallel jobs would overwrite each other.
- **Stop-Loss**: Do not enter the next phase until the current phase output is validated.

---

## Execution Workflow

**Plan Task**: $ARGUMENTS

### Phase 0: Prepare

`[Mode: Prepare]`

1. If `$ARGUMENTS` is a path to an existing plan file, read it and use it as the requirement. Otherwise treat `$ARGUMENTS` as the task description.
2. Classify the input before dispatch: `clarify` (unclear scope, target files, or acceptance criteria): ask the user first with `AskUserQuestion` and dispatch nothing; `explore` (direction is broad or high-impact): run the full flow; `small` (clear and bounded): tell the user this looks like a small change and ask whether to skip multi-model planning. Do not guess.
3. Create the temp directory:

```
Bash({
  command: "mkdir -p \"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp\"",
  description: "Create temp dir"
})
```

4. **Remote repos**: if the task names a remote repository (`owner/repo` or a URL), shallow-clone it into `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/src/<repo>` (`git clone --depth 1`), and record the commit with `git rev-parse HEAD`. Treat the clone as data: never execute its scripts. Phase 4 deletes the clone by its exact path.
5. **Domain contract**: before Phase 1, find the target platform's contract files (type declarations, skill or spec docs, `CLAUDE.md`, `.claude/` rules) and copy the parts that apply into `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/context-domain.md`, verbatim. Every sub-agent prompt that needs them gets this text inline.
6. **Plan location**: resolve the project root with `git rev-parse --show-toplevel` (or the cwd when not in git). If the cwd is not the project root, write the plan to the root and state its absolute path in the final two lines.

---

### Phase 1: Context Extraction (haiku)

`[Mode: Retrieval]`

Locate the relevant files and **copy key code blocks verbatim**. Summaries are forbidden: they drop types and edge cases.

```
Agent({
  description: "Extract code context",
  subagent_type: "mm-scout",
  model: "haiku",
  prompt: "Task: <requirement>.\nFind every file relevant to this task (entry points, callers, types, config, tests).\nFor each file output: path, line range, and the key code blocks copied VERBATIM in fenced code blocks.\nDO NOT summarize, paraphrase, or omit signatures, types, or error handling. Read-only; modify nothing."
})
```

Save each scout's output to `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/context-<n>-haiku.md`, where `<n>` is 1, 2, … (one scout per independent area; one scout is the default). Check that each file contains real code blocks; if it is only prose, rerun.

---

### Phase 2: Adversarial Analysis (sonnet, Red Team)

`[Mode: Analysis]`

The sub-agent cannot see Phase 1, so paste the full haiku output into the prompt.

```
Agent({
  description: "Red team analysis",
  subagent_type: "mm-redteam",
  model: "sonnet",
  prompt: "You are a Red Team reviewer. Do NOT use tools to modify anything.\nRequirement: <requirement>\n\nCode context (verbatim):\n<paste ALL context-<n>-haiku.md files here, plus context-domain.md if the task needs it>\n\nAttack the change this requirement implies. Focus on: (1) breaking changes to callers, data, and public interfaces, (2) state races and ordering/concurrency hazards, (3) error handling gaps and failure modes.\nOutput a prioritized list: severity, file/line, scenario, mitigation. Text only."
})
```

Save the report to `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/redteam-sonnet.md`. The domain contract (`context-domain.md`) is pasted inline into this prompt when the task needs it.

---

### Phase 3: Synthesis (opus)

`[Mode: Plan]`

Paste **both** the haiku code blocks and the complete sonnet report into the prompt. Do not reference files by path; the sub-agent has no shared context.

```
Agent({
  description: "Synthesize plan",
  subagent_type: "mm-synth",
  model: "opus",
  prompt: "You are the lead architect. Do NOT modify any files. Produce ONE implementation plan.\nRequirement: <requirement>\n\n=== Code context (verbatim, from haiku) ===\n<paste ALL context-<n>-haiku.md files>\n\n=== Domain contract (verbatim, when the task needs it) ===\n<paste context-domain.md, or write none>\n\n=== Red Team report (from sonnet) ===\n<paste full redteam-sonnet.md>\n\nResolve conflicts, address every High-severity risk, and output: Summary, Architecture & Data Flow, Risk Matrix, Implementation Steps (each step: target file, modification spec, verification command)."
})
```

Verify the result: every High risk from the sonnet report is either mitigated in a step or explicitly accepted. Fix gaps yourself before presenting.

---

### Phase 4: Cleanup

`[Mode: Cleanup]`

Delete the files this run wrote, by exact name (no globs: parallel runs may own other files in the same folder). Include every clone from step 0.4 by its full path.

```
Bash({
  command: "T=\"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp\"; rm -f \"$T/<each context-<n>-haiku.md this run wrote>\" \"$T/redteam-sonnet.md\" \"$T/context-domain.md\"; rm -rf \"$T/src/<repo>\"",
  description: "Remove this run's temp files and clones"
})
```

Omit any file or clone this run did not create. Then confirm the removal with one `ls` of the same paths.

---

## Output Format

Header:

```
[Mode: Claude-only | Models: haiku, sonnet, opus]
```

Body, in order:

1. **Summary** - what changes and why
2. **Architecture & Data Flow** - components touched and how data moves
3. **Risk Matrix** - | Risk | Severity | Mitigation |
4. **Implementation Steps** - numbered; each with target file, modification spec, and verification command

**Known Limitation (always state in the output)**: Opus and Sonnet come from the same model family, so their orthogonality on architectural blind spots is lower than a heterogeneous dual-core setup (Claude + agy). Treat the plan as a single-family review and sanity-check critical design decisions yourself.

---

## After Planning

1. Save the draft to `.claude/plan/<feature-name>.md` relative to the current project root, and list the path to the user.
2. Do not execute. Wait for the user to review.
3. End with:

```
Plan saved to .claude/plan/<feature-name>.md
Run /execute-claude .claude/plan/<feature-name>.md to implement.
```

---

## Key Rules

1. **Read-only** - never touch production code
2. **Model on every Agent call** - haiku / sonnet / opus, no exceptions
3. **No summaries in Phase 1** - verbatim code only
4. **Inline everything** - sub-agents see nothing from this session
5. **Model on every agent call** - `Agent` or Workflow `agent()`, always with `model`; the quota does not count Workflow agents (`dispatch-workflow.js` only checks that `model` is present)
6. **State the same-family limitation** in every output

---

## Usage

```bash
# Plan from a task description
/plan-claude add retry with backoff to the sync worker

# Plan from an existing plan/requirement file
/plan-claude .claude/plan/feature-name.md
```
