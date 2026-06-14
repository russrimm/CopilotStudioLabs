"""Capture screenshot of current page in a browser tab via CDP, no navigation."""
import asyncio
import json
import base64
import os
import sys
import urllib.request

import websockets


async def main():
    output_file = sys.argv[1] if len(sys.argv) > 1 else "screenshot.png"
    tab_filter = sys.argv[2] if len(sys.argv) > 2 else "copilotstudio"

    tabs = json.loads(urllib.request.urlopen("http://localhost:9222/json").read())
    target = None
    for t in tabs:
        if tab_filter in t.get("url", "") and t["type"] == "page":
            target = t
            break

    if not target:
        print(f"No tab matching '{tab_filter}' found!")
        sys.exit(1)

    print(f"  Tab: {target['url'][:90]}")
    ws_url = target["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        msg_id = 0

        async def cmd(method, params=None):
            nonlocal msg_id
            msg_id += 1
            c = {"id": msg_id, "method": method}
            if params:
                c["params"] = params
            await ws.send(json.dumps(c))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == msg_id:
                    return r

        # No navigation — just screenshot what's currently displayed
        result = await cmd("Page.captureScreenshot", {"format": "png"})

        if "result" in result and "data" in result["result"]:
            img_data = base64.b64decode(result["result"]["data"])
            os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)
            with open(output_file, "wb") as f:
                f.write(img_data)
            print(f"  Saved: {output_file} ({len(img_data) / 1024:.0f} KB)")
        else:
            print(f"  Failed: {result.get('error', result)}")
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
