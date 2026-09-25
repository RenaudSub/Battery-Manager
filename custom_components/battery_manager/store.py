"""Persistent configuration store."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DEFAULT_CONFIG, STORAGE_KEY, STORAGE_VERSION
from .model import normalize_battery


class BatteryManagerStore:
    """Persist user configuration in Home Assistant storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY
        )
        self.data: dict[str, Any] = deepcopy(DEFAULT_CONFIG)

    async def async_load(self, entry_data: dict[str, Any]) -> None:
        """Load stored data, falling back to config-entry values."""
        loaded = await self._store.async_load() or {}
        self.data.update(loaded)
        self.data.update(
            {
                key: value
                for key, value in entry_data.items()
                if key in ("grid_power_entity", "grid_power_inverted")
            }
        )
        self.data["batteries"] = [
            normalize_battery(item)
            for item in self.data.get("batteries", [])
            if isinstance(item, dict)
        ]

    async def async_save(self, data: dict[str, Any]) -> None:
        """Validate and save configuration supplied by the panel."""
        clean = deepcopy(DEFAULT_CONFIG)
        clean["grid_power_entity"] = str(data.get("grid_power_entity", ""))
        clean["grid_power_inverted"] = bool(
            data.get("grid_power_inverted", False)
        )
        clean["grid_zero_correction_w"] = max(
            -200, min(200, int(float(data.get("grid_zero_correction_w", 0) or 0)))
        )
        clean["deadband_w"] = max(0, int(data.get("deadband_w", 30)))
        clean["command_hysteresis_w"] = max(
            0, min(500, int(data.get("command_hysteresis_w", 30)))
        )
        clean["control_interval_s"] = max(
            1, min(60, int(data.get("control_interval_s", 5)))
        )
        clean["batteries"] = [
            normalize_battery(item)
            for item in data.get("batteries", [])
            if isinstance(item, dict)
        ]
        self.data = clean
        await self._store.async_save(self.data)

    async def async_set_control_mode(self, battery_id: str, mode: str) -> None:
        """Persist one overview quick-control selection."""
        updated = False
        for index, battery in enumerate(self.data.get("batteries", [])):
            current_id = str(battery.get("id") or battery.get("name"))
            if current_id != battery_id:
                continue
            raw = deepcopy(battery)
            raw["control_mode"] = mode
            self.data["batteries"][index] = normalize_battery(raw)
            updated = True
            break
        if not updated:
            raise ValueError(f"Unknown battery: {battery_id}")
        await self._store.async_save(self.data)
