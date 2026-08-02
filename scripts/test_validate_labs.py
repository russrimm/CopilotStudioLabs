import tempfile
import unittest
from pathlib import Path

from validate_labs import (
    check_authoring_markers,
    check_markdown_accessibility,
    check_markdown_links,
    duration_minutes,
    github_anchors,
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


if __name__ == "__main__":
    unittest.main()
