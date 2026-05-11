"""Config flow for PLK Rail Card."""

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries

from .const import CONF_API_KEY, DOMAIN


class PlkRailCardConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a PLK Rail Card config flow."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None):
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            api_key = str(user_input.get(CONF_API_KEY, "")).strip()
            return self.async_create_entry(
                title="PLK Rail Card",
                data={CONF_API_KEY: api_key} if api_key else {},
            )

        schema = vol.Schema({
            vol.Optional(CONF_API_KEY): str,
        })
        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
        )

