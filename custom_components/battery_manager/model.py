"""Pure data model and schedule helpers."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .const import (
    ACTIONS,
    ACTION_CHARGE,
    ACTION_DISCHARGE,
    ACTION_DEFAULT_MODE,
    ACTION_NATIVE_SELF_CONSUMPTION,
    ACTION_SOLAR_CHARGE,
    ACTION_STANDBY,
)

SLOTS_PER_DAY = 96


def empty_slot() -> dict[str, Any]:
    """Return a safe default schedule slot."""
    return {
        "action": ACTION_STANDBY,
        "charge_w": 0,
        "discharge_w": 0,
        "min_soc": None,
        "max_soc": None,
    }


def empty_schedule() -> list[dict[str, Any]]:
    """Return a 24-hour schedule in 15-minute slots."""
    return [empty_slot() for _ in range(SLOTS_PER_DAY)]


def slot_index(moment: datetime) -> int:
    """Return the current 15-minute slot index."""
    return moment.hour * 4 + moment.minute // 15


def normalize_schedule(value: Any) -> list[dict[str, Any]]:
    """Validate and normalize a schedule supplied by the UI."""
    if not isinstance(value, list):
        return empty_schedule()
    result: list[dict[str, Any]] = []
    for raw in value[:SLOTS_PER_DAY]:
        raw = raw if isinstance(raw, dict) else {}
        action = raw.get("action", ACTION_STANDBY)
        if action not in ACTIONS:
            action = ACTION_STANDBY
        result.append(
            {
                "action": action,
                "charge_w": max(0, int(float(raw.get("charge_w", 0) or 0))),
                "discharge_w": max(
                    0, int(float(raw.get("discharge_w", 0) or 0))
                ),
                "min_soc": _optional_soc(raw.get("min_soc")),
                "max_soc": _optional_soc(raw.get("max_soc")),
            }
        )
    result.extend(empty_slot() for _ in range(SLOTS_PER_DAY - len(result)))
    return result


def _optional_soc(value: Any) -> float | None:
    """Normalize an optional per-slot SOC boundary."""
    if value in (None, ""):
        return None
    return max(0.0, min(100.0, float(value)))


def normalize_tiers(value: Any) -> list[dict[str, Any]]:
    """Normalize ordered, contiguous charge tiers."""
    if not isinstance(value, list):
        return []
    tiers = []
    for raw in value[:8]:
        if not isinstance(raw, dict):
            continue
        requested_start = max(
            0.0, min(100.0, float(raw.get("from_soc", 0)))
        )
        # Only the first lower boundary is configurable. Every following tier
        # starts exactly where the previous one ends, preventing gaps and
        # overlaps even if an older or hand-edited configuration contains one.
        start = tiers[-1]["to_soc"] if tiers else requested_start
        end = max(start, min(100.0, float(raw.get("to_soc", 100))))
        limit = raw.get("max_charge_w")
        tiers.append(
            {
                "from_soc": start,
                "to_soc": end,
                "max_charge_w": None
                if limit in (None, "", 0, "0")
                else max(1, int(float(limit))),
            }
        )
    return tiers


def default_battery(name: str = "Nouvelle batterie") -> dict[str, Any]:
    """Return the default battery configuration."""
    return {
        "id": "",
        "name": name,
        "adapter": "generic",
        "enabled": False,
        "operation_mode": "disabled",
        "disabled_behavior": "standby",
        "command_refresh_s": 60,
        "capacity_kwh": 0.0,
        "charge_compensation_w": 0,
        "discharge_compensation_w": 0,
        "power_inverted": False,
        "grid_loss_return_default": False,
        "grid_return_resume": False,
        "source_device_id": "",
        "entities": {
            "power": "",
            "soc": "",
            "state": "",
            "temperature": "",
            "grid_voltage": "",
            "work_mode": "",
            "force_mode": "",
            "rs485_control_mode": "",
            "charge_power": "",
            "discharge_power": "",
            "max_charge_power": "",
            "max_discharge_power": "",
        },
        "mqtt": {"mode_topic": "", "power_topic": ""},
        "mode_values": {
            "manual": "Manual",
            "charge": "Charge",
            "discharge": "Discharge",
            "self_consumption": "Self Consumption",
            "native_self_consumption": "Self Consumption",
            "ai_optimization": "AI Optimization",
            "standby": "Standby",
        },
        "limits": {
            "min_soc": 10.0,
            "min_soc_resume": 11.0,
            "max_soc": 98.0,
            "max_soc_resume": 97.0,
            "max_charge_w": 2500,
            "max_discharge_w": 800,
        },
        "charge_tiers": [
            {"from_soc": 0, "to_soc": 85, "max_charge_w": None},
            {"from_soc": 85, "to_soc": 90, "max_charge_w": 1500},
            {"from_soc": 90, "to_soc": 95, "max_charge_w": 500},
            {"from_soc": 95, "to_soc": 100, "max_charge_w": 250},
        ],
        "schedule": empty_schedule(),
    }


def normalize_battery(raw: dict[str, Any]) -> dict[str, Any]:
    """Merge a battery with defaults and validate nested values."""
    result = default_battery(str(raw.get("name") or "Batterie"))
    for key in (
        "id",
        "name",
        "adapter",
        "enabled",
        "operation_mode",
        "disabled_behavior",
        "command_refresh_s",
        "capacity_kwh",
        "charge_compensation_w",
        "discharge_compensation_w",
        "power_inverted",
        "grid_loss_return_default",
        "grid_return_resume",
        "source_device_id",
    ):
        if key in raw:
            result[key] = raw[key]
    for section in ("entities", "mqtt", "mode_values", "limits"):
        if isinstance(raw.get(section), dict):
            result[section].update(raw[section])
    result["charge_tiers"] = normalize_tiers(raw.get("charge_tiers"))
    result["schedule"] = normalize_schedule(raw.get("schedule"))
    allowed_disabled_behaviors = {
        "hoymiles_msa2": {
            "standby",
            "native_self_consumption",
            "native_schedule",
        },
        "marstek_entities": {
            "standby",
            "native_self_consumption",
            "manual",
            "ai_optimization",
        },
    }.get(result["adapter"], {"standby"})
    if result["disabled_behavior"] not in allowed_disabled_behaviors:
        result["disabled_behavior"] = "standby"
    result["command_refresh_s"] = max(
        0, min(86400, int(float(result.get("command_refresh_s", 60) or 0)))
    )
    result["grid_loss_return_default"] = bool(
        result.get("grid_loss_return_default", False)
    )
    result["grid_return_resume"] = bool(result.get("grid_return_resume", False))
    for key in ("charge_compensation_w", "discharge_compensation_w"):
        result[key] = max(-200, min(200, int(round(float(result.get(key, 0) or 0)))))
    pilotage = bool(result["enabled"] and result["operation_mode"] == "schedule")
    result["enabled"] = pilotage
    result["operation_mode"] = "schedule" if pilotage else "disabled"
    return result


@dataclass(slots=True)
class Decision:
    """Effective decision after all protections."""

    action: str
    charge_w: int = 0
    discharge_w: int = 0
    reason: str = "programme"


def charge_tier_limit(battery: dict[str, Any], soc: float) -> int | None:
    """Return the applicable SOC charge tier limit."""
    tiers = battery.get("charge_tiers", [])
    for tier in tiers:
        if tier["from_soc"] <= soc < tier["to_soc"]:
            return tier.get("max_charge_w")
    # Keep the last configured protection active above its upper boundary.
    # This is especially important when max_soc is 98 % and the reported SOC
    # briefly reaches 100 %: the battery must not return to its unrestricted
    # hardware maximum.
    if tiers and soc >= tiers[-1]["to_soc"]:
        return tiers[-1].get("max_charge_w")
    return None


def decide(
    battery: dict[str, Any],
    slot: dict[str, Any],
    soc: float,
    grid_power_w: float,
    charge_blocked: bool = False,
    discharge_blocked: bool = False,
    deadband_w: int = 30,
) -> Decision:
    """Resolve schedule, SOC limits, tiers and self-consumption."""
    limits = battery["limits"]
    action = slot["action"]
    slot_min = slot.get("min_soc")
    slot_max = slot.get("max_soc")
    effective_min = max(
        float(limits["min_soc"]),
        float(slot_min) if slot_min is not None else float(limits["min_soc"]),
    )
    effective_max = min(
        float(limits["max_soc"]),
        float(slot_max) if slot_max is not None else float(limits["max_soc"]),
    )
    if soc >= effective_max:
        charge_blocked = True
    if soc <= effective_min:
        discharge_blocked = True

    max_charge = int(limits["max_charge_w"])
    tier_limit = charge_tier_limit(battery, soc)
    if tier_limit is not None:
        max_charge = min(max_charge, tier_limit)
    max_discharge = int(limits["max_discharge_w"])

    if action == "charge":
        if charge_blocked:
            return Decision(ACTION_STANDBY, reason="soc_maximum")
        return Decision(
            action,
            charge_w=min(int(slot["charge_w"]), max_charge),
            reason="palier_soc" if tier_limit is not None else "programme",
        )
    if action == "discharge":
        if discharge_blocked:
            return Decision(ACTION_STANDBY, reason="soc_minimum")
        return Decision(
            action,
            discharge_w=min(int(slot["discharge_w"]), max_discharge),
        )
    if action == "self_consumption":
        if abs(grid_power_w) <= deadband_w:
            return Decision(ACTION_STANDBY, reason="zone_morte")
        if grid_power_w > 0:
            if discharge_blocked:
                return Decision(ACTION_STANDBY, reason="soc_minimum")
            requested = min(int(slot["discharge_w"]), int(grid_power_w))
            return Decision(ACTION_DISCHARGE, discharge_w=min(requested, max_discharge))
        if charge_blocked:
            return Decision(ACTION_STANDBY, reason="soc_maximum")
        requested = min(int(slot["charge_w"]), int(abs(grid_power_w)))
        return Decision(ACTION_CHARGE, charge_w=min(requested, max_charge))
    if action == ACTION_SOLAR_CHARGE:
        # Charge only from a measured export. Import or deadband can never
        # result in a discharge command in this mode.
        if grid_power_w >= -deadband_w:
            return Decision(ACTION_STANDBY, reason="surplus_solaire_absent")
        if charge_blocked:
            return Decision(ACTION_STANDBY, reason="soc_maximum")
        requested = min(int(slot["charge_w"]), int(abs(grid_power_w)))
        return Decision(ACTION_CHARGE, charge_w=min(requested, max_charge))
    if action == ACTION_NATIVE_SELF_CONSUMPTION:
        if battery.get("adapter") != "marstek_entities":
            return Decision(ACTION_STANDBY, reason="native_mode_unsupported")
        return Decision(ACTION_NATIVE_SELF_CONSUMPTION, reason="native_mode")
    if action == ACTION_DEFAULT_MODE:
        return Decision(ACTION_DEFAULT_MODE, reason="retour_mode_defaut")
    return Decision(ACTION_STANDBY)


def public_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return a defensive copy for the frontend."""
    return deepcopy(config)
