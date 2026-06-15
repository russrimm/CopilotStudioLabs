# Lab PDF Generator

Generates print-ready PDF walkthroughs from each lab's `index.md` without requiring the portal to be running.

## Usage

```powershell
cd tools\lab-pdf
npm install
npm run generate
npm run generate -- --lab=04-energy-weather-agent
npm run generate -- --out=..\..\dist\custom-lab-pdfs
```

Output defaults to `dist\lab-pdfs\` at the repository root. Each file is named `<lab-id>-walkthrough.pdf`.

The tool reuses the Playwright installation and browser binaries from `tools\screenshot-capture\`. If Playwright is not available there, install it locally in this folder.

## Screenshots

Markdown image references are embedded inline and repeated in a full-size appendix. Inline screenshots link to their appendix page, and appendix pages link back to the inline reference.

If a referenced screenshot is missing, generation continues. The PDF shows a yellow "Screenshot pending" placeholder and the terminal logs a warning with the missing relative path. Add the image under the lab's `assets\` folder and rerun the generator.
