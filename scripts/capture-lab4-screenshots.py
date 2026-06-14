"""
Capture real screenshots from Copilot Studio for Lab 04.

Uses Playwright to connect to a pre-authenticated Edge browser via CDP
and navigates to each relevant page to capture screenshots.

Prerequisites:
  1. Close Edge completely
  2. Relaunch Edge with remote debugging:
       msedge --remote-debugging-port=9222
  3. Sign in to Copilot Studio in that Edge window
  4. Run this script:
       python scripts/capture-lab4-screenshots.py

Options:
  --auto-only       Skip interactive mode (auto-capturable pages only)
  --interactive     Jump straight to interactive mode
  --settle N        Seconds to wait after page renders (default: 10)
"""

import asyncio
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from playwright.async_api import async_playwright

# ── Configuration ──────────────────────────────────────────────────────────
ASSETS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "labs", "04-energy-census-advanced-agent", "assets"
)
os.makedirs(ASSETS_DIR, exist_ok=True)

ENV_ID = "6b988893-6c74-e65e-9d9a-f7f044be1d08"
BOT_ID = "dda49341-85f8-f011-8406-0022480a2745"
BASE = f"https://copilotstudio.microsoft.com/environments/{ENV_ID}"
AGENT_BASE = f"{BASE}/bots/{BOT_ID}"

CDP_URL = "http://localhost:9222"
VIEWPORT = {"width": 1400, "height": 900}

# Copilot Studio SPA indicators — wait for any of these to confirm page loaded
SPA_READY_SELECTORS = [
    '[data-testid]',
    '[class*="fluent"]',
    '.ms-Nav',
    'nav',
    '[role="navigation"]',
    '[role="main"]',
    'iframe',
]


# ── Screenshot definitions ─────────────────────────────────────────────────
SCREENSHOTS = [
    {
        "file": "copilot-studio-home.png",
        "url": "https://copilotstudio.microsoft.com/",
        "desc": "Copilot Studio home page",
    },
    {
        "file": "topic-add-from-blank.png",
        "url": f"{AGENT_BASE}/topics",
        "desc": "Topics page",
    },
    {
        "file": "adaptive-card-json-editor.png",
        "desc": "Adaptive Card JSON editor (open a topic with an Adaptive Card question node)",
        "manual": True,
    },
    {
        "file": "adaptive-card-preview.png",
        "desc": "Adaptive Card preview with City/State/Zip inputs",
        "manual": True,
    },
    {
        "file": "adaptive-card-output-mapping.png",
        "desc": "Save user response panel showing output-to-variable mapping",
        "manual": True,
    },
    {
        "file": "state-fips-switch-powerfx.png",
        "desc": "Set variable value node with Power Fx Switch expression",
        "manual": True,
    },
    {
        "file": "global-variables-list.png",
        "url": f"{AGENT_BASE}/variables",
        "desc": "Global variables panel",
    },
    {
        "file": "variable-picker-in-url.png",
        "desc": "Variable picker open over an HTTP URL field",
        "manual": True,
    },
    {
        "file": "tool-county-demographics-inputs.png",
        "url": f"{AGENT_BASE}/tools",
        "desc": "Tools page — Get County Demographics inputs",
    },
    {
        "file": "tool-county-demographics-test.png",
        "desc": "Tool test panel with a successful Census API response",
        "manual": True,
    },
    {
        "file": "connected-agent-sharing-enabled.png",
        "desc": "Census Data Specialist Settings — sharing toggle ON",
        "manual": True,
    },
    {
        "file": "connected-agent-config.png",
        "url": f"{AGENT_BASE}/agents",
        "desc": "Connected agents page",
    },
    {
        "file": "flow-agent-trigger.png",
        "desc": "Power Automate trigger picker — When an agent calls the flow",
        "manual": True,
    },
    {
        "file": "flow-state-summary-canvas.png",
        "desc": "Power Automate flow canvas with HTTP actions and Respond step",
        "manual": True,
    },
    {
        "file": "model-selection-comparison.png",
        "url": f"{AGENT_BASE}/generative-ai",
        "desc": "Model selection / Generative AI settings",
    },
    {
        "file": "eval-test-methods.png",
        "url": f"{AGENT_BASE}/evaluate",
        "desc": "Evaluation page — test set methods",
    },
    {
        "file": "evaluation-results.png",
        "desc": "Evaluation results dashboard (requires a completed eval run)",
        "manual": True,
    },
    {
        "file": "mcp-tool-discovery.png",
        "url": f"{AGENT_BASE}/tools",
        "desc": "MCP tool discovery on the Tools page",
    },
]


async def wait_for_spa(page, settle_seconds):
    """Wait for Copilot Studio SPA to fully render."""
    # Phase 1: Wait for any SPA framework indicator
    for selector in SPA_READY_SELECTORS:
        try:
            await page.wait_for_selector(selector, timeout=5000)
            break
        except Exception:
            pass

    # Phase 2: Wait for network to go quiet (no pending XHR/fetch)
    try:
        await page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass

    # Phase 3: Settle time for animations, lazy-loaded components
    await page.wait_for_timeout(settle_seconds * 1000)


