"""Tests for the pure scheduling model."""

from datetime import datetime

from custom_components.battery_manager.model import (
    charge_tier_limit,
    decide,
    default_battery,
    empty_schedule,
    normalize_schedule,
    normalize_battery,
    normalize_tiers,
    slot_index,
)


def test_schedule_has_96_slots() -> None:
    assert len(empty_schedule()) == 96
    assert slot_index(datetime(2026, 8, 24, 23, 59)) == 95
    assert slot_index(datetime(2026, 8, 24, 7, 30)) == 30


def test_schedule_is_normalized() -> None:
    result = normalize_schedule([{"action": "charge", "charge_w": "500"}])
    assert len(result) == 96
    assert result[0]["charge_w"] == 500
    assert result[1]["action"] == "standby"


def test_default_mode_schedule_action_is_preserved() -> None:
    result = normalize_schedule([{"action": "default_mode"}])
    assert result[0]["action"] == "default_mode"


def test_pilotage_fields_are_kept_consistent() -> None:
    active = normalize_battery(
        {"name": "Active", "enabled": True, "operation_mode": "schedule"}
    )
    assert active["enabled"] is True
    assert active["operation_mode"] == "schedule"

    inactive = normalize_battery(
        {"name": "Inactive", "enabled": True, "operation_mode": "disabled"}
    )
    assert inactive["enabled"] is False
    assert inactive["operation_mode"] == "disabled"
    assert inactive["disabled_behavior"] == "standby"
    assert inactive["command_refresh_s"] == 60


def test_disabled_behaviors_are_adapter_specific() -> None:
    hoymiles = normalize_battery(
        {"adapter": "hoymiles_msa2", "disabled_behavior": "native_schedule"}
    )
    assert hoymiles["disabled_behavior"] == "native_schedule"

    marstek = normalize_battery(
        {"adapter": "marstek_entities", "disabled_behavior": "ai_optimization"}
    )
    assert marstek["disabled_behavior"] == "ai_optimization"

    invalid = normalize_battery(
        {"adapter": "hoymiles_msa2", "disabled_behavior": "manual"}
    )
    assert invalid["disabled_behavior"] == "standby"


def test_power_compensations_are_normalized() -> None:
    battery = normalize_battery(
        {"charge_compensation_w": 50, "discharge_compensation_w": -250}
    )
    assert battery["charge_compensation_w"] == 50
    assert battery["discharge_compensation_w"] == -200


def test_grid_loss_options_and_voltage_entity_are_preserved() -> None:
    battery = normalize_battery(
        {
            "grid_loss_return_default": True,
            "grid_return_resume": True,
            "entities": {"grid_voltage": "sensor.marstek_ac_voltage"},
        }
    )
    assert battery["grid_loss_return_default"] is True
    assert battery["grid_return_resume"] is True
    assert battery["entities"]["grid_voltage"] == "sensor.marstek_ac_voltage"


def test_charge_tiers_are_forced_contiguous() -> None:
    tiers = normalize_tiers(
        [
            {"from_soc": 0, "to_soc": 85, "max_charge_w": 1000},
            {"from_soc": 83, "to_soc": 92, "max_charge_w": 750},
            {"from_soc": 90, "to_soc": 95, "max_charge_w": 400},
        ]
    )
    assert tiers[0]["from_soc"] == 0
    assert tiers[1]["from_soc"] == 85
    assert tiers[2]["from_soc"] == 92


def test_charge_tier_caps_program() -> None:
    battery = default_battery()
    slot = {"action": "charge", "charge_w": 2000, "discharge_w": 0}
    result = decide(battery, slot, soc=92, grid_power_w=-2000)
    assert result.action == "charge"
    assert result.charge_w == 500
    assert result.reason == "palier_soc"


