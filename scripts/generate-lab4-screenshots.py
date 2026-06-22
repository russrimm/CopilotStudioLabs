"""Generate instructional UI mockup screenshots for Lab 04."""
from PIL import Image, ImageDraw
import textwrap
import os
import sys

# Allow importing from scripts package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.config import env, get_loaded_files

# Show which env files are active (useful for debugging)
loaded = get_loaded_files()
if loaded:
    print(f"  Env loaded from: {', '.join(loaded)}")

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "labs", "06-energy-weather-agent", "assets"))

# Dark theme colors matching Copilot Studio
BG = (25, 28, 36)
SURFACE = (35, 39, 50)
BORDER = (55, 62, 80)
ACCENT = (79, 143, 247)
TEXT = (228, 230, 240)
MUTED = (139, 143, 168)
SUCCESS = (52, 211, 153)
WARNING = (251, 191, 36)
HEADER_BG = (20, 22, 28)
WHITE = (255, 255, 255)


def create_screenshot(filename, nav_title, description, content_lines):
    """Create a professional UI mockup screenshot."""
    W, H = 1200, 700
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Top nav bar
    draw.rectangle([0, 0, W, 48], fill=HEADER_BG)
    draw.text((16, 14), "Microsoft Copilot Studio", fill=ACCENT)
    draw.text((W - 200, 14), "Lab 04 Reference", fill=MUTED)

    # Breadcrumb/title area
    draw.rectangle([0, 48, W, 92], fill=SURFACE)
    draw.line([0, 92, W, 92], fill=BORDER)
    draw.text((20, 60), nav_title, fill=TEXT)

    # Description block
    y = 110
    wrapped = textwrap.wrap(description, width=100)
    for line in wrapped[:3]:
        draw.text((40, y), line, fill=MUTED)
        y += 22
    y += 16

    # Content panel
    panel_top = y
    draw.rectangle([30, panel_top, W - 30, H - 50], outline=BORDER, width=1)
    draw.rectangle([30, panel_top, W - 30, panel_top + 1], fill=ACCENT)

    y = panel_top + 16
    for line in content_lines:
        if y > H - 70:
            break
        if line.startswith("##"):
            draw.text((50, y), line[2:].strip(), fill=ACCENT)
            y += 28
        elif line.startswith("--"):
            draw.line([50, y + 8, W - 50, y + 8], fill=BORDER)
            y += 20
        elif line.startswith(">>"):
            draw.text((50, y), line[2:].strip(), fill=SUCCESS)
            y += 24
        elif line.startswith("!!"):
            draw.text((50, y), line[2:].strip(), fill=WARNING)
            y += 24
        elif line.startswith("BTN:"):
            label = line[4:].strip()
            bw = len(label) * 9 + 24
            draw.rounded_rectangle([50, y, 50 + bw, y + 32], radius=5, fill=ACCENT)
            draw.text((62, y + 7), label, fill=WHITE)
            y += 44
        elif line.startswith("INPUT:"):
            label = line[6:].strip()
            draw.rectangle([50, y, 500, y + 30], outline=BORDER, width=1)
            draw.text((60, y + 6), label, fill=MUTED)
            y += 40
        elif line == "":
            y += 12
        else:
            draw.text((50, y), line, fill=TEXT)
            y += 22

    # Footer
    draw.rectangle([0, H - 40, W, H], fill=HEADER_BG)
    draw.text((16, H - 28), filename, fill=MUTED)
    draw.text((W - 300, H - 28), "Replace with actual UI capture", fill=WARNING)

    img.save(filename)
    print(f"  Created {filename}")


print("Generating Lab 04 screenshots...\n")

create_screenshot(
    "topic-add-from-blank.png",
    "Topics > Add a topic",
    "Topics page with the Add a topic menu open and From blank highlighted.",
    [
        "## Topics",
        "--",
        "  Name                          Status",
        "  Service Territory Lookup      Draft",
        "  Census Data Help              Draft",
        "  Greeting                      Published",
        "",
        "## + Add a topic",
        "  From blank              <-- selected",
        "  From description (AI)",
        "  From existing topic",
    ],
)

create_screenshot(
    "adaptive-card-json-editor.png",
    "Topic > Adaptive Card > JSON Editor",
    "Adaptive Card editor in JSON view with the city/state/zipCode payload.",
    [
        "## Adaptive Card JSON Editor",
        "--",
        "{",
        '  "type": "AdaptiveCard",',
        '  "version": "1.5",',
        '  "body": [',
        '    { "type": "Input.Text", "id": "city",',
        '      "label": "City", "placeholder": "e.g. San Diego" },',
        '    { "type": "Input.Text", "id": "state",',
        '      "label": "State", "placeholder": "e.g. CA" },',
        '    { "type": "Input.Text", "id": "zipCode",',
        '      "label": "Zip Code", "placeholder": "e.g. 92101" }',
        "  ],",
        '  "actions": [{ "type": "Action.Submit", "title": "Submit" }]',
        "}",
    ],
)

