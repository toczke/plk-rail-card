"""Constants for PLK Rail Card."""

from __future__ import annotations

import json
from pathlib import Path

DOMAIN = "plk_rail_card"
CONF_API_KEY = "api_key"
PLK_API_BASE = "https://pdp-api.plk-sa.pl/api/v1"
STATIC_URL = "/plk_rail_card"
CARD_FILENAME = "plk-rail-card.js"
CARD_URL = f"{STATIC_URL}/{CARD_FILENAME}"

MANIFEST_PATH = Path(__file__).parent / "manifest.json"
with MANIFEST_PATH.open(encoding="utf-8") as manifest_file:
    INTEGRATION_VERSION = json.load(manifest_file).get("version", "0.0.0")

CARD_RESOURCE_URL = f"{CARD_URL}?v={INTEGRATION_VERSION}"
