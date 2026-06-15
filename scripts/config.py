"""
Shared configuration loader for Python scripts.

Loads environment variables from .env files using a secure precedence chain:
  1. .env.local (highest priority, git-ignored, local dev secrets)
  2. portal/.env (portal-specific, git-ignored)
  3. .env (fallback, git-ignored)
  4. System environment variables (always available)

Usage:
    from scripts.config import env

    api_key = env("AZURE_CLIENT_ID")
    tenant = env("AZURE_TENANT_ID", default="")
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Find the repo root (parent of scripts/)
REPO_ROOT = Path(__file__).resolve().parent.parent

# Load in reverse precedence order (last loaded wins)
# This means .env.local values override portal/.env which overrides .env
_env_files = [
    REPO_ROOT / ".env",
    REPO_ROOT / "portal" / ".env",
    REPO_ROOT / ".env.local",
    REPO_ROOT / "portal" / ".env.local",
]

_loaded = []
for env_file in _env_files:
    if env_file.exists():
        load_dotenv(env_file, override=True)
        _loaded.append(str(env_file.relative_to(REPO_ROOT)))


def env(key: str, *, default: str | None = None, required: bool = False) -> str | None:
    """Get an environment variable with optional default and required check."""
    value = os.environ.get(key, default)
    if required and not value:
        loaded_msg = f" (loaded: {', '.join(_loaded) or 'none'})" if not _loaded else ""
        raise EnvironmentError(
            f"Required env var '{key}' is not set.{loaded_msg}\n"
            f"Add it to .env.local at the repo root:\n"
            f"  {key}=your-value-here"
        )
    return value


def get_loaded_files() -> list[str]:
    """Return list of .env files that were successfully loaded."""
    return _loaded.copy()


# Print loaded files when run directly (for debugging)
if __name__ == "__main__":
    print("Environment file loader")
    print(f"  Repo root: {REPO_ROOT}")
    print(f"  Loaded: {_loaded or '(none found)'}")
    print()
    print("Key variables:")
    sensitive = ["AZURE_CLIENT_SECRET", "SMTP_PASS"]
    for key in [
        "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
        "AZURE_KEYVAULT_URL", "SMTP_HOST", "SMTP_PASS",
        "MAIL_FROM", "MCP_SERVER_URL",
    ]:
        val = os.environ.get(key, "")
        if key in sensitive and val:
            val = val[:4] + "***" + val[-2:]
        print(f"  {key}: {val or '(not set)'}")