create_screenshot(
    "adaptive-card-preview.png",
    "Topic > Adaptive Card > Preview",
    "Adaptive Card preview rendering City, State, and Zip Code inputs with Submit.",
    [
        "## Card Preview",
        "--",
        "",
        "INPUT:City (e.g. San Diego)",
        "INPUT:State (e.g. CA)",
        "INPUT:Zip Code (e.g. 92101)",
        "",
        "BTN:Submit",
    ],
)

create_screenshot(
    "adaptive-card-output-mapping.png",
    "Topic > Save User Response",
    "Card outputs city, state, and zipCode mapped to topic variables.",
    [
        "## Save User Response As",
        "--",
        "Card Output          Map to Variable",
        "",
        "city           -->   Topic.City",
        "state          -->   Topic.State",
        "zipCode        -->   Topic.ZipCode",
        "",
        ">>All outputs mapped successfully.",
    ],
)

create_screenshot(
    "state-fips-switch-powerfx.png",
    "Topic > Set Variable Value",
    "Power Fx Switch expression mapping state abbreviations to FIPS codes.",
    [
        "## Set Variable: Global.varFIPS",
        "--",
        "Power Fx expression:",
        "",
        "Switch(Topic.State,",
        '  "CA", "06",',
        '  "TX", "48",',
        '  "NY", "36",',
        '  "FL", "12",',
        '  "AZ", "04",',
        '  "WA", "53",',
        '  "06"   // default',
        ")",
        "",
        "!!Tip: Replace with HTTP/connector lookup for full coverage",
    ],
)

create_screenshot(
    "global-variables-list.png",
    "Variables > Global Variables",
    "Global variables panel listing DefaultState, DefaultYear, and APIKey.",
    [
        "## Global Variables",
        "--",
        "Variable Name          Type      Value",
        "",
        'Global.DefaultState    Text      "CA"',
        'Global.DefaultYear     Text      "2022"',
        'Global.APIKey          Text      "your-census-api-key-here"',
        "",
        ">>3 global variables defined",
    ],
)

create_screenshot(
    "variable-picker-in-url.png",
    "Tool > HTTP Request > URL Builder",
    "Variable picker inserting Topic.DataYear, Topic.StateFIPS, and Global.APIKey into URL.",
    [
        "## HTTP Request URL",
        "--",
        "https://api.census.gov/data/",
        "  {Topic.DataYear}/acs/acs5",
        "  ?get=NAME,B01001_001E,B19013_001E",
        "  &for=county:*",
        "  &in=state:{Topic.StateFIPS}",
        "  &key={Global.APIKey}",
        "",
        "## Variable Picker (open)",
        "  Topic.DataYear",
        "  Topic.StateFIPS",
        "  Global.APIKey        <-- inserting",
    ],
)

create_screenshot(
    "tool-county-demographics-inputs.png",
    "Tools > Get County Demographics > Inputs",
    "Tool input configuration showing year, state, county, and apiKey inputs.",
    [
        "## Tool: Get County Demographics",
        "--",
        "Input        Type    Description",
        "",
        "year         Text    Four-digit ACS survey year (e.g. 2022)",
        "state        Text    Two-digit state FIPS code (e.g. 06)",
        "county       Text    Three-digit county FIPS code",
        "apiKey       Text    Census API key (from Global variable)",
        "",
        "## How inputs are filled",
        "year    = AI (inferred from conversation)",
        "state   = AI (from Topic.StateFIPS)",
        "county  = AI (from user request)",
        "apiKey  = Value: Global.APIKey",
    ],
)

create_screenshot(
    "tool-county-demographics-test.png",
    "Tools > Get County Demographics > Test",
    "Successful test response for Harris County, Texas.",
    [
        "## Test Tool: Get County Demographics",
        "--",
        "Inputs:",
        "  year=2022  state=48  county=201  apiKey=***",
        "",
        "BTN:Run Test",
        "",
        "## Response (200 OK)",
        '[["NAME","B01001_001E","B19013_001E","state","county"],',
        ' ["Harris County, Texas","4731145","61705","48","201"]]',
        "",
        ">>Test passed - valid Census API response",
    ],
)

create_screenshot(
    "connected-agent-sharing-enabled.png",
    "Weather Operations Specialist > Settings",
    "Agent sharing toggle enabled to allow other agents to use this agent.",
    [
        "## Weather Operations Specialist - Settings",
        "--",
        "",
        "Allow other agents to use this agent",
        "",
        ">>  [ON]  Toggle is ENABLED",
        "",
        "When enabled, other agents in your environment",
        "can connect to this agent and use it as a skill.",
        "",
        "!!Required for the parent Energy Operations Weather Agent",
        "!!to invoke this agent as a connected agent.",
    ],
)

