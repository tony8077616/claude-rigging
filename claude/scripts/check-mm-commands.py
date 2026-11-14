#!/usr/bin/env python3
"""Lint the mm-* multi-model command files, agy role prompts and agent definitions."""
import argparse, os, re, shutil, subprocess, sys, time
from pathlib import Path

CMDS = ["plan-agy.md", "execute-agy.md", "backend-agy.md", "plan-claude.md", "execute-claude.md"]
findings = []


def add(level, f, line, check, detail):
    findings.append((level, f"{level} {f}:{line} {check}: {detail}"))


def read(p):
    return Path(p).read_text(encoding="utf-8", errors="replace")


def agent_blocks(text):
    """Yield (offset, block) for each Agent({...}); shortcut: rough string/brace scan."""
    for m in re.finditer(r"Agent\(\{", text):
        i = m.end() - 1
        depth, q = 0, None
        j = i
        while j < len(text):
            c = text[j]
            if q:
                if c == "\\":
                    j += 1
                elif c == q:
                    q = None
            elif c in "\"'`":
                q = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield m.start(), text[m.start():j + 1]


def check_cmd(p, root, ids):
    text = read(p)
    lines = text.splitlines()
    for n, l in enumerate(lines, 1):
        if "agy --model" in l:
            add("FAIL", p, n, "AGY_FLAG", "use `agy --mode plan --model`")
        if "agy --" in l and re.search(r"(?<!\S)-p(?!\w)", l) and "--mode plan" not in l:
            add("FAIL", p, n, "AGY_PLAN_MISSING", "agy -p call without `--mode plan`")
        if "TaskOutput" in l and "已移除" not in l and "removed" not in l:
            add("FAIL", p, n, "TASKOUTPUT", "TaskOutput was removed in Claude Code 2.1.277")
        for m in re.finditer(r'subagent_type:\s*"([^"]+)"', l):
            s = m.group(1)
            if s in ("general-purpose", "Explore"):
                add("WARN", p, n, "GENERIC_SUBAGENT", f'"{s}" should be an mm-* role')
            elif s.startswith("mm-") and not (root / "agents" / f"{s}.md").is_file():
                add("FAIL", p, n, "MM_ROLE_EXISTS", f"agents/{s}.md not found")
        for m in re.finditer(r"(gemini|claude|gpt-oss)-[A-Za-z0-9.\-]+", l):
            ids.setdefault(m.group(0).rstrip(".-"), (p, n))
    for off, blk in agent_blocks(text):
        if not re.search(r"\bmodel\s*:", blk):
            add("FAIL", p, text.count("\n", 0, off) + 1, "AGENT_MODEL", "Agent({...}) has no model: key")
    phase, nums = None, []
    for n, l in enumerate(lines, 1):
        m = re.match(r"###\s+Phase\s+(\d+)", l)
        if m:
            phase = int(m.group(1))
            if nums and phase <= nums[-1]:
                add("FAIL", p, n, "PHASE_SEQ", f"Phase {phase} after Phase {nums[-1]}")
            nums.append(phase)
            continue
        m = re.match(r"####\s+(\d+)\.\d+", l)
        if m and phase is not None and int(m.group(1)) != phase:
            add("FAIL", p, n, "PHASE_SEQ", f"subheading {m.group(1)}.x under Phase {phase}")


def check_agent(p):
    text = read(p)
    m = re.match(r"---\r?\n(.*?)\r?\n---", text, re.S)
    if not m:
        return add("FAIL", p, 1, "MM_AGENT_FRONTMATTER", "no frontmatter")
    fm = {k: v.strip().strip("\"'") for k, v in re.findall(r"^([\w-]+):[ \t]*(.*)$", m.group(1), re.M)}
    stem = Path(p).stem
    if fm.get("name") != stem:
        add("FAIL", p, 1, "MM_AGENT_FRONTMATTER", f"name={fm.get('name')!r} != {stem!r}")
    if fm.get("model") not in {"haiku", "sonnet", "opus"}:
        add("FAIL", p, 1, "MM_AGENT_FRONTMATTER", f"bad model {fm.get('model')!r}")
    if fm.get("effort") not in {"low", "medium", "high", "xhigh", "max"}:
        add("FAIL", p, 1, "MM_AGENT_FRONTMATTER", f"bad effort {fm.get('effort')!r}")
    if "tools" not in fm:
        add("FAIL", p, 1, "MM_AGENT_FRONTMATTER", "missing tools:")


SCRATCH = Path("L:/TEMP/claude/8d4b169dc6c0fd90/42b2b1d4-0b92-4912-bda1-ffb3bf615afd/scratchpad")
CALC = "def add(a, b):\n    return a + b\n"


def pr(model, check, ok, detail=""):
    findings.append(("PASS" if ok else "FAIL", f"PROBE {model} {check}: {'PASS' if ok else 'FAIL'} {detail}".rstrip()))


