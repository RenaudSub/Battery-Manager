"""Constants for Battery Manager."""

DOMAIN = "battery_manager"
STORAGE_KEY = f"{DOMAIN}.config"
STORAGE_VERSION = 1
PANEL_URL = "battery-manager"
PANEL_TITLE = "Battery Manager"
PANEL_ICON = "mdi:battery-charging"

MODE_DISABLED = "disabled"
MODE_SCHEDULE = "schedule"

ACTION_CHARGE = "charge"
ACTION_DISCHARGE = "discharge"
ACTION_SELF_CONSUMPTION = "self_consumption"
ACTION_SOLAR_CHARGE = "solar_charge"
ACTION_NATIVE_SELF_CONSUMPTION = "native_self_consumption"
ACTION_DEFAULT_MODE = "default_mode"
ACTION_STANDBY = "standby"
ACTIONS = (
    ACTION_CHARGE,
    ACTION_DISCHARGE,
    ACTION_SELF_CONSUMPTION,
    ACTION_SOLAR_CHARGE,
    ACTION_NATIVE_SELF_CONSUMPTION,
    ACTION_DEFAULT_MODE,
    ACTION_STANDBY,
)

DEFAULT_CONFIG = {
    "grid_power_entity": "",
    "grid_power_inverted": False,
    "grid_zero_correction_w": 0,
    "deadband_w": 30,
    "command_hysteresis_w": 30,
    "control_interval_s": 5,
    "batteries": [],
}
