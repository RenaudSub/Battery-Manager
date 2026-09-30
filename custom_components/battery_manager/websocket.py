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
from .activity import CATEGORIES, configuration_changes
from .notification_rules import CATALOG, RULES, normalize_notifications

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
            "notification_actions": sorted(f"notify.{name}" for name in hass.services.async_services_for_domain("notify") if name.startswith("mobile_app_")),
            "notification_catalog": CATALOG,
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
        for change in configuration_changes(old_config, runtime["store"].data):
            _audit(runtime, connection, change)
        await runtime["journal"].async_flush()
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
        _audit(runtime, connection, f"Mode rapide {msg['battery_id']} : {next((b.get('control_mode') for b in old_config['batteries'] if str(b.get('id') or b['name']) == msg['battery_id']), '—')} → {msg['mode']}")
        await runtime["journal"].async_flush()
        await runtime["controller"].async_apply_disable_transitions(
            old_config, runtime["store"].data
        )
        await runtime["controller"].async_restart()
    except Exception as err:
        _LOGGER.exception("Unable to change Battery Manager quick mode")
        connection.send_error(msg["id"], "control_mode_failed", str(err))
        return
    connection.send_result(msg["id"], {"saved": True, "mode": msg["mode"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "battery_manager/set_active_profile",
        vol.Required("profile_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_active_profile(hass, connection, msg) -> None:
    """Select the global manual/automatic schedule profile."""
    runtime = hass.data[DOMAIN]
    try:
        old_profile = runtime["store"].data.get("active_profile")
        await runtime["store"].async_set_active_profile(msg["profile_id"])
        _audit(runtime, connection, f"Profil actif : {old_profile} → {msg['profile_id']}")
        await runtime["journal"].async_flush()
        await runtime["controller"].async_refresh_weather(force=True)
        await runtime["controller"].async_restart()
    except Exception as err:
        connection.send_error(msg["id"], "profile_failed", str(err))
        return
    connection.send_result(msg["id"], {"saved": True})


@websocket_api.websocket_command(
    {vol.Required("type"): "battery_manager/refresh_weather"}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_refresh_weather(hass, connection, msg) -> None:
    """Force an immediate weather forecast and cloud sensor refresh."""
    runtime = hass.data[DOMAIN]
    try:
        _audit(runtime, connection, "Actualisation manuelle de la météo")
        await runtime["controller"].async_refresh_weather(force=True)
        await runtime["journal"].async_flush()
    except Exception as err:
        _LOGGER.exception("Unable to refresh Battery Manager weather")
        connection.send_error(msg["id"], "weather_refresh_failed", str(err))
        return
    connection.send_result(
        msg["id"], {"status": runtime["controller"].status()}
    )


def _audit(runtime, connection, content):
    user = connection.user
    runtime["journal"].add("users", "Action utilisateur", f"{user.name or user.id} : {content}", actor=user.id)


@websocket_api.websocket_command({
    vol.Required("type"): "battery_manager/journal",
    vol.Required("category"): vol.In(CATEGORIES),
    vol.Optional("before"): vol.All(int, vol.Range(min=1)),
    vol.Optional("search", default=""): vol.All(str, vol.Length(max=200)),
    vol.Optional("since"): vol.Coerce(float),
    vol.Optional("until"): vol.Coerce(float),
    vol.Optional("limit", default=200): vol.All(int, vol.Range(min=1, max=500)),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_journal(hass, connection, msg):
    try:
        result = await hass.data[DOMAIN]["journal"].async_read(msg["category"], msg.get("before"), msg["search"], msg.get("since"), msg.get("until"), msg["limit"])
        connection.send_result(msg["id"], result)
    except Exception as err:
        connection.send_error(msg["id"], "journal_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "battery_manager/clear_journal"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_clear_journal(hass, connection, msg):
    runtime = hass.data[DOMAIN]
    try:
        await runtime["journal"].async_clear()
        _audit(runtime, connection, "Effacement des journaux")
        await runtime["journal"].async_flush()
        connection.send_result(msg["id"], {"cleared": True})
    except Exception as err:
        connection.send_error(msg["id"], "journal_failed", str(err))


@websocket_api.websocket_command({
    vol.Required("type"): "battery_manager/test_notification",
    vol.Optional("target"): dict,
    vol.Optional("rule_id"): vol.In(tuple(RULES)),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_test_notification(hass, connection, msg):
    runtime = hass.data[DOMAIN]
    try:
        rule_id = msg.get("rule_id")
        if "target" in msg:
            targets = normalize_notifications({"targets": [msg["target"]]}, [])["targets"]
        elif rule_id:
            config = runtime["store"].data["notifications"]
            selected = config["rules"][rule_id]["targets"]
            targets = [t for t in config["targets"] if t["id"] in selected]
        else:
            raise ValueError("Select a notification target")
        if not targets:
            raise ValueError("Select at least one notification target")
        _audit(runtime, connection, "Test de notification" + (f" : {rule_id}" if rule_id else ""))
        results = []
        for target in targets:
            results.append({"target": target["name"], "sent": await runtime["notifications"].async_test(target, rule_id)})
        await runtime["journal"].async_flush()
        connection.send_result(msg["id"], {"results": results})
    except Exception as err:
        connection.send_error(msg["id"], "notification_test_failed", str(err))


def async_register(hass: HomeAssistant) -> None:
    """Register WebSocket commands."""
    websocket_api.async_register_command(hass, ws_journal)
    websocket_api.async_register_command(hass, ws_clear_journal)
    websocket_api.async_register_command(hass, ws_test_notification)
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)
    websocket_api.async_register_command(hass, ws_set_control_mode)
    websocket_api.async_register_command(hass, ws_set_active_profile)
    websocket_api.async_register_command(hass, ws_refresh_weather)
