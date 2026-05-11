"""PLK Rail Card integration and authenticated PLK OpenData proxy."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from aiohttp import web

try:
    from homeassistant.components.http import HomeAssistantView, StaticPathConfig
except ImportError:  # pragma: no cover - compatibility with older HA versions
    from homeassistant.components.http import HomeAssistantView

    StaticPathConfig = None
try:
    from homeassistant.components.frontend import add_extra_js_url
except ImportError:  # pragma: no cover - compatibility with older HA versions
    add_extra_js_url = None
from homeassistant.components.lovelace.const import DOMAIN as LOVELACE_DOMAIN
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CARD_RESOURCE_URL, CARD_URL, CONF_API_KEY, DOMAIN, PLK_API_BASE, STATIC_URL

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the PLK Rail Card proxy and frontend asset path."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["yaml"] = dict(config.get(DOMAIN, {}))
    if not hass.data[DOMAIN].get("view_registered"):
        hass.http.register_view(PlkRailProxyView(hass))
        hass.data[DOMAIN]["view_registered"] = True
    await _register_static_path(hass)
    await _register_frontend_card(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up PLK Rail Card from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["entry"] = dict(entry.data)
    if not hass.data[DOMAIN].get("view_registered"):
        hass.http.register_view(PlkRailProxyView(hass))
        hass.data[DOMAIN]["view_registered"] = True
    await _register_static_path(hass)
    await _register_frontend_card(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a PLK Rail Card config entry."""
    hass.data.setdefault(DOMAIN, {}).pop("entry", None)
    return True


async def _register_static_path(hass: HomeAssistant) -> None:
    """Expose the bundled Lovelace card JavaScript."""
    if hass.data.setdefault(DOMAIN, {}).get("static_registered"):
        return

    static_path = str(Path(__file__).parent / "www")
    if StaticPathConfig is not None and hasattr(hass.http, "async_register_static_paths"):
        await hass.http.async_register_static_paths([
            StaticPathConfig(STATIC_URL, static_path, True),
        ])
    else:
        hass.http.register_static_path(STATIC_URL, static_path, True)

    hass.data[DOMAIN]["static_registered"] = True


async def _register_frontend_card(hass: HomeAssistant) -> None:
    """Load the bundled card without requiring a manual Lovelace resource."""
    if hass.data.setdefault(DOMAIN, {}).get("frontend_registered"):
        return

    if add_extra_js_url is not None:
        add_extra_js_url(hass, CARD_RESOURCE_URL)
    await _register_lovelace_resource(hass)
    hass.data[DOMAIN]["frontend_registered"] = True


async def _register_lovelace_resource(hass: HomeAssistant) -> None:
    """Add or update the Lovelace resource entry when storage mode is available."""
    lovelace_data = hass.data.get(LOVELACE_DOMAIN)
    resources = getattr(lovelace_data, "resources", None)
    if resources is None and isinstance(lovelace_data, dict):
        resources = lovelace_data.get("resources")
    if resources is None:
        _schedule_lovelace_resource_retry(hass)
        _LOGGER.debug("Lovelace resource manager is not available yet; retry scheduled")
        return

    try:
        if not getattr(resources, "loaded", False):
            _schedule_lovelace_resource_retry(hass)
            _LOGGER.debug("Lovelace resources are not loaded yet; retry scheduled")
            return
        items = list(resources.async_items())
        existing = _find_card_resource(items)
        data = {"res_type": "module", "url": CARD_RESOURCE_URL}
        if existing:
            resource_id = existing.get("id")
            if existing.get("url") != CARD_RESOURCE_URL and resource_id:
                await resources.async_update_item(resource_id, data)
            return

        await resources.async_create_item(data)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not manage Lovelace resource for PLK Rail Card: %s", err)


def _schedule_lovelace_resource_retry(hass: HomeAssistant) -> None:
    """Try Lovelace resource registration again after Lovelace finishes loading."""
    if hass.data.setdefault(DOMAIN, {}).get("resource_retry_scheduled"):
        return

    hass.data[DOMAIN]["resource_retry_scheduled"] = True

    @callback
    def _retry(_now) -> None:
        hass.data.setdefault(DOMAIN, {})["resource_retry_scheduled"] = False
        hass.async_create_task(_register_lovelace_resource(hass))

    async_call_later(hass, 5, _retry)


def _find_card_resource(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Find an existing PLK Rail Card resource entry."""
    for item in items:
        url = str(item.get("url", ""))
        if url.split("?", maxsplit=1)[0] == CARD_URL:
            return item
    return None


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
            or stored_config.get("entry", {}).get(CONF_API_KEY)
            or stored_config.get("yaml", {}).get(CONF_API_KEY)
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