create_screenshot(
    "connected-agent-config.png",
    "Energy Operations Weather Agent > Agents",
    "Weather Operations Specialist added as a connected agent.",
    [
        "## Connected Agents",
        "--",
        "",
        ">>Weather Operations Specialist             Connected",
        "",
        "  Description: Retrieves current conditions and",
        "  forecasts via the MSN Weather connector for any",
        "  service-territory location and interprets impact",
        "  on grid load, outage prep, and field operations.",
        "",
        "  Trigger phrases: weather, forecast, heat advisory,",
        "  storm prep, demand spike, grid load",
    ],
)

create_screenshot(
    "flow-agent-trigger.png",
    "Power Automate > New Flow > Trigger",
    "Trigger picker with When an agent calls the flow selected.",
    [
        "## Choose a Trigger",
        "--",
        "",
        "  Search: copilot studio",
        "",
        "  Copilot Studio (Premium)",
        "",
        ">>  When an agent calls the flow    <-- selected",
        "",
        "  Triggers when a Copilot Studio agent invokes",
        "  this flow as a tool or action. Define inputs",
        "  and outputs for the agent to use.",
    ],
)

create_screenshot(
    "flow-state-summary-canvas.png",
    "Power Automate > State Summary Flow",
    "Flow canvas: trigger, two HTTP actions, Compose, and Respond to agent.",
    [
        "## State Summary Flow - Canvas",
        "--",
        "  [When an agent calls the flow]",
        "    Inputs: stateFIPS, year, apiKey",
        "              |",
        "  [HTTP: Get Population Data]",
        "    GET census API /acs/acs5?get=B01001_001E",
        "              |",
        "  [HTTP: Get Income Data]",
        "    GET census API /acs/acs5?get=B19013_001E",
        "              |",
        "  [Compose: Format Summary]",
        "    Combine population + income into text",
        "              |",
        "  [Respond to the agent]",
        "    Output: stateSummaryText (string)",
    ],
)

create_screenshot(
    "model-selection-comparison.png",
    "Settings > Generative AI > Model Selection",
    "Primary model selector with side-by-side test comparison.",
    [
        "## Primary Model Selection",
        "--",
        "  Model:  GPT-4o            [Change]",
        "",
        "## Side-by-Side Comparison",
        "",
        "  Prompt: Summarize energy demand trends",
        "          for San Diego County",
        "",
        "  GPT-4o:          Detailed 3-paragraph analysis",
        "                   with data citations",
        "  GPT-4o-mini:     Brief 1-paragraph summary",
        "",
        "!!Use stronger models for multi-tool analysis.",
        "!!Use lighter models for simple lookups.",
    ],
)

create_screenshot(
    "eval-test-methods.png",
    "Evaluate > Create Test Set > Methods",
    "Test methods selection: Similarity, General quality, Keyword match.",
    [
        "## Create Test Set - Select Methods",
        "--",
        "",
        ">>  [x] Similarity",
        "       Compare response to expected answer text",
        "",
        ">>  [x] General quality",
        "       Rate overall response quality (1-5 scale)",
        "",
        ">>  [x] Keyword match",
        "       Check response contains required keywords",
        "",
        "  [ ] Exact match",
        "       Require exact string match",
        "",
        "  [ ] Custom",
        "       Custom evaluation logic (Power Fx)",
    ],
)

create_screenshot(
    "evaluation-results.png",
    "Evaluate > Results Dashboard",
    "Evaluation results with pass rate, per-test results, and failure details.",
    [
        "## Evaluation Results - Energy Census Test Set",
        "--",
        "  Overall: 8/10 passed (80%)",
        "",
        ">>  Q1: Population of Harris County, TX     PASS",
        ">>  Q2: Median income in Los Angeles         PASS",
        "  Q3: Housing units in Cook County           FAIL",
        "     Expected: ~2.2M  |  Got: request timeout",
        ">>  Q4: Employment by industry, Maricopa     PASS",
        ">>  Q5: State-level summary for California   PASS",
        "",
        "!!Fix: topic issues -> fix topic; tool issues ->",
        "!!fix descriptions; routing -> fix agent descriptions",
    ],
)

create_screenshot(
    "mcp-tool-discovery.png",
    "Tools > MCP Server > Census Data",
    "MCP tool discovery listing Census data tools.",
    [
        "## MCP Tools - Census Data Server",
        "--",
        "  Server: http://localhost:3001/census-mcp",
        "  Status: Connected",
        "",
        "## Discovered Tools (4)",
        "",
        ">>  get_population",
        "    Returns total population for a given geography",
        "",
        ">>  get_median_income",
        "    Returns median household income (B19013)",
        "",
        ">>  get_housing_stats",
        "    Returns housing unit counts and vacancy rates",
        "",
        ">>  get_employment_by_industry",
        "    Returns employment breakdown by NAICS sector",
    ],
)

print("\nAll 17 screenshots generated successfully!")
