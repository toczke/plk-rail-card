"""PLK Rail Card integration and authenticated PLK OpenData proxy."""

from __future__ import annotations

from pathlib import Path

from aiohttp import web

try:
    from homeassistant.components.http import HomeAssistantView, StaticPathConfig
except ImportError:  # pragma: no cover - compatibility with older HA versions
    from homeassistant.components.http import HomeAssistantView

    StaticPathConfig = None
from homeassistant.const import CONF_API_KEY
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

DOMAIN = "plk_rail_card"
PLK_API_BASE = "https://pdp-api.plk-sa.pl/api/v1"
STATIC_URL = "/plk_rail_card"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the PLK Rail Card proxy and frontend asset path."""
    hass.data[DOMAIN] = dict(config.get(DOMAIN, {}))
    hass.http.register_view(PlkRailProxyView(hass))
    await _register_static_path(hass)
    return True


async def _register_static_path(hass: HomeAssistant) -> None:
    """Expose the bundled Lovelace card JavaScript."""
    static_path = str(Path(__file__).parent / "www")
    if StaticPathConfig is not None and hasattr(hass.http, "async_register_static_paths"):
        await hass.http.async_register_static_paths([
            StaticPathConfig(STATIC_URL, static_path, True),
        ])
        return

    hass.http.register_static_path(STATIC_URL, static_path, True)


class PlkRailProxyView(HomeAssistantView):
    """Forward selected PLK OpenData API calls through Home Assistant."""

    url = "/api/plk_rail_card/{requested_path:.*}"
    name = "api:plk_rail_card"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the proxy view."""
        self.hass = hass

    async def get(self, request: web.Request, requested_path: str) -> web.Response:
        """Proxy GET requests to PLK OpenData."""
        stored_config = self.hass.data.get(DOMAIN, {})
        api_key = (
            request.headers.get("X-PLK-API-Key")
            or request.query.get(CONF_API_KEY)
            or stored_config.get(CONF_API_KEY)
        )
        if not api_key:
            return self._json_error("Missing PLK API key", 401)

        if not self._is_allowed_path(requested_path):
            return self._json_error("Path is not allowed", 403)

        session = async_get_clientsession(self.hass)
        target_url = f"{PLK_API_BASE}/{requested_path.lstrip('/')}"
        params = request.query.copy()
        params.pop(CONF_API_KEY, None)

        try:
            async with session.get(
                target_url,
                params=params,
                headers={
                    "X-API-Key": api_key,
                    "Content-Type": "application/json",
                },
            ) as response:
                body = await response.read()
                content_type = response.headers.get("Content-Type", "application/json")
                return web.Response(body=body, status=response.status, headers={"Content-Type": content_type})
        except Exception as err:  # noqa: BLE001
            return self._json_error(str(err), 502)

    @staticmethod
    def _is_allowed_path(path: str) -> bool:
        allowed_prefixes = (
            "schedules",
            "operations",
            "disruptions",
            "dictionaries/",
            "data-version",
        )
        return any(path.startswith(prefix) for prefix in allowed_prefixes)

    @staticmethod
    def _json_error(message: str, status: int) -> web.Response:
        return web.json_response({"message": message}, status=status)
