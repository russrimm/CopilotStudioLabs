import tempfile
import unittest
from pathlib import Path

from validate_labs import check_markdown_links, duration_minutes, github_anchors


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

    def test_duration_minutes_normalizes_common_lab_formats(self):
        self.assertEqual(duration_minutes("**90 min**"), 90)
        self.assertEqual(duration_minutes("1 hour 30 minutes (including Q&A)"), 90)
        self.assertEqual(duration_minutes("2 hrs (+25 min optional)"), 120)


if __name__ == "__main__":
    unittest.main()