def test_last_charge_tier_remains_active_at_100_percent() -> None:
    battery = default_battery()
    battery["charge_tiers"] = [
        {"from_soc": 0, "to_soc": 85, "max_charge_w": 2500},
        {"from_soc": 85, "to_soc": 92, "max_charge_w": 2000},
        {"from_soc": 92, "to_soc": 96, "max_charge_w": 1000},
        {"from_soc": 96, "to_soc": 98, "max_charge_w": 500},
    ]
    assert charge_tier_limit(battery, 100) == 500


def test_maximum_soc_blocks_charge() -> None:
    battery = default_battery()
    slot = {"action": "charge", "charge_w": 1000, "discharge_w": 0}
    result = decide(battery, slot, soc=98, grid_power_w=-1000)
    assert result.action == "standby"
    assert result.reason == "soc_maximum"


def test_minimum_soc_blocks_discharge() -> None:
    battery = default_battery()
    slot = {"action": "discharge", "charge_w": 0, "discharge_w": 800}
    result = decide(battery, slot, soc=10, grid_power_w=1000)
    assert result.action == "standby"
    assert result.reason == "soc_minimum"


def test_slot_soc_limits_are_stricter_than_global_limits() -> None:
    battery = default_battery()
    slot = {
        "action": "self_consumption",
        "charge_w": 1000,
        "discharge_w": 800,
        "min_soc": 50,
        "max_soc": 90,
    }
    below_min = decide(battery, slot, soc=45, grid_power_w=600)
    assert below_min.action == "standby"
    assert below_min.reason == "soc_minimum"

    charge_below_min = decide(battery, slot, soc=45, grid_power_w=-600)
    assert charge_below_min.action == "charge"

    above_max = decide(battery, slot, soc=95, grid_power_w=-600)
    assert above_max.action == "standby"
    assert above_max.reason == "soc_maximum"

    discharge_above_max = decide(battery, slot, soc=95, grid_power_w=600)
    assert discharge_above_max.action == "discharge"


def test_global_soc_limits_remain_prioritary() -> None:
    battery = default_battery()
    slot = {
        "action": "discharge",
        "charge_w": 0,
        "discharge_w": 800,
        "min_soc": 5,
        "max_soc": 100,
    }
    result = decide(battery, slot, soc=9, grid_power_w=1000)
    assert result.action == "standby"
    assert result.reason == "soc_minimum"


def test_self_consumption_obeys_grid_and_limits() -> None:
    battery = default_battery()
    slot = {
        "action": "self_consumption",
        "charge_w": 1000,
        "discharge_w": 800,
    }
    discharge = decide(battery, slot, soc=50, grid_power_w=350)
    assert discharge.action == "discharge"
    assert discharge.discharge_w == 350

    charge = decide(battery, slot, soc=92, grid_power_w=-1200)
    assert charge.action == "charge"
    assert charge.charge_w == 500

    standby = decide(battery, slot, soc=50, grid_power_w=15)
    assert standby.action == "standby"
    assert standby.reason == "zone_morte"


def test_solar_charge_never_discharges() -> None:
    battery = default_battery()
    slot = {
        "action": "solar_charge",
        "charge_w": 1000,
        "discharge_w": 800,
    }
    charge = decide(battery, slot, soc=50, grid_power_w=-650)
    assert charge.action == "charge"
    assert charge.charge_w == 650

    importing = decide(battery, slot, soc=50, grid_power_w=900)
    assert importing.action == "standby"
    assert importing.discharge_w == 0
    assert importing.reason == "surplus_solaire_absent"


def test_native_self_consumption_is_marstek_only() -> None:
    battery = default_battery()
    slot = {"action": "native_self_consumption", "charge_w": 0, "discharge_w": 0}
    unsupported = decide(battery, slot, soc=50, grid_power_w=500)
    assert unsupported.action == "standby"
    assert unsupported.reason == "native_mode_unsupported"

    battery["adapter"] = "marstek_entities"
    native = decide(battery, slot, soc=50, grid_power_w=500)
    assert native.action == "native_self_consumption"
    assert native.reason == "native_mode"
