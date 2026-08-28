"""Discover supported battery devices from Home Assistant registries."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er


ROLE_SUFFIXES = {
    # Regulation is performed on the AC/grid side.  battery_power is the DC
    # cell-side value and includes conversion losses, so it must not be used
    # to balance an AC grid meter.
    "power": ("ac_power",),
    "grid_voltage": ("ac_voltage",),
    "soc": ("battery_soc", "battery_state_of_charge"),
    "state": ("inverter_state",),
    "temperature": ("internal_temperature", "battery_temperature"),
    "work_mode": ("user_work_mode",),
    "force_mode": ("force_mode",),
    "rs485_control_mode": ("rs485_control_mode",),
    "charge_power": ("set_charge_power",),
    "discharge_power": ("set_discharge_power",),
    "max_charge_power": ("max_charge_power",),
    "max_discharge_power": ("max_discharge_power",),
}

ROLE_NAMES = {
    "ac power": "power",
    "ac voltage": "grid_voltage",
    "battery soc": "soc",
    "battery state of charge": "soc",
    "inverter state": "state",
    "internal temperature": "temperature",
    "battery temperature": "temperature",
    "user work mode": "work_mode",
    "force mode": "force_mode",
    "rs485 control mode": "rs485_control_mode",
    "set charge power": "charge_power",
    "set discharge power": "discharge_power",
    "max charge power": "max_charge_power",
    "max discharge power": "max_discharge_power",
}


def _normalized(value: str) -> str:
    """Return a comparison-safe label."""
    plain = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", plain.lower()).strip()


def _role(entity_id: str, name: str) -> str | None:
    """Resolve a management role from stable suffixes, then display names."""
    object_id = entity_id.partition(".")[2].lower()
    for role, suffixes in ROLE_SUFFIXES.items():
        if any(object_id.endswith(suffix) for suffix in suffixes):
            return role
    return ROLE_NAMES.get(_normalized(name))


def discover_marstek_devices(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return Marstek devices, all their entities and useful role mappings."""
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    entries_by_device: dict[str, list[Any]] = {}
    for entry in entity_registry.entities.values():
        if entry.device_id:
            entries_by_device.setdefault(entry.device_id, []).append(entry)

    result: list[dict[str, Any]] = []
    for device_id, entries in entries_by_device.items():
        device = device_registry.async_get(device_id)
        if device is None:
            continue
        device_name = device.name_by_user or device.name or device_id
        manufacturer = device.manufacturer or ""
        platforms = {str(entry.platform).lower() for entry in entries}
        if not (
            "marstek" in device_name.lower()
            or "marstek" in manufacturer.lower()
            or any("marstek" in platform for platform in platforms)
        ):
            continue

        entities: list[dict[str, Any]] = []
        mapping: dict[str, str] = {}
        for entry in sorted(entries, key=lambda item: item.entity_id):
            name = er.async_get_unprefixed_name(hass, entry) or entry.entity_id
            state = hass.states.get(entry.entity_id)
            full_name = (
                state.attributes.get("friendly_name")
                if state is not None
                else None
            ) or name
            role = _role(entry.entity_id, name)
            if role and role not in mapping:
                mapping[role] = entry.entity_id
            entities.append(
                {
                    "entity_id": entry.entity_id,
                    "name": str(full_name),
                    "short_name": str(name),
                    "domain": entry.entity_id.partition(".")[0],
                    "disabled": entry.disabled_by is not None,
                    "role": role,
                }
            )
        result.append(
            {
                "device_id": device_id,
                "name": device_name,
                "manufacturer": manufacturer,
                "model": device.model or "",
                "entities": entities,
                "mapping": mapping,
            }
        )
    return sorted(result, key=lambda item: item["name"].lower())