async def capture_auto(page, screenshot, index, total, settle):
    """Navigate to a URL and capture the page."""
    filepath = os.path.join(ASSETS_DIR, screenshot["file"])
    prefix = f"  [{index+1}/{total}]"

    url = screenshot["url"]
    print(f"{prefix} {screenshot['file']}")
    print(f"         {screenshot['desc']}")
    print(f"         -> {url[:80]}...")

    try:
        await page.goto(url, wait_until="commit", timeout=60000)
        await wait_for_spa(page, settle)
        await page.screenshot(path=filepath, full_page=False)
        size_kb = os.path.getsize(filepath) / 1024
        print(f"         Saved ({size_kb:.0f} KB)")
        return True
    except Exception as e:
        print(f"         FAILED: {e}")
        return False


async def run_interactive(page, screenshots):
    """Interactive mode — user navigates, types filename to capture."""
    remaining = list(screenshots)
    print()
    print("=" * 60)
    print("  INTERACTIVE MODE")
    print("  Navigate in your browser window, then type the filename")
    print("  to capture. Type 'list' to see remaining, 'quit' to exit.")
    print("=" * 60)

    while remaining:
        print(f"\n  Remaining ({len(remaining)}):")
        for s in remaining:
            print(f"    {s['file']}")
            print(f"      {s['desc']}")

        try:
            filename = input("\n  Capture > ").strip()
        except EOFError:
            break

        if filename.lower() in ("quit", "exit", "q", ""):
            break
        if filename.lower() == "list":
            continue
        if filename.lower() == "all":
            # Capture current page for all remaining
            for s in list(remaining):
                fp = os.path.join(ASSETS_DIR, s["file"])
                await page.wait_for_timeout(1000)
                await page.screenshot(path=fp, full_page=False)
                kb = os.path.getsize(fp) / 1024
                print(f"    {s['file']} ({kb:.0f} KB)")
                remaining.remove(s)
            break

        match = next((s for s in remaining if s["file"] == filename), None)
        if not match:
            match = next((s for s in remaining if filename in s["file"]), None)
        if not match:
            print(f"  Unknown: {filename}")
            continue

        fp = os.path.join(ASSETS_DIR, match["file"])
        print(f"  Waiting 2s then capturing...")
        await page.wait_for_timeout(2000)
        await page.screenshot(path=fp, full_page=False)
        kb = os.path.getsize(fp) / 1024
        print(f"  Saved: {match['file']} ({kb:.0f} KB)")
        remaining.remove(match)

    return len(screenshots) - len(remaining)


async def main():
    parser = argparse.ArgumentParser(description="Capture Lab 04 screenshots from Copilot Studio")
    parser.add_argument("--auto-only", action="store_true", help="Skip interactive mode")
    parser.add_argument("--interactive", action="store_true", help="Jump to interactive mode")
    parser.add_argument("--settle", type=int, default=10, help="Seconds to wait after page load (default: 10)")
    args = parser.parse_args()

    print("=" * 60)
    print("  Lab 04 Screenshot Capture")
    print("=" * 60)
    print(f"  Output:  {ASSETS_DIR}")
    print(f"  CDP:     {CDP_URL}")
    print(f"  Settle:  {args.settle}s per page")
    print()

    async with async_playwright() as pw:
        try:
            browser = await pw.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            print("Could not connect to browser via CDP.")
            print()
            print("Relaunch Edge with remote debugging:")
            print("  1. Close ALL Edge windows")
            print('  2. & "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=9222')
            print("  3. Sign in to https://copilotstudio.microsoft.com/")
            print("  4. Run this script again")
            print()
            print(f"Error: {e}")
            return

        context = browser.contexts[0]

        # Open a fresh tab for capturing (don't disturb existing tabs)
        page = await context.new_page()
        await page.set_viewport_size(VIEWPORT)

        tab_count = len(context.pages)
        print(f"  Connected ({tab_count} tabs). Opened new capture tab.")
        print()

        auto_list = [s for s in SCREENSHOTS if not s.get("manual")]
        manual_list = [s for s in SCREENSHOTS if s.get("manual")]

        # Phase 1: Auto-capture
        if not args.interactive:
            print(f"--- Auto-capture ({len(auto_list)} pages) ---")
            captured = 0
            for i, ss in enumerate(auto_list):
                if await capture_auto(page, ss, i, len(auto_list), args.settle):
                    captured += 1
            print(f"\n  Auto: {captured}/{len(auto_list)} captured")

        # Phase 2: Interactive
        if manual_list and not args.auto_only:
            print(f"\n  {len(manual_list)} screenshots need manual navigation in the browser.")
            if args.interactive:
                count = await run_interactive(page, manual_list)
                print(f"\n  Interactive: {count}/{len(manual_list)} captured")
            else:
                try:
                    answer = input("  Enter interactive mode? (y/n): ").strip().lower()
                except EOFError:
                    answer = "n"
                if answer in ("y", "yes"):
                    count = await run_interactive(page, manual_list)
                    print(f"\n  Interactive: {count}/{len(manual_list)} captured")

        await page.close()
        print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
