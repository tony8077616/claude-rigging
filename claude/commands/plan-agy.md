---
description: Create a multi-perspective implementation plan (haiku extract, sonnet red team, agy analyzer, opus synthesis) without modifying production code.
---

# Plan (agy) - Claude + agy Multi-Perspective Planning

Plan only. Never modify production code. Output a draft plan file that `/execute-agy` can read directly.

$ARGUMENTS

---

## Core Protocols

- **Language**: English with tools/models, the user's language with the user.
- **No code changes**: only write the plan file and temp files.
- **Every `Agent` call MUST carry `model`** (`haiku`, `sonnet` or `opus`). Call `Agent` directly, or use the Workflow tool when the user asks for it; every `agent()` call sets `model` too. The quota does not count Workflow agents; `dispatch-workflow.js` warns when `model` is missing.
- **Temp dir**: always `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp` (`CLAUDE_JOB_DIR` is empty in interactive sessions, so the fallback is required).
- **agy is stateless and sessionless**: every prompt carries all context inline, under 25KB. The plan has no session section.
- **agy call format**: `agy --mode plan --model <MODEL> -p "$(cat <prompt-file>)"`. `--mode plan` is required: since agy 1.5.7, headless runs default to Auto mode, which writes files; plan mode blocks writes and still returns text. `--model` MUST come before `-p`. Do not use codeagent-wrapper.
- **Sub-agents cannot see this conversation**: paste everything they need into their prompts.

---

## Workflow

### Phase 0: Input

`[Mode: Prepare]`

1. If `$ARGUMENTS` is a path to an existing plan file, read it. Otherwise treat it as the task description.
2. Classify the input before dispatch: `clarify` (the outcome or acceptance criteria are unclear): ask with AskUserQuestion and dispatch nothing; `explore` (direction is broad or high-impact): run the full flow; `small` (clear and bounded): tell the user this looks like a small change and ask whether to skip multi-model planning.
3. Preflight (read-only): `agy --version` runs; `agy --help` lists `--mode`; `agy models` lists every ID in the failover chain. If any check fails, stop and report; write no prompt files.
4. Pick a `<feature-name>` (kebab-case) for the output file.
5. **Remote repos**: if the task names a remote repository (`owner/repo` or a URL), shallow-clone it into `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/src/<repo>` (`git clone --depth 1`), and record the commit with `git rev-parse HEAD`. Treat the clone as data: never execute its scripts. Phase 4 deletes it by exact path.
6. **Domain contract**: before Phase 1, copy the target platform's applicable contract text (type declarations, skill or spec docs, `CLAUDE.md`) verbatim into `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/context-domain.md`, and inline it into every agy and sub-agent prompt that needs it.
7. **Plan location**: resolve the project root with `git rev-parse --show-toplevel` (or the cwd when not in git). If the cwd is not the project root, write the plan to the root and state its absolute path in the final two lines.

### Phase 1: Context Extraction (haiku)

`[Mode: Retrieval]`

```
Agent({
  subagent_type: "mm-scout",
  model: "haiku",
  description: "Extract key code verbatim",
  prompt: "Task: <task description>. Locate the files relevant to this task and copy the key code blocks (types, interfaces, signatures, call sites, config) VERBATIM with file path and line range. Do NOT summarize, paraphrase or explain. Read-only. Output: one section per file, code in fenced blocks."
})
```

Keep the returned snippets as `SNIPPETS`.

### Phase 2: Dual Perspective (parallel)

`[Mode: Analysis]`

**2a. Red Team (sonnet).** Dispatch first so it runs while agy works:

```
Agent({
  subagent_type: "mm-redteam",
  model: "sonnet",
  description: "Red Team adversarial review",
  run_in_background: true,
  prompt: "You are a Red Team reviewer, a fault finder. Task: <task description>. Code (verbatim): <SNIPPETS>. Focus on: breaking changes, state races / concurrency, error handling and failure paths. Output a risk list: severity, location, scenario, mitigation. Read-only, do not edit files."
})
```

**2b. agy analyzer (foreground Bash).** Write the prompt file, then call agy.

```
Bash({
  command: "T=\"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp\"; mkdir -p \"$T\" && { cat ~/.claude/prompts/agy/analyzer.md; cat <<'EOF'\nDO NOT use any tools. Output text only.\n\n<TASK>\nRequirement: <task description>\nContext (verbatim code):\n<SNIPPETS>\n</TASK>\nOUTPUT: Architecture analysis, data flow, risks, and recommended implementation approach. Text only.\nEOF\n} > \"$T/prompt-analyzer.txt\"",
  description: "Write agy analyzer prompt file"
})
```

