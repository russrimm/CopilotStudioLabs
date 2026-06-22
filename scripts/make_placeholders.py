#!/usr/bin/env python3
"""Generate captioned placeholder screenshots for labs that do not yet have real
captures. Replace these with live captures via tools/screenshot-capture.

Usage: python3 scripts/make_placeholders.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

W, H = 1200, 675
BG = (241, 245, 249)
BORDER = (148, 163, 184)
ACCENT = (79, 143, 247)
TEXT = (51, 65, 85)
SUBTEXT = (100, 116, 139)

# lab folder -> list of (filename, caption)
CATALOG = {
    "02-conversational-design-fundamentals": [
        ("topics-overview.png", "Topics page — topic list and '+ Add a topic' menu"),
        ("trigger-phrases.png", "Trigger node — example trigger phrases configured"),
        ("question-entity-node.png", "Question node using a prebuilt entity"),
    ],
    "12-content-moderation-responsible-ai": [
        ("generative-ai-settings.png", "Settings → Generative AI — moderation controls"),
        ("content-moderation-level.png", "Content moderation level selector"),
        ("test-guardrail-response.png", "Test canvas — guardrail-enforced refusal"),
    ],
    "34-authentication-end-user-signin": [
        ("security-authentication-page.png", "Settings → Security → Authentication"),
        ("entra-auth-config.png", "Manual Microsoft Entra ID authentication fields"),
        ("test-signin-prompt.png", "Agent prompting the end user to sign in"),
    ],
    "35-dlp-governance-policies": [
        ("ppac-dlp-policies.png", "Power Platform Admin Center — DLP policies list"),
        ("connector-classification.png", "Connector grouping: Business / Non-business / Blocked"),
        ("policy-applied-environment.png", "DLP policy scoped to an environment"),
    ],
}


def load_font(size, bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def make(path, lab, caption):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # border
    d.rectangle([6, 6, W - 7, H - 7], outline=BORDER, width=3)
    # accent bar
    d.rectangle([6, 6, W - 7, 70], fill=ACCENT)
    d.text((28, 26), "PLACEHOLDER SCREENSHOT", fill=(255, 255, 255), font=load_font(26, bold=True))
    # camera glyph (simple)
    cx, cy = W // 2, H // 2 - 40
    d.rounded_rectangle([cx - 90, cy - 55, cx + 90, cy + 55], radius=14, outline=SUBTEXT, width=5)
    d.rectangle([cx - 30, cy - 75, cx + 30, cy - 55], outline=SUBTEXT, width=5)
    d.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], outline=SUBTEXT, width=5)
    # caption
    cap_font = load_font(30, bold=True)
    tw = d.textlength(caption, font=cap_font)
    d.text(((W - tw) / 2, cy + 90), caption, fill=TEXT, font=cap_font)
    sub = f"{lab}  •  capture with tools/screenshot-capture"
    sub_font = load_font(22)
    sw = d.textlength(sub, font=sub_font)
    d.text(((W - sw) / 2, cy + 135), sub, fill=SUBTEXT, font=sub_font)
    img.save(path, "PNG")


def main():
    for lab, shots in CATALOG.items():
        assets = os.path.join(ROOT, "labs", lab, "assets")
        os.makedirs(assets, exist_ok=True)
        for filename, caption in shots:
            make(os.path.join(assets, filename), lab, caption)
            print("wrote", os.path.join("labs", lab, "assets", filename))


if __name__ == "__main__":
    main()