def probe(cmds):
    chain = []
    for p in cmds:
        if p.name in ("plan-agy.md", "execute-agy.md") and p.is_file():
            for m in re.finditer(r"failover chain[^\n]*", read(p)):
                chain = [i.rstrip(".-") for i in re.findall(r"gemini-[A-Za-z0-9.\-]+", m.group(0))][:3]
                if len(chain) == 3:
                    break
            if len(chain) == 3:
                break
    if len(chain) != 3:
        return pr("-", "CHAIN_PARSE", False, f"expected 3 ids in failover chain, got {chain}")
    d = SCRATCH / f"probe-{time.strftime('%Y%m%d-%H%M%S')}"
    d.mkdir(parents=True)
    calc = d / "calc.py"
    calc.write_text(CALC, encoding="utf-8", newline="")

    def run(model, prompt):
        r = subprocess.run(["agy", "--mode", "plan", "--model", model, "-p", prompt], cwd=d,
                           capture_output=True, timeout=300)
        return r.returncode, r.stdout.decode("utf-8", "replace")

    try:
        run(chain[0], "Create a file named probe_write.txt containing PROBE in the current directory. Reply DONE.")
        pr(chain[0], "WRITE_BLOCK", not (d / "probe_write.txt").exists(), "probe_write.txt exists" if (d / "probe_write.txt").exists() else "")
    except (subprocess.SubprocessError, OSError) as e:
        pr(chain[0], "WRITE_BLOCK", False, str(e))
    prompt = ("DO NOT use any tools. Output text only. DO NOT modify files. Task: add a docstring to add() in calc.py. "
              "OUTPUT: Unified Diff Patch ONLY in a fenced code block. File content:\ndef add(a, b):\n    return a + b")
    for m in chain:
        try:
            rc, out = run(m, prompt)
        except (subprocess.SubprocessError, OSError) as e:
            pr(m, "DIFF", False, str(e))
            continue
        bad = []
        if rc != 0: bad.append(f"exit={rc}")
        if "```diff" not in out: bad.append("no ```diff block")
        if "antigravity-cli/brain/" in out or "implementation plan artifact" in out: bad.append("artifact notice")
        if calc.read_text(encoding="utf-8") != CALC: bad.append("calc.py modified")
        pr(m, "DIFF", not bad, "; ".join(bad))
        calc.write_text(CALC, encoding="utf-8", newline="")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="command files to check instead of the defaults")
    ap.add_argument("--root", default=str(Path.home() / ".claude"))
    ap.add_argument("--no-live", action="store_true")
    ap.add_argument("--probe", action="store_true", help="opt-in: run real agy write-block/diff probes")
    try:
        a = ap.parse_args()
    except SystemExit as e:
        return 2 if e.code else 0
    root = Path(a.root)
    if not root.is_dir():
        print(f"usage: --root {root} is not a directory", file=sys.stderr)
        return 2
    cmds = [Path(x) for x in a.paths] or [root / "commands" / c for c in CMDS]
    ids = {}
    for p in cmds:
        if p.is_file():
            check_cmd(p, root, ids)
        elif a.paths or p.name in CMDS and (root / "commands").is_dir() and p.parent.name == "commands":
            add("FAIL", p, 0, "MISSING_FILE", "target not found")
    for p in sorted((root / "prompts" / "agy").glob("*.md")):
        for n, l in enumerate(read(p).splitlines(), 1):
            if "You may READ" in l:
                add("FAIL", p, n, "ROLE_PROMPT_READ", "role prompt contains `You may READ`")
    for p in sorted((root / "agents").glob("mm-*.md")):
        check_agent(p)
    if a.no_live or not shutil.which("agy"):
        add("WARN", "agy", 0, "AGY_MODEL_IDS", "live check skipped")
    else:
        try:
            out = subprocess.run(["agy", "models"], capture_output=True, timeout=60).stdout.decode("utf-8", "replace")
            live = {l.split()[0] for l in out.splitlines() if l.split()}
            for i, (p, n) in sorted(ids.items()):
                if i not in live:
                    add("FAIL", p, n, "AGY_MODEL_IDS", f"{i} not in `agy models`")
        except (subprocess.SubprocessError, OSError) as e:
            add("FAIL", "agy", 0, "AGY_MODEL_IDS", f"agy models failed: {e}")
    if a.probe:
        if shutil.which("agy"):
            probe(cmds)
        else:
            add("FAIL", "agy", 0, "PROBE", "agy not on PATH")
    for _, s in findings:
        print(s)
    nf = sum(1 for l, _ in findings if l == "FAIL")
    print(f"SUMMARY fail={nf} warn={sum(1 for l, _ in findings if l == 'WARN')}")
    return 1 if nf else 0


if __name__ == "__main__":
    sys.exit(main())
