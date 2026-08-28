"""WebSocket API used by the sidebar panel."""

from __future__ import annotations

import logging
from copy import deepcopy

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .discovery import discover_marstek_devices
from .model import public_config

_LOGGER = logging.getLogger(__name__)


@websocket_api.websocket_command({vol.Required("type"): "battery_manager/config"})
@websocket_api.async_response
async def ws_get_config(hass, connection, msg) -> None:
    """Return stored configuration and controller status."""
    runtime = hass.data[DOMAIN]
    connection.send_result(
        msg["id"],
        {
            "config": public_config(runtime["store"].data),
            "status": runtime["controller"].status(),
            "marstek_devices": discover_marstek_devices(hass),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "battery_manager/save",
        vol.Required("config"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_config(hass, connection, msg) -> None:
    """Save panel configuration."""
    runtime = hass.data[DOMAIN]
    try:
        old_config = deepcopy(runtime["store"].data)
        await runtime["store"].async_save(msg["config"])
        await runtime["controller"].async_apply_disable_transitions(
            old_config,
            runtime["store"].data,
        )
        await runtime["controller"].async_restart()
    except Exception as err:  # Home Assistant must return a useful UI error.
        _LOGGER.exception("Unable to save Battery Manager configuration")
        connection.send_error(msg["id"], "save_failed", str(err))
        return
    connection.send_result(msg["id"], {"saved": True})


def async_register(hass: HomeAssistant) -> None:
    """Register WebSocket commands."""
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)
