"""Validate index.md structure across all numbered lab directories.

Single canonical validator (the former ``validate_labs_new.py`` has been merged
in and deleted). It scans every ``labs/NN-*`` folder — including the two
and reports, per lab:

  * Required section checks (union of the historical validators): title,
    metadata, overview, objectives, prerequisites, steps, validation, completion.
  * Repository Markdown link integrity: local files, assets, and anchors resolve.
  * Numbering collisions: duplicate lab numbers are flagged.

Exit code is 0 when every lab passes all section checks, README links resolve,
and there are no unexpected collisions; otherwise 1.
"""

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

LABS_DIR = "labs"
README = "README.md"
REPO_ROOT = Path(__file__).resolve().parent

ALLOWED_DUPLICATE_NUMBERS = set()

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
    """Return sorted ``labs/NN-*`` directory names."""
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


def tracked_markdown_files(root=REPO_ROOT):
    """Return tracked Markdown files, falling back to a filtered filesystem walk."""
    try:
        output = subprocess.check_output(
            ["git", "ls-files", "*.md", "*.markdown"],
            cwd=root,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return [root / line for line in output.splitlines() if line]
    except (OSError, subprocess.CalledProcessError):
        return [
            path
            for path in root.rglob("*")
            if path.suffix.lower() in {".md", ".markdown"}
            and not {".git", "node_modules", "dist"}.intersection(path.parts)
        ]


def github_anchors(markdown):
    """Build the GitHub-style heading anchors available in a Markdown document."""
    anchors = set()
    counts = {}
    for match in re.finditer(r"^#{1,6}\s+(.+?)\s*#*\s*$", markdown, re.MULTILINE):
        heading = re.sub(r"<[^>]+>", "", match.group(1))
        heading = re.sub(r"[`*_~]", "", heading).strip().lower()
        slug = re.sub(r"[^\w\- ]", "", heading, flags=re.UNICODE).replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        anchors.add(slug if count == 0 else f"{slug}-{count}")
    anchors.update(
        match.group(1).lower()
        for match in re.finditer(r"\bid=[\"']([^\"']+)[\"']", markdown, re.IGNORECASE)
    )
    return anchors


def markdown_targets(markdown):
    """Yield (line, target) for Markdown links and HTML href/src attributes."""
    without_fences = re.sub(
        r"^(```|~~~).*?^\1\s*$",
        lambda match: "\n" * match.group(0).count("\n"),
        markdown,
        flags=re.MULTILINE | re.DOTALL,
    )
    patterns = [
        re.compile(r"!?\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[\"'][^)]*[\"'])?\s*\)"),
        re.compile(r"\b(?:href|src)=[\"']([^\"']+)[\"']", re.IGNORECASE),
    ]
    for pattern in patterns:
        for match in pattern.finditer(without_fences):
            target = next((group for group in match.groups() if group is not None), "")
            yield without_fences.count("\n", 0, match.start()) + 1, target


def check_markdown_links(files=None, root=REPO_ROOT):
    """Return broken local Markdown file, asset, and anchor references."""
    findings = []
    files = files or tracked_markdown_files(root)
    anchor_cache = {}

    for source in files:
        markdown = source.read_text(encoding="utf-8", errors="ignore")
        for line, raw_target in markdown_targets(markdown):
            target = raw_target.strip()
            if target.lower() in {"url", "link", "path"}:
                continue
            if not target or target.startswith(("#", "mailto:", "tel:", "data:")):
                path_part = ""
                fragment = target[1:] if target.startswith("#") else ""
            else:
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc:
                    continue
                path_part = unquote(parsed.path)
                fragment = unquote(parsed.fragment)

            if path_part.startswith("/"):
                destination = root / path_part.lstrip("/")
            elif path_part:
                destination = source.parent / path_part
            else:
                destination = source
            destination = destination.resolve()

            try:
                destination.relative_to(root.resolve())
            except ValueError:
                findings.append((source, line, target, "target escapes the repository"))
                continue

            if not destination.exists():
                findings.append((source, line, target, "target does not exist"))
                continue

            if fragment and destination.is_file() and destination.suffix.lower() in {".md", ".markdown"}:
                anchors = anchor_cache.get(destination)
                if anchors is None:
                    anchors = github_anchors(destination.read_text(encoding="utf-8", errors="ignore"))
                    anchor_cache[destination] = anchors
                if fragment.lower() not in anchors:
                    findings.append((source, line, target, f'anchor "#{fragment}" does not exist'))

    return findings


def duration_minutes(value):
    """Normalize the primary duration in strings such as '1 hour 30 minutes'."""
    text = re.sub(r"[*_`]", "", str(value)).split("(", 1)[0].split("+", 1)[0].lower()
    hours = re.search(r"(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)", text)
    minutes = re.search(r"(\d+)\s*(?:minutes?|mins?)", text)
    total = round(float(hours.group(1)) * 60) if hours else 0
    total += int(minutes.group(1)) if minutes else 0
    return total or None


def check_readme_catalog(root=REPO_ROOT):
    """Check that the README table covers every lab once with matching duration."""
    issues = []
    readme_path = root / README
    if not readme_path.exists():
        return ["README.md not found"]

    table_targets = []
    for line_number, line in enumerate(readme_path.read_text(encoding="utf-8").splitlines(), 1):
        if not re.match(r"^\|\s*\d+\s*\|", line):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 6:
            issues.append(f"README.md:{line_number}: expected 6 catalog columns, found {len(cells)}")
            continue
        link = re.search(r"\]\((\.?/labs/[^)#]+/index\.md)\)", cells[1])
        if not link:
            issues.append(f"README.md:{line_number}: lab entry has no labs/*/index.md link")
            continue
        target = link.group(1).lstrip("./")
        table_targets.append(target)
        lab_path = root / target
        if not lab_path.exists():
            continue
        metadata = re.search(
            r"\*\*TIME\*\*\s*\|\s*([^|]+)",
            lab_path.read_text(encoding="utf-8", errors="ignore"),
            re.IGNORECASE,
        )
        readme_minutes = duration_minutes(cells[5])
        lab_minutes = duration_minutes(metadata.group(1)) if metadata else None
        if readme_minutes != lab_minutes:
            issues.append(
                f"README.md:{line_number}: duration {cells[5]!r} does not match "
                f"{target} metadata ({metadata.group(1).strip() if metadata else 'missing TIME'})"
            )

    expected = {f"labs/{folder}/index.md" for folder in discover_labs()}
    represented = set(table_targets)
    for target in sorted(expected - represented):
        issues.append(f"README catalog is missing {target}")
    for target in sorted(represented - expected):
        issues.append(f"README catalog references unexpected lab {target}")
    duplicates = sorted({target for target in table_targets if table_targets.count(target) > 1})
    for target in duplicates:
        issues.append(f"README catalog lists {target} more than once")
    return issues


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

    print("=== Lab Structure Validation ===\n")

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

    print("\nRepository Markdown link integrity:")
    broken = check_markdown_links()
    if broken:
        for source, line, target, reason in broken:
            print(f"  FAIL  {source.relative_to(REPO_ROOT)}:{line}: {target} — {reason}")
    else:
        print(f"  PASS  all local links and anchors resolve in {len(tracked_markdown_files())} tracked Markdown files")

    print("\nREADME catalog consistency:")
    catalog_issues = check_readme_catalog()
    if catalog_issues:
        for issue in catalog_issues:
            print(f"  FAIL  {issue}")
    else:
        print(f"  PASS  all {len(folders)} labs are listed once with matching durations")

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
    print(f"  Broken internal links: {len(broken)}")
    print(f"  Catalog inconsistencies: {len(catalog_issues)}")
    print(f"  Unexpected collisions: {len(unexpected)}")

    ok = failed_labs == 0 and not broken and not catalog_issues and not unexpected
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
