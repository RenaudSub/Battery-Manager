"""WebSocket API used by the sidebar panel."""

from __future__ import annotations

import logging
from copy import deepcopy

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .discovery import discover_marstek_devices
from .model import CONTROL_MODES, public_config

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


@websocket_api.websocket_command(
    {
        vol.Required("type"): "battery_manager/set_control_mode",
        vol.Required("battery_id"): str,
        vol.Required("mode"): vol.In(CONTROL_MODES),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_control_mode(hass, connection, msg) -> None:
    """Apply and persist a quick mode selected from the overview."""
    runtime = hass.data[DOMAIN]
    try:
        old_config = deepcopy(runtime["store"].data)
        await runtime["store"].async_set_control_mode(
            msg["battery_id"], msg["mode"]
        )
        await runtime["controller"].async_apply_disable_transitions(
            old_config, runtime["store"].data
        )
        await runtime["controller"].async_restart()
    except Exception as err:
        _LOGGER.exception("Unable to change Battery Manager quick mode")
        connection.send_error(msg["id"], "control_mode_failed", str(err))
        return
    connection.send_result(msg["id"], {"saved": True, "mode": msg["mode"]})


def async_register(hass: HomeAssistant) -> None:
    """Register WebSocket commands."""
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)
    websocket_api.async_register_command(hass, ws_set_control_mode)
