"""Quick CDP screenshot capture for a single Copilot Studio page."""
import asyncio
import json
import base64
import os
import sys
import urllib.request

import websockets


async def main():
    target_url = sys.argv[1] if len(sys.argv) > 1 else None
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    wait_secs = int(sys.argv[3]) if len(sys.argv) > 3 else 15

    if not target_url or not output_file:
        print("Usage: python cdp-screenshot.py <url> <output.png> [wait_seconds]")
        sys.exit(1)

    # Find a Copilot Studio tab to reuse
    tabs = json.loads(urllib.request.urlopen("http://localhost:9222/json").read())
    cs_tab = None
    for t in tabs:
        if "copilotstudio" in t.get("url", "") and t["type"] == "page":
            cs_tab = t
            break

    if not cs_tab:
        print("No Copilot Studio tab found in Edge!")
        sys.exit(1)

    ws_url = cs_tab["webSocketDebuggerUrl"]
    print(f"  Tab: {cs_tab['url'][:80]}")

    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        msg_id = 1

        async def send_cmd(method, params=None):
            nonlocal msg_id
            cmd = {"id": msg_id, "method": method}
            if params:
                cmd["params"] = params
            msg_id += 1
            await ws.send(json.dumps(cmd))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == msg_id - 1:
                    return resp

        # Navigate
        print(f"  Navigating: {target_url[:80]}...")
        await send_cmd("Page.navigate", {"url": target_url})

        # Wait for SPA render
        print(f"  Waiting {wait_secs}s for render...")
        await asyncio.sleep(wait_secs)

        # Set viewport
        await send_cmd(
            "Emulation.setDeviceMetricsOverride",
            {"width": 1400, "height": 900, "deviceScaleFactor": 1, "mobile": False},
        )
        await asyncio.sleep(1)

        # Capture
        result = await send_cmd("Page.captureScreenshot", {"format": "png"})

        if "result" in result and "data" in result["result"]:
            img_data = base64.b64decode(result["result"]["data"])
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            with open(output_file, "wb") as f:
                f.write(img_data)
            print(f"  Saved: {output_file} ({len(img_data) / 1024:.0f} KB)")
        else:
            print(f"  Failed: {result.get('error', result)}")
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
