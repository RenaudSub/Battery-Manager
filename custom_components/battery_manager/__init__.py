"""Battery Manager integration."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL
from .controller import BatteryController
from .activity import ActivityJournal
from .notifications import NotificationManager
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from .store import BatteryManagerStore
from .websocket import async_register as async_register_websocket


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up integration-level resources once per Home Assistant process."""
    hass.data.setdefault(DOMAIN, {})
    async_register_websocket(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Battery Manager from a config entry."""
    store = BatteryManagerStore(hass)
    await store.async_load(dict(entry.data))
    journal = ActivityJournal(hass)
    await journal.async_flush()
    notifications = NotificationManager(hass, store, journal)
    await notifications.async_load()
    controller = BatteryController(hass, store)
    controller.notifications = notifications
    controller.journal = journal
    await controller.async_start()
    runtime = hass.data.setdefault(DOMAIN, {})
    runtime.update({"store": store, "controller": controller, "journal": journal, "notifications": notifications})
    async def stop_notifications(event):
        await controller.async_stop()
        await controller.async_stop_notifications()
        await notifications.async_close()
    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop_notifications))

    if not runtime.get("frontend_registered"):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    "/battery_manager/frontend",
                    str(frontend_dir),
                    cache_headers=False,
                )
            ]
        )
        runtime["frontend_registered"] = True
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="battery-manager-panel",
        frontend_url_path=PANEL_URL,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url="/battery_manager/frontend/battery-manager-panel.js?v=0.5.4",
        require_admin=True,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Battery Manager."""
    runtime = hass.data.get(DOMAIN)
    if runtime:
        controller = runtime.pop("controller", None)
        runtime.pop("store", None)
        if controller:
            await controller.async_stop()
            await controller.async_stop_notifications()
        notifications = runtime.pop("notifications", None)
        runtime.pop("journal", None)
        if notifications:
            await notifications.async_close()
    frontend.async_remove_panel(hass, PANEL_URL)
    return True
