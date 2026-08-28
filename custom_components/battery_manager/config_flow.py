"""Config flow for Battery Manager."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector

from .const import DOMAIN


class BatteryManagerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single Battery Manager instance."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle initial setup."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(
                title="Battery Manager",
                data=user_input,
            )

        schema = vol.Schema(
            {
                vol.Required("grid_power_entity"): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="sensor")
                ),
                vol.Optional("grid_power_inverted", default=False): bool,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema)
