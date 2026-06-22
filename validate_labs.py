"""Validate lab index.md structure across ALL labs (01-35).

Single canonical validator (the former ``validate_labs_new.py`` has been merged
in and deleted). It scans every ``labs/NN-*`` folder — including the two
intentional ``01-*`` folders — and reports, per lab:

  * Required section checks (union of the historical validators): title,
    metadata, overview, objectives, prerequisites, steps, validation, completion.
  * README link integrity: every ``labs/...`` link in README.md must resolve.
  * Numbering collisions: duplicate lab numbers are flagged, EXCEPT the known
    intentional duplicate ``01`` (two folders), which is reported as expected.

Exit code is 0 when every lab passes all section checks, README links resolve,
and there are no unexpected collisions; otherwise 1.
"""

import os
import re
import sys

LABS_DIR = "labs"
README = "README.md"

# Lab numbers that are intentionally used by more than one folder.
ALLOWED_DUPLICATE_NUMBERS = {1}

# Union of the section/keyword checks from the two historical validators.
# A metadata section is satisfied by either a "## Metadata" heading OR an
# emoji-prefixed metadata table (the convention used by labs 19-35).
SECTION_CHECKS = {
    "title": re.compile(r"^#\s", re.MULTILINE),
    "metadata": re.compile(
        r"(?:^#+\s.*Metadata)"
        r"|(?:\*\*(?:DIFFICULTY|TIME|PRODUCTS|TAGS|INDUSTRIES)\*\*)"
        r"|(?:^author:|^ms\.author:|^ms\.service:)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "overview": re.compile(
        r"^#+\s.*(?:Overview|Introduction)", re.IGNORECASE | re.MULTILINE
    ),
    "objectives": re.compile(
        r"^#+\s.*(?:Objectives|What you(?:'ll| will) learn)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "prerequisites": re.compile(
        r"^#+\s.*Prerequisites", re.IGNORECASE | re.MULTILINE
    ),
    "steps": re.compile(
        r"^#+\s.*(?:Use Cases|Lab Flow|Step-by-Step|Steps|Step\s+\d|Exercise|"
        r"Walkthrough|Instructions|Section\s+\d)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "validation": re.compile(
        r"^#+\s.*(?:Validation|What You Built|Success Criteria|Review|Verify)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "completion": re.compile(
        r"^#+\s.*(?:Summary|Congratulations|Next Steps|Completion|Complete|"
        r"Conclusion|Wrap[- ]?up|Recap)",
        re.IGNORECASE | re.MULTILINE,
    ),
}


def discover_labs():
    """Return sorted ``labs/NN-*`` directory names (covers 01-35, both 01s)."""
    found = []
    if os.path.isdir(LABS_DIR):
        for name in sorted(os.listdir(LABS_DIR)):
            full = os.path.join(LABS_DIR, name)
            if os.path.isdir(full) and re.match(r"^\d{2}-", name):
                found.append(name)
    return found


def check_sections(file_path):
    """Return the list of missing section keys for a lab index.md."""
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    return [key for key, rx in SECTION_CHECKS.items() if not rx.search(content)]


def check_readme_links():
    """Return a list of README ``labs/...`` link targets that do not resolve."""
    broken = []
    if not os.path.exists(README):
        return ["README.md not found"]
    with open(README, "r", encoding="utf-8", errors="ignore") as f:
        readme = f.read()
    # Markdown link targets pointing into labs/, e.g. (./labs/19-foo/index.md).
    targets = set(re.findall(r"\]\(\s*(\.?/?labs/[^)\s]+)\)", readme))
    for target in sorted(targets):
        normalized = target.lstrip("./")
        if not os.path.exists(normalized):
            broken.append(target)
    return broken


def find_collisions(folders):
    """Map lab number -> folder list for numbers used by more than one folder."""
    by_num = {}
    for folder in folders:
        num = int(re.match(r"^(\d{2})-", folder).group(1))
        by_num.setdefault(num, []).append(folder)
    return {num: f for num, f in by_num.items() if len(f) > 1}


def main():
    folders = discover_labs()
    if not folders:
        print(f"No labs found under {LABS_DIR}/")
        return 1

    print("=== Lab Structure Validation (labs 01-35) ===\n")

    failed_labs = 0
    print("Per-lab section checks:")
    for folder in folders:
        index_path = os.path.join(LABS_DIR, folder, "index.md")
        if not os.path.exists(index_path):
            print(f"  FAIL  {folder} — index.md missing")
            failed_labs += 1
            continue
        missing = check_sections(index_path)
        if missing:
            print(f"  FAIL  {folder} — missing: {', '.join(missing)}")
            failed_labs += 1
        else:
            print(f"  PASS  {folder}")

    print("\nREADME link integrity:")
    broken = check_readme_links()
    if broken:
        for target in broken:
            print(f"  FAIL  unresolved link: {target}")
    else:
        print("  PASS  all labs/ links in README.md resolve")

    print("\nNumbering collisions:")
    collisions = find_collisions(folders)
    unexpected = {n: f for n, f in collisions.items() if n not in ALLOWED_DUPLICATE_NUMBERS}
    for num, dup_folders in sorted(collisions.items()):
        tag = "expected" if num in ALLOWED_DUPLICATE_NUMBERS else "UNEXPECTED"
        print(f"  [{tag}] {num:02d} used by: {', '.join(dup_folders)}")
    if not collisions:
        print("  PASS  no duplicate lab numbers")

    print("\n=== Summary ===")
    print(f"  Labs scanned:        {len(folders)}")
    print(f"  Labs passing:        {len(folders) - failed_labs}")
    print(f"  Labs failing:        {failed_labs}")
    print(f"  Broken README links: {len(broken)}")
    print(f"  Unexpected collisions: {len(unexpected)}")

    ok = failed_labs == 0 and not broken and not unexpected
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
