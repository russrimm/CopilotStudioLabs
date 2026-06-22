#!/usr/bin/env python3
"""One-shot migration: renumber lab folders into a progressive ordering and
fix every cross-reference. See scripts/README or the PR description for context.

Passes:
  1. git mv each lab folder -> __tmp__<slug> -> <newnum>-<slug> (two-phase, no collisions)
  2. Slug-anchored path replace `\\d{2}-<slug>` -> `<newnum>-<slug>` across all text files
  3. Markdown relabel of "Lab NN" (link labels driven by slug-in-URL, H1 per-file, bare prose via old->new map)
  4. Link integrity check: every ](../NN-slug/...) resolves to a real folder
"""
from __future__ import annotations
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABS = os.path.join(ROOT, "labs")

# slug -> new number (existing labs only). New stub folders are created separately.
NEW_NUM = {
    "intro-workshop": 1,
    "prompt-assistant": 3,
    "energy-ops-agent": 4,
    "work-iq-m365-intelligence": 5,
    "energy-weather-agent": 6,
    "agent-analytics-evaluations": 7,
    "agent-evaluations-ga": 8,
    "multi-turn-conversation-tests": 9,
    "question-reaction-exports": 10,
    "custom-analytics-metrics": 11,
    "prompt-builder-agent-flows": 13,
    "agent-flows-prompt-nodes": 14,
    "agent-flows-agent-nodes": 15,
    "agent-flows-m365-copilot-nodes": 16,
    "agent-flows-async-responses": 17,
    "account-orchestration-agent": 18,
    "agent-to-agent-protocol": 19,
    "agent-to-agent-ga": 20,
    "custom-connectors-oauth": 21,
    "servicenow-integration": 22,
    "snowflake-data-integration": 23,
    "onprem-data-gateway": 24,
    "vnet-private-connectivity": 25,
    "industry-integrations": 26,
    "work-iq-mcp-preview": 27,
    "computer-use-agents": 28,
    "computer-use-ga": 29,
    "realtime-voice-agents": 30,
    "realtime-voice-agents-preview": 31,
    "embed-agent-web-sdk": 32,
    "power-apps-code-apps": 33,
    "copilot-studio-vscode-agent-management": 36,
    "usage-estimator-copilot-credits": 37,
    "agent-inventory-schema": 38,
    "agent-readiness-issue-status": 39,
    "entra-agent-identities-preview": 40,
}

# Current folder -> slug + old number (discovered from disk)
def discover():
    folders = {}
    for name in os.listdir(LABS):
        if not os.path.isdir(os.path.join(LABS, name)):
            continue
        m = re.match(r"^(\d{2})-(.+)$", name)
        if not m:
            continue
        folders[m.group(2)] = (int(m.group(1)), name)
    return folders


def sh(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def rename_folders(folders):
    # phase 1: -> tmp
    for slug, (_old, name) in folders.items():
        sh("git", "mv", f"labs/{name}", f"labs/__tmp__{slug}")
    # phase 2: tmp -> newnum
    for slug in folders:
        newnum = NEW_NUM[slug]
        sh("git", "mv", f"labs/__tmp__{slug}", f"labs/{newnum:02d}-{slug}")


TEXT_EXT = {".md", ".js", ".mjs", ".cjs", ".json", ".py", ".yaml", ".yml", ".txt"}
SKIP_DIRS = {".git", "node_modules", ".auth", "dist", "__pycache__", ".squad"}


def iter_text_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in TEXT_EXT:
                yield os.path.join(dirpath, fn)


def path_replace(folders):
    # Build slug-anchored substitutions. (?<!\d) avoids matching inside longer
    # numbers; (?!-) avoids matching a shorter slug that prefixes a longer one
    # (e.g. realtime-voice-agents vs realtime-voice-agents-preview).
    subs = []
    for slug in folders:
        newnum = NEW_NUM[slug]
        pat = re.compile(r"(?<!\d)\d{2}-" + re.escape(slug) + r"(?!-)")
        subs.append((pat, f"{newnum:02d}-{slug}"))
    for path in iter_text_files():
        with open(path, "r", encoding="utf-8") as f:
            txt = f.read()
        new = txt
        for pat, repl in subs:
            new = pat.sub(repl, new)
        if new != txt:
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)