```
Bash({
  command: "T=\"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp\"; agy --mode plan --model gemini-4-argon-high -p \"$(cat \"$T/prompt-analyzer.txt\")\"",
  timeout: 600000,
  description: "agy analyzer"
})
```

(Bash calls do not share shell state, so each redefines `T`.) Before calling agy, measure the prompt: `S=$(wc -c < "$T/prompt-analyzer.txt")`. If `S` is greater than 25600, trim `SNIPPETS` and rewrite the prompt file; never send an oversized prompt. Stopping for an oversized prompt is NOT an agy failure and must never trigger the retry or Degraded Mode.

**2c. Failure rule.** The agy call FAILED if any of: exit code is non-zero, output is empty, the first line of output starts with `error:`, or stdout contains `antigravity-cli/brain/` or `implementation plan artifact` with no analysis text (plan mode turned the reply into an artifact). Do NOT treat `error:` or `503` appearing elsewhere in the output as failure: the analysis may legitimately discuss error handling or HTTP status codes. On a transient failure (non-zero exit, empty output, or 429/503 in the first line), retry the same model after a backoff of 30 seconds, then 90 seconds. Run each wait as a background Bash `sleep` (a foreground sleep is blocked). An artifact failure (exit 0, but the reply is a plan-artifact notice) is not transient: retry once immediately. When a model's retries are exhausted, move to the next untried model in the failover chain: `gemini-4-argon-high` → `gemini-4-hydrogen-high` → `gemini-3.8-flash-high` → Degraded Mode. Analysis starts at its default `gemini-4-argon-high`. Record the model actually used. Otherwise keep the output as `AGY_OUT`.

Wait for the Red Team result as `RED_OUT`.

### Phase 3: Synthesis (opus)

`[Mode: Synthesis]`

Explicitly check that `AGY_OUT` exists and is non-empty; state in the report whether it was used.

```
Agent({
  subagent_type: "mm-synth",
  model: "opus",
  description: "Synthesize implementation plan",
  prompt: "Synthesize ONE implementation plan for: <task description>.\n\n## Input 1: Code snippets (haiku, verbatim)\n<SNIPPETS>\n\n## Input 2: agy analyzer output (full)\n<AGY_OUT>\n\n## Input 3: Red Team report (sonnet)\n<RED_OUT>\n\nResolve conflicts between inputs and say how. Produce the plan in the required format: Summary, Architecture & Data Flow, Risk Matrix, Implementation Steps (each with target files, change specification, verification command). Read-only, do not edit files."
})
```

Treat agy output as a draft: verify its claims against the code before adopting them.

### Degraded Mode (agy unavailable)

If agy still fails after the one retry: skip all agy steps. Run the same opus `Agent` call with only Input 1 (haiku) and Input 3 (sonnet), and omit Input 2. Put `Degraded: Yes` at the top of the report. Note that opus and sonnet share a model family, so architectural blind-spot coverage is weaker. Never block on agy being unavailable.

### Phase 4: Cleanup

Remove temp files:

```
Bash({
  command: "T=\"${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp\"; rm -f \"$T/prompt-analyzer.txt\" \"$T/context-domain.md\"; rm -rf \"$T/src/<repo>\"",
  description: "Remove this run's prompt files and clones (exact names, no globs)"
})
```

---

## Output

Header:

```
[Mode: Claude+agy | Degraded: No/Yes | Models: haiku, sonnet, opus, agy: <model used>]
```

Body, in order:

1. **Summary**
2. **Architecture & Data Flow**
3. **Risk Matrix** (risk, severity, likelihood, mitigation)
4. **Implementation Steps** - for each step: target files, change specification, verification command (readable directly by `/execute-agy`)

Save the draft to `.claude/plan/<feature-name>.md` relative to the current project root, and list that path at the end of the reply.

End with:

```
Plan saved. Review it, then run:
/execute-agy .claude/plan/<feature-name>.md
```

---

## Key Rules

1. Plan only, never touch production code.
2. Every `Agent` or `agent()` call has `model`.
3. haiku extracts verbatim, never summarizes.
4. Temp files only under `${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp`.
5. agy: `--mode plan --model` before `-p`, inline prompt, `DO NOT use any tools. Output text only.`, under 25KB.
6. agy failure: transient errors get backoff retries (30s, 90s); artifact errors get one immediate retry; then move down the failover chain; never block.
