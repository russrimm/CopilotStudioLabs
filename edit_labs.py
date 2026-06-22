"""Normalize lab index.md structure across ALL labs (01-35).

This script is IDEMPOTENT and SAFE. It discovers every ``labs/NN-*`` folder
(including the two intentional ``01-*`` folders) and only makes a change when
the canonical structure is genuinely missing:

  1. Inserts a ``## Metadata`` heading before the first metadata table ONLY when
     the lab has neither a Metadata heading nor an emoji-prefixed metadata table
     (e.g. ``| ⭐ **DIFFICULTY** |``). Labs that already carry a metadata table
     (the convention used by the newer labs 19-35) are left untouched.
  2. Renames a "What you will learn" / "What you'll learn" heading to
     ``## 🎯 Objectives`` ONLY when the lab has no canonical Objectives heading
     yet. Labs that already have ``## Objectives`` / ``## 🎯 Objectives`` /
     ``## Learning Objectives`` are left untouched.

Cross-link callout blocks (``> 🔗 **Related lab:**`` ...) are never moved or
removed — none of the operations below touch them.
"""

import os
import re

LABS_DIR = "labs"

# A metadata table uses emoji-prefixed bold cells, e.g. ``| ⭐ **DIFFICULTY** |``.
METADATA_TABLE_RE = re.compile(
    r"\*\*(DIFFICULTY|TIME|PRODUCTS|TAGS|INDUSTRIES)\*\*", re.IGNORECASE
)
# A literal "## Metadata" (or deeper) heading.
METADATA_HEADING_RE = re.compile(r"^#+\s.*Metadata", re.MULTILINE | re.IGNORECASE)
# The empty table header row that begins a metadata table: ``| | |``.
EMPTY_TABLE_HEADER_RE = re.compile(r"^\|\s*\|\s*\|", re.MULTILINE)
# A canonical Objectives heading (what the rename would create / not duplicate).
OBJECTIVES_HEADING_RE = re.compile(
    r"^#+\s*(?:🎯\s*)?(?:Learning\s+)?Objectives\b", re.MULTILINE | re.IGNORECASE
)
# A "What you will learn" / "What you'll learn" heading (the rename source).
WHAT_YOU_LEARN_RE = re.compile(
    r"^#+\s.*What you(?:'ll| will) learn.*$", re.MULTILINE | re.IGNORECASE
)


def discover_labs():
    """Return sorted ``labs/NN-*`` directories (covers 01-35, both 01 folders)."""
    found = []
    if not os.path.isdir(LABS_DIR):
        return found
    for name in sorted(os.listdir(LABS_DIR)):
        full = os.path.join(LABS_DIR, name)
        if os.path.isdir(full) and re.match(r"^\d{2}-", name):
            found.append(full)
    return found


def normalize(file_path):
    """Apply safe, idempotent normalization. Return a list of change strings."""
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    original = content
    changes = []

    has_metadata_heading = bool(METADATA_HEADING_RE.search(content))
    has_metadata_table = bool(METADATA_TABLE_RE.search(content))
    has_objectives = bool(OBJECTIVES_HEADING_RE.search(content))

    # 1) Metadata heading — only when there is genuinely no metadata at all.
    if not has_metadata_heading and not has_metadata_table:
        match = EMPTY_TABLE_HEADER_RE.search(content)
        if match:
            idx = match.start()
            content = content[:idx] + "## Metadata\n\n" + content[idx:]
            changes.append("inserted '## Metadata' heading before metadata table")

    # 2) Objectives heading — only when no canonical Objectives section exists.
    if not has_objectives and WHAT_YOU_LEARN_RE.search(content):
        content = WHAT_YOU_LEARN_RE.sub("## 🎯 Objectives", content)
        changes.append("renamed 'What you will learn' heading to '## 🎯 Objectives'")

    if content != original:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
    return changes


def main():
    edited = []
    scanned = 0
    for lab_dir in discover_labs():
        file_path = os.path.join(lab_dir, "index.md")
        if not os.path.exists(file_path):
            continue
        scanned += 1
        changes = normalize(file_path)
        if changes:
            edited.append((file_path, changes))

    print(f"Scanned {scanned} lab index.md files.")
    if edited:
        print("Edited files:")
        for file_path, changes in edited:
            print(f"  {file_path}")
            for change in changes:
                print(f"    - {change}")
    else:
        print("No changes needed — all labs already normalized (idempotent).")


if __name__ == "__main__":
    main()
