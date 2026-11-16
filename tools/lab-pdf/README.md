# Lab PDF Generator

Generates print-ready PDF walkthroughs (`<lab-id>-walkthrough.pdf`) from the 40 curated hand-written labs under `labs/<lab-id>/index.md` without requiring the Provisioning Portal (`http://localhost:3005`) to be running. When pre-generated PDFs exist in `dist/lab-pdfs/`, the portal serves them at `GET /api/labs/:id/pdf` (see [`portal/README.md`](../../portal/README.md)).

> **Hand-written vs. generated labs:** This Playwright-based CLI renders the curated labs in `labs/`. Custom labs created by the 6-product Lab Builder (`generated-labs/<slug>/`) use the portal's built-in, zero-dependency pure-Node PDF builder (`portal/lib/lab-builder/pdf-builder.js` via `GET /api/lab-builder/generated/:labId/export?format=pdf`), which requires neither `tools/lab-pdf` nor Playwright (see [`docs/lab-builder.md`](../../docs/lab-builder.md#8-multi-format-and-per-topic-exports)).

## Usage

```powershell
cd tools\lab-pdf
npm install
npm run generate
npm run generate -- --lab=06-energy-weather-agent
npm run generate -- --out=..\..\dist\custom-lab-pdfs
```

Output defaults to `dist\lab-pdfs\` at the repository root. Each file is named `<lab-id>-walkthrough.pdf`.

The tool reuses the Playwright installation and browser binaries from `tools\screenshot-capture\`. If Playwright is not available there, install it locally in this folder (`npm install playwright && npx playwright install chromium`).

## Screenshots

Markdown image references are embedded inline and repeated in a full-size appendix. Inline screenshots link to their appendix page, and appendix pages link back to the inline reference.

If a referenced screenshot is missing, generation continues. The PDF shows a yellow "Screenshot pending" placeholder and the terminal logs a warning with the missing relative path. Add the image under the lab's `assets\` folder and rerun the generator.
