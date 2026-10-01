"""Notification catalogue and pure configuration validation."""
from __future__ import annotations

from copy import deepcopy
import math
import re

# id, scope, threshold unit, default, linked battery limit, confirmation seconds.
_SPECS = [
    ("soc_low", "battery", "%", 10, "min_soc", 30),
    ("soc_high", "battery", "%", 98, "max_soc", 30),
    ("full", "battery", "%", 98, "max_soc", 30),
    ("soc_recovered", "battery", "%", 11, "min_soc_resume", 30),
    ("soc_gap", "battery", "%", 20, None, 120),
    ("temperature_high", "battery", "°C", 50, None, 60),
    ("temperature_low", "battery", "°C", 0, None, 60),
    ("temperature_recovered", "battery", "", None, None, 60),
    ("charge_start", "battery", "W", 20, None, 30),
    ("charge_end", "battery", "W", 20, None, 30),
    ("discharge_start", "battery", "W", 20, None, 30),
    ("discharge_end", "battery", "W", 20, None, 30),
    ("standby", "battery", "W", 20, None, 30),
    ("mode_unexpected", "battery", "", None, None, 120),
    ("underpower", "battery", "%", 50, None, 180),
    ("charge_overpower", "battery", "W", 2500, "max_charge_w", 30),
    ("discharge_overpower", "battery", "W", 800, "max_discharge_w", 30),
    ("standby_power", "battery", "W", 50, None, 120),
    ("command_error", "battery", "", None, None, 0),
    ("command_unconfirmed", "battery", "W", 100, None, 180),
    ("command_recovered", "battery", "", None, None, 0),
    ("program_start", "battery", "", None, None, 0),
    ("program_end", "battery", "", None, None, 0),
    ("program_blocked", "battery", "", None, None, 0),
    ("automatic_mode", "battery", "", None, None, 0),
    ("weather_change", "global", "", None, None, 0),
    ("weather_unavailable", "global", "", None, None, 60),
    ("weather_recovered", "global", "", None, None, 0),
    ("battery_unavailable", "battery", "", None, None, 60),
    ("battery_recovered", "battery", "", None, None, 0),
    ("sensor_unavailable", "battery", "", None, None, 60),
    ("sensor_stale", "battery", "min", 15, None, 60),
    ("grid_unavailable", "global", "", None, None, 60),
    ("grid_recovered", "global", "", None, None, 0),
    ("connection_lost", "battery", "", None, None, 60),
    ("connection_recovered", "battery", "", None, None, 0),
    ("daily_summary", "battery", "", None, None, 0),
]
_REARM_HOURS = {
    "charge_start": 14, "discharge_start": 14,
    "full": 12, "soc_high": 12,
    "command_unconfirmed": 4, "underpower": 4, "mode_unexpected": 4,
    "temperature_high": 1, "temperature_low": 1,
    "battery_unavailable": 1, "sensor_unavailable": 1,
    "grid_unavailable": 1, "connection_lost": 1,
}
CATALOG = [{
    "id": key, "scope": scope, "unit": unit, "default": default,
    "source": source, "confirm_s": confirm,
    "rearm_h": _REARM_HOURS.get(key, 0.25),
} for key, scope, unit, default, source, confirm in _SPECS]
RULES = {s["id"]: s for s in CATALOG}
DEFAULT_NOTIFICATIONS = {"targets": [], "rules": {}, "language": "fr"}


def _finite(value, default, minimum, maximum):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("Invalid notification threshold") from None
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"Notification value must be between {minimum} and {maximum}")
    return number


def valid_time(value):
    return bool(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(value)))


def normalize_notifications(raw, batteries):
    raw = raw if isinstance(raw, dict) else {}
    clean = deepcopy(DEFAULT_NOTIFICATIONS)
    language = raw.get("language", "fr")
    clean["language"] = language if language in ("fr", "en", "es") else "fr"
    seen, actions = set(), set()
    for target in raw.get("targets", []):
        key, action = str(target.get("id", "")), str(target.get("action", ""))
        start, end = target.get("start", "07:00"), target.get("end", "22:00")
        name = str(target.get("name", "")).strip()
        if not key or key in seen or action in actions or not re.fullmatch(r"notify\.mobile_app_[a-z0-9_]+", action) or not name:
            raise ValueError("Invalid or duplicate notification target")
        if not valid_time(start) or not valid_time(end) or start >= end:
            raise ValueError("Notification target: start must be before end, without crossing midnight")
        clean["targets"].append({"id": key, "action": action, "name": name[:100], "enabled": bool(target.get("enabled", True)), "start": start, "end": end})
        seen.add(key)
        actions.add(action)
    raw_rules = raw.get("rules", {})
    for spec in CATALOG:
        incoming = raw_rules.get(spec["id"], {})
        rule = {
            "targets": [str(t) for t in incoming.get("targets", []) if str(t) in seen],
            "batteries": {},
            "confirm_s": int(_finite(incoming.get("confirm_s", spec["confirm_s"]), 0, 0, 86400)),
            "rearm_h": _finite(incoming.get("rearm_h", spec["rearm_h"]), spec["rearm_h"], 0, 720),
        }
        for battery in batteries:
            key = str(battery.get("id") or battery["name"])
            previous = incoming.get("batteries", {}).get(key, {})
            threshold = previous.get("threshold")
            if threshold is not None and spec["default"] is not None:
                minimum = -100 if spec["unit"] == "°C" else 0
                maximum = 100 if spec["unit"] == "%" else 200 if spec["unit"] == "°C" else 1440 if spec["unit"] == "min" else 100000
                threshold = _finite(threshold, spec["default"], minimum, maximum)
            else:
                threshold = None
            rule["batteries"][key] = {"enabled": bool(previous.get("enabled", True)), "threshold": threshold}
        if spec["id"] == "daily_summary":
            rule["time"] = incoming.get("time", "20:00")
            if not valid_time(rule["time"]):
                raise ValueError("Invalid daily summary time")
        clean["rules"][spec["id"]] = rule
    return clean


def threshold_for(spec, rule, battery):
    key = str(battery.get("id") or battery["name"])
    custom = rule.get("batteries", {}).get(key, {}).get("threshold")
    if custom is not None:
        return float(custom)
    if spec.get("source"):
        return float(battery.get("limits", {}).get(spec["source"], spec["default"]))
    return spec["default"]


def in_window(target, local_now):
    return target.get("enabled", True) and target["start"] <= local_now.strftime("%H:%M") < target["end"]
