import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import validate_labs
from validate_labs import (
    REPO_ROOT,
    REPOSITORY_RULE_IDS,
    RULE_IDS,
    RULES_BY_CHECK,
    check_authoring_markers,
    check_lab,
    check_markdown_accessibility,
    check_markdown_links,
    check_sections,
    check_single_title,
    duration_minutes,
    github_anchors,
    main,
    markdown_headings,
    validate_lab_dir,
)

MANIFEST_PATH = REPO_ROOT / "scripts" / "lab-validation-rules.json"

VALID_LAB = (
    "# Fixture Lab\n\n"
    "| Field | Details |\n"
    "|---|---|\n"
    "| **DIFFICULTY** | Beginner |\n"
    "| **TIME** | 30 minutes |\n\n"
    "## Overview\n\nWhat this lab covers.\n\n"
    "## Objectives\n\n- Learn the thing.\n\n"
    "## Prerequisites\n\n- An environment.\n\n"
    "## Step-by-Step\n\n"
    "### Step 1 - Configure\n\n"
    "```powershell\n# a comment, not a second title\nGet-Date\n```\n\n"
    "## Validation\n\nCheck the result.\n\n"
    "## Summary\n\nDone.\n"
)


class MarkdownLinkValidationTests(unittest.TestCase):
    def test_github_anchors_disambiguate_duplicate_headings(self):
        anchors = github_anchors("# Title\n\n## Repeat\n\n## Repeat\n")
        self.assertIn("title", anchors)
        self.assertIn("repeat", anchors)
        self.assertIn("repeat-1", anchors)

    def test_local_files_and_anchors_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "README.md"
            target = root / "guide.md"
            target.write_text("# Guide\n\n## Valid section\n", encoding="utf-8")
            source.write_text(
                "[valid](guide.md#valid-section)\n"
                "[example placeholder](url)\n"
                "[missing file](missing.md)\n"
                "[missing anchor](guide.md#not-there)\n",
                encoding="utf-8",
            )

            findings = check_markdown_links([source], root)
            self.assertEqual(len(findings), 2)
            self.assertIn("target does not exist", {finding[3] for finding in findings})
            self.assertIn('anchor "#not-there" does not exist', {finding[3] for finding in findings})

    def test_inline_code_is_not_treated_as_a_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "README.md"
            source.write_text(
                'Use `<img src="...">` and `<a href="...">` in the renderer.\n',
                encoding="utf-8",
            )

            self.assertEqual(check_markdown_links([source], root), [])

    def test_duration_minutes_normalizes_common_lab_formats(self):
        self.assertEqual(duration_minutes("**90 min**"), 90)
        self.assertEqual(duration_minutes("1 hour 30 minutes (including Q&A)"), 90)
        self.assertEqual(duration_minutes("2 hrs (+25 min optional)"), 120)

    def test_rendered_markdown_accessibility_is_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "lab.md"
            source.write_text(
                "# Lab\n\n"
                "   ### Skipped heading\n\n"
                "Field |  | Details\n"
                "---|---|---\n"
                "A | B | C\n\n"
                "![screenshot]\n"
                "[click here]\n"
                "<img\n src=\"other.png\"\n alt=image>\n"
                "\n[screenshot]: shot.png\n"
                "[click here]: guide.md\n",
                encoding="utf-8",
            )

            findings = check_markdown_accessibility([source], root)
            reasons = {finding[2] for finding in findings}
            self.assertIn("heading level skips from H1 to H3", reasons)
            self.assertIn("Markdown table has an empty header cell", reasons)
            self.assertIn("image has missing or generic alt text", reasons)
            self.assertIn("link text is not meaningful out of context", reasons)
            self.assertIn("HTML image has no meaningful alt text", reasons)

            clean = root / "clean.md"
            clean.write_text(
                "# Lab\n\n"
                "## Architecture\n\n"
                "<img\n src=\"architecture.png\"\n alt=Architecture-diagram>\n",
                encoding="utf-8",
            )
            self.assertEqual(check_markdown_accessibility([clean], root), [])

    def test_unfinished_authoring_markers_are_reported_with_line_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "lab.md"
            source.write_text(
                "# Lab\n\n"
                "TODO: replace this draft instruction.\n\n"
                "`TODO` is allowed in inline code.\n\n"
                "```text\nFIXME is allowed in a code sample.\n```\n",
                encoding="utf-8",
            )

            findings = check_authoring_markers([source], root)

            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0][1], 3)
            self.assertEqual(findings[0][2], "TODO")
            self.assertIn("replace the marker", findings[0][3])


def write_lab(root, markdown):
    lab = Path(root) / "lab"
    lab.mkdir()
    (lab / "index.md").write_text(markdown, encoding="utf-8")
    return lab


