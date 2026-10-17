"""Persistent configuration store."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import (
    DEFAULT_CONFIG,
    SOLAR_CORRECTABLE_CONDITIONS,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .model import normalize_battery
from .notification_rules import normalize_notifications


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
        self._normalize_profiles()
        actions = self.data.get("backup_actions", {}) if isinstance(self.data.get("backup_actions"), dict) else {}
        self.data["backup_actions"] = {
            "entity_id": str(actions.get("entity_id", "")).strip(),
            "restore_on_exit": bool(actions.get("restore_on_exit", False)),
        }
        self.data["notifications"] = normalize_notifications(self.data.get("notifications"), self.data["batteries"])

    def _normalize_profiles(self) -> None:
        """Normalize global profile metadata and weather selection."""
        raw_profiles = self.data.get("schedule_profiles", [])
        profiles = []
        seen = set()
        for item in raw_profiles if isinstance(raw_profiles, list) else []:
            if not isinstance(item, dict):
                continue
            profile_id = str(item.get("id", "")).strip()
            name = str(item.get("name", "")).strip()
            if profile_id and name and profile_id not in seen:
                profiles.append({"id": profile_id, "name": name})
                seen.add(profile_id)
        for profile_id, name in (("sunny", "Ensoleillé"), ("cloudy", "Nuageux"), ("rainy", "Pluvieux")):
            if profile_id not in seen:
                profiles.append({"id": profile_id, "name": name})
        self.data["schedule_profiles"] = profiles
        valid = {item["id"] for item in profiles}
        active = str(self.data.get("active_profile", "sunny"))
        self.data["active_profile"] = active if active == "auto" or active in valid else "sunny"
        stored_weather = self.data.get("weather")
        stored_solar_conditions_version = (
            stored_weather.get("solar_conditions_version", 1)
            if isinstance(stored_weather, dict)
            else 1
        )
        weather = deepcopy(DEFAULT_CONFIG["weather"])
        if isinstance(stored_weather, dict):
            weather.update(stored_weather)
        weather["entity_id"] = str(weather.get("entity_id", "")).strip()
        weather["cloud_cover_entity"] = str(weather.get("cloud_cover_entity", "")).strip()
        weather["solar_irradiance_enabled"] = bool(
            weather.get("solar_irradiance_enabled", False)
        )
        weather["solar_irradiance_entity"] = str(
            weather.get("solar_irradiance_entity", "")
        ).strip()
        try:
            lux_per_wm2 = float(weather.get("solar_lux_per_wm2", 126.7))
        except (TypeError, ValueError):
            lux_per_wm2 = 126.7
        weather["solar_lux_per_wm2"] = max(1.0, min(1000.0, lux_per_wm2))
        try:
            solar_threshold = int(float(weather.get("solar_threshold_wm2", 100)))
        except (TypeError, ValueError):
            solar_threshold = 100
        try:
            solar_validation = int(float(weather.get("solar_validation_minutes", 5)))
        except (TypeError, ValueError):
            solar_validation = 5
        try:
            solar_hold = int(float(weather.get("solar_hold_minutes", 20)))
        except (TypeError, ValueError):
            solar_hold = 20
        weather["solar_threshold_wm2"] = max(100, min(400, solar_threshold))
        weather["solar_validation_minutes"] = max(1, min(30, solar_validation))
        weather["solar_hold_minutes"] = max(5, min(45, solar_hold))
        eligible = weather.get(
            "solar_eligible_conditions",
            ["sunny", "partlycloudy", "cloudy", "rainy", "lightning-rainy"],
        )
        if not isinstance(eligible, list):
            eligible = [
                "sunny",
                "partlycloudy",
                "cloudy",
                "rainy",
                "lightning-rainy",
            ]
        try:
            solar_conditions_version = int(stored_solar_conditions_version)
        except (TypeError, ValueError):
            solar_conditions_version = 1
        if solar_conditions_version < 2:
            eligible = [*eligible, "sunny", "rainy", "lightning-rainy"]
        weather["solar_conditions_version"] = 2
        allowed = set(SOLAR_CORRECTABLE_CONDITIONS)
        weather["solar_eligible_conditions"] = [
            condition
            for condition in dict.fromkeys(str(item) for item in eligible)
            if condition in allowed
        ]
        weather["forecast_offset_h"] = max(0, min(24, int(weather.get("forecast_offset_h", 1))))
        weather["refresh_minutes"] = max(5, min(120, int(weather.get("refresh_minutes", 15))))
        for key, fallback in (("analysis_start", "06:00"), ("analysis_end", "22:00")):
            value = str(weather.get(key, fallback))
            weather[key] = value if len(value) == 5 and value[2] == ":" else fallback
        weather["sunny_cloud_max"] = max(0, min(100, int(weather.get("sunny_cloud_max", 40))))
        weather["cloud_hysteresis"] = max(0, min(30, int(weather.get("cloud_hysteresis", 10))))
        try:
            rain_threshold = float(weather.get("rain_threshold_mm", 0.5))
        except (TypeError, ValueError):
            rain_threshold = 0.5
        weather["rain_threshold_mm"] = max(0.0, min(50.0, rain_threshold))
        weather["daylight_only"] = bool(weather.get("daylight_only", True))
        default_map = deepcopy(DEFAULT_CONFIG["weather"]["condition_map"])
        if isinstance(weather.get("condition_map"), dict):
            default_map.update({str(k): str(v) for k, v in weather["condition_map"].items()})
        valid_map = {item["id"] for item in profiles} | {"ignore"}
        weather["condition_map"] = {key: value if value in valid_map else DEFAULT_CONFIG["weather"]["condition_map"].get(key, "ignore") for key, value in default_map.items()}
        self.data["weather"] = weather

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
        actions = data.get("backup_actions", {}) if isinstance(data.get("backup_actions"), dict) else {}
        clean["backup_actions"] = {
            "entity_id": str(actions.get("entity_id", "")).strip(),
            "restore_on_exit": bool(actions.get("restore_on_exit", False)),
        }
        clean["schedule_profiles"] = deepcopy(data.get("schedule_profiles", DEFAULT_CONFIG["schedule_profiles"]))
        clean["active_profile"] = str(data.get("active_profile", "sunny"))
        clean["weather"] = deepcopy(data.get("weather", DEFAULT_CONFIG["weather"]))
        clean["batteries"] = [
            normalize_battery(item)
            for item in data.get("batteries", [])
            if isinstance(item, dict)
        ]
        clean["notifications"] = normalize_notifications(data.get("notifications"), clean["batteries"])
        self.data = clean
        self._normalize_profiles()
        self.data["notifications"] = normalize_notifications(self.data.get("notifications"), self.data["batteries"])
        await self._store.async_save(self.data)

    async def async_set_active_profile(self, profile_id: str) -> None:
        """Persist the globally selected manual/automatic profile."""
        valid = {item["id"] for item in self.data.get("schedule_profiles", [])}
        if profile_id != "auto" and profile_id not in valid:
            raise ValueError(f"Unknown profile: {profile_id}")
        self.data["active_profile"] = profile_id
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
