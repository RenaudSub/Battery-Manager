"""Battery Manager integration."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL
from .controller import BatteryController
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
    controller = BatteryController(hass, store)
    await controller.async_start()
    runtime = hass.data.setdefault(DOMAIN, {})
    runtime.update({"store": store, "controller": controller})

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
        module_url="/battery_manager/frontend/battery-manager-panel.js?v=0.2.26",
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
    frontend.async_remove_panel(hass, PANEL_URL)
    return True