class SingleTitleTests(unittest.TestCase):
    def check(self, markdown):
        with tempfile.TemporaryDirectory() as directory:
            return check_single_title(write_lab(directory, markdown) / "index.md")

    def test_one_title_passes(self):
        self.assertIsNone(self.check("# Lab\n\n## Section\n\n### Step 1\n"))

    def test_fenced_comment_is_not_a_title(self):
        # Lab 33's shape: PowerShell comments inside a ```powershell sample.
        self.assertIsNone(
            self.check("# Lab\n\n```powershell\n# No admin required:\nnpm i\n```\n\n## Next\n")
        )
        self.assertIsNone(self.check("# Lab\n\n~~~bash\n# a shell comment\n~~~\n"))

    def test_fence_closes_only_on_a_matching_fence(self):
        self.assertIsNone(
            self.check("# Lab\n\n````md\n```\n# inside the outer fence\n```\n````\n")
        )
        self.assertIsNone(self.check("# Lab\n\n```text\n~~~\n# still code\n```\n"))

    def test_inline_triple_backticks_do_not_open_a_fence(self):
        message = self.check("# Lab\n\nWrite ```js``` to open a block.\n\n# Second\n")
        self.assertIn("found 2", message)

    def test_second_title_fails_with_line_numbers(self):
        message = self.check("# Lab\n\n## Overview\n\n# 🧪 Use Case #1\n\n## Scenario\n")
        self.assertIn("found 2", message)
        self.assertIn("lines 1, 5", message)
        self.assertIn("section headings start at H2", message)

    def test_missing_title_fails(self):
        self.assertIn("found none", self.check("## Only a section\n"))
        self.assertIn("found none", self.check("```md\n# Fenced title\n```\n"))

    def test_headings_match_the_portal_validator(self):
        self.assertEqual(
            markdown_headings("# A\r\n```\r\n# b\r\n```\r\n## C  \r\n#NoSpace\r\n"),
            [(1, 1, "A"), (5, 2, "C")],
        )


class LabDirectoryTests(unittest.TestCase):
    def test_section_checks_ignore_headings_inside_code(self):
        with tempfile.TemporaryDirectory() as directory:
            lab = write_lab(directory, VALID_LAB.replace("## Overview", "```md\n## Overview\n```"))
            self.assertIn("has-overview", check_sections(lab / "index.md"))

    def test_check_lab_reports_rule_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(check_lab(directory), [("index-exists", "index.md missing")])
            lab = write_lab(directory, VALID_LAB + "\n# Appendix\n\nMore.\n")
            self.assertEqual([rule for rule, _ in check_lab(lab)], ["single-title"])

    def run_lab_dir(self, markdown):
        with tempfile.TemporaryDirectory() as directory:
            lab = write_lab(directory, markdown)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(["--lab-dir", str(lab)])
            return code, output.getvalue()

    def test_lab_dir_passes_a_valid_lab(self):
        code, output = self.run_lab_dir(VALID_LAB)
        self.assertEqual(code, 0, output)
        self.assertIn("RESULT: PASS", output)

    def test_lab_dir_runs_every_per_lab_check(self):
        broken = VALID_LAB.replace("## Prerequisites", "#### Prerequisites").replace(
            "Check the result.", "Check [here](https://example.com) and [the notes](missing.md). TODO"
        ) + "\n# Appendix\n\nMore.\n"
        code, output = self.run_lab_dir(broken)
        self.assertEqual(code, 1)
        self.assertIn("single-title", output)
        self.assertIn("heading level skips", output)
        self.assertIn("link text is not meaningful", output)
        self.assertIn("target does not exist", output)
        self.assertIn("'TODO' is unfinished authoring text", output)
        self.assertNotIn("README catalog", output)

    def test_lab_dir_rejects_a_missing_directory(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(validate_lab_dir(Path(directory) / "absent"), 1)


class ValidatorParityTests(unittest.TestCase):
    """validate_labs.py and portal/lib/validator.js must not drift apart silently."""

    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_every_check_function_declares_its_rules(self):
        checks = {name for name in dir(validate_labs) if name.startswith("check_")}
        self.assertEqual(
            checks - set(RULES_BY_CHECK),
            set(),
            "add the new check to RULES_BY_CHECK and scripts/lab-validation-rules.json",
        )
        for name in RULES_BY_CHECK:
            self.assertTrue(callable(getattr(validate_labs, name, None)), name)
        self.assertEqual(len(RULE_IDS), len(set(RULE_IDS)), "rule ids are unique")

    def test_python_validator_implements_exactly_the_manifests_python_rules(self):
        manifest_ids = {
            rule["id"] for rule in self.manifest["rules"] if "python" in rule["validators"]
        }
        self.assertEqual(
            manifest_ids,
            set(RULE_IDS),
            "a rule was added to or removed from validate_labs.py without updating "
            "scripts/lab-validation-rules.json",
        )

    def test_repository_scope_matches_what_lab_dir_skips(self):
        manifest_ids = {
            rule["id"] for rule in self.manifest["rules"] if rule["scope"] == "repository"
        }
        self.assertEqual(manifest_ids, set(REPOSITORY_RULE_IDS))

    def test_single_validator_rules_say_why(self):
        for rule in self.manifest["rules"]:
            self.assertTrue(set(rule["validators"]) <= {"js", "python"}, rule["id"])
            if len(rule["validators"]) == 1:
                self.assertTrue(rule.get("asymmetry"), f"{rule['id']} needs an asymmetry reason")


if __name__ == "__main__":
    unittest.main()