LINK_RE = re.compile(r"\[([^\]]*?)\]\(([^)]*?)\)")
SLUG_IN_URL = re.compile(r"(?<!\d)(\d{2})-([a-z0-9-]+)")


def build_bare_map(folders):
    # old number -> new number for bare prose. Old 01 is ambiguous (intro vs
    # energy-ops); bare prose "Lab 01" always means the IT Ops agent -> 04.
    m = {}
    for slug, (old, _name) in folders.items():
        if old == 1:
            continue
        m[old] = NEW_NUM[slug]
    m[1] = NEW_NUM["energy-ops-agent"]  # 04
    return m


def relabel_markdown(folders, bare_map):
    valid_slugs = set(folders)
    for slug in folders:
        newnum = NEW_NUM[slug]
        path = os.path.join(LABS, f"{newnum:02d}-{slug}", "index.md")
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().split("\n")

        # H1: first line starting with '# ' -> set its "Lab NN" to this folder's number
        for i, line in enumerate(lines):
            if line.startswith("# "):
                lines[i] = re.sub(r"Lab \d{2}", f"Lab {newnum:02d}", line, count=1)
                h1_index = i
                break
        else:
            h1_index = -1

        out = []
        for i, line in enumerate(lines):
            if i == h1_index:
                out.append(line)
                continue
            # 1) fix labels inside markdown links using slug-in-URL
            def fix_link(m):
                label, url = m.group(1), m.group(2)
                um = SLUG_IN_URL.search(url)
                if um and um.group(2) in valid_slugs:
                    target = um.group(1)
                    label = re.sub(r"Lab \d{2}", f"Lab {target}", label)
                return f"[{label}]({url})"

            new_line = LINK_RE.sub(fix_link, line)

            # 2) bare prose "Lab NN" outside of links -> old->new map.
            # Protect already-correct link labels by masking link spans.
            spans = [(mm.start(), mm.end()) for mm in LINK_RE.finditer(new_line)]

            def in_link(pos):
                return any(s <= pos < e for s, e in spans)

            def fix_bare(m):
                if in_link(m.start()):
                    return m.group(0)
                old = int(m.group(1))
                if old in bare_map:
                    return f"Lab {bare_map[old]:02d}"
                return m.group(0)

            new_line = re.sub(r"Lab (\d{2})", fix_bare, new_line)
            out.append(new_line)

        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(out))


def check_links():
    problems = []
    ref_re = re.compile(r"\]\((?:\.\./)?(\d{2}-[a-z0-9-]+)/")
    existing = {d for d in os.listdir(LABS) if os.path.isdir(os.path.join(LABS, d))}
    for dirpath, dirnames, filenames in os.walk(LABS):
        for fn in filenames:
            if not fn.endswith(".md"):
                continue
            p = os.path.join(dirpath, fn)
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
            for m in ref_re.finditer(txt):
                target = m.group(1)
                if target not in existing:
                    problems.append((os.path.relpath(p, ROOT), target))
    return problems


def main():
    folders = discover()
    missing = [s for s in folders if s not in NEW_NUM]
    if missing:
        print("ERROR: folders without mapping:", missing)
        sys.exit(1)
    print(f"Renumbering {len(folders)} lab folders...")
    rename_folders(folders)
    print("Rewriting path references...")
    path_replace(folders)
    print("Relabeling markdown 'Lab NN'...")
    relabel_markdown(folders, build_bare_map(folders))
    print("Checking link integrity...")
    problems = check_links()
    if problems:
        print("UNRESOLVED LINKS:")
        for f, t in problems:
            print(f"  {f} -> {t}")
    else:
        print("All ../NN-slug links resolve.")


if __name__ == "__main__":
    main()
