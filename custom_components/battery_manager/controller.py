"""Collective battery scheduler and command dispatcher."""

from __future__ import annotations

import logging
import asyncio
from datetime import datetime
from time import monotonic
from typing import Any

from homeassistant.components import mqtt
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import (
    ACTION_NATIVE_SELF_CONSUMPTION,
    ACTION_DEFAULT_MODE,
    ACTION_SELF_CONSUMPTION,
    ACTION_SOLAR_CHARGE,
    ACTION_STANDBY,
    MODE_SCHEDULE,
)
from .model import Decision, charge_tier_limit, decide, slot_index

_LOGGER = logging.getLogger(__name__)


def _number(hass: HomeAssistant, entity_id: str) -> float | None:
    """Read a numeric entity safely."""
    if not entity_id:
        return None
    state = hass.states.get(entity_id)
    if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
        return None
    try:
        return float(state.state)
    except (TypeError, ValueError):
        return None


class BatteryController:
    """Evaluate schedules and send guarded commands."""

    def __init__(self, hass: HomeAssistant, store: Any) -> None:
        self.hass = hass
        self.store = store
        self._remove_timer = None
        self._last_decisions: dict[str, dict[str, Any]] = {}
        self._last_commands: dict[str, dict[str, Any]] = {}
        self._charge_latches: dict[str, bool] = {}
        self._discharge_latches: dict[str, bool] = {}
        self._marstek_cache: dict[str, dict[str, Any]] = {}
        self._mqtt_cache: dict[str, dict[str, Any]] = {}
        self._collective_target_w: float | None = None
        self._collective_signature: tuple[tuple[str, str], ...] | None = None
        self._grid_guards: dict[str, dict[str, Any]] = {}

    async def async_start(self) -> None:
        """Start periodic evaluation."""
        from datetime import timedelta

        self._remove_timer = async_track_time_interval(
            self.hass,
            self._async_tick,
            timedelta(seconds=int(self.store.data.get("control_interval_s", 5))),
        )

    async def async_stop(self) -> None:
        """Stop periodic evaluation."""
        if self._remove_timer:
            self._remove_timer()
            self._remove_timer = None

    async def async_restart(self) -> None:
        """Restart after a configuration change."""
        await self.async_stop()
        self._collective_target_w = None
        self._collective_signature = None
        # Saving the configuration is the explicit manual way to clear a
        # latched grid-loss suspension (for example after four hours).
        self._grid_guards.clear()
        await self.async_start()

    async def _async_apply_default_mode(
        self, battery: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Apply the configured fallback without disabling the schedule."""
        if battery.get("adapter") == "marstek_entities":
            return await self._async_apply_disabled_marstek(battery)
        if battery.get("adapter") == "hoymiles_msa2":
            return await self._async_apply_disabled_msa2(battery)
        return None

    def _grid_guard_suspended(self, battery: dict[str, Any]) -> tuple[bool, str]:
        """Track a valid out-of-range AC voltage for sixty seconds.

        Missing, unknown and unavailable states return None through _number and
        explicitly break the outage timer. A numeric zero is a valid off-grid
        measurement and therefore participates in the sixty-second test.
        """
        battery_id = str(battery.get("id") or battery.get("name"))
        guard = self._grid_guards.setdefault(battery_id, {})
        if not battery.get("grid_loss_return_default"):
            guard.clear()
            return False, ""
        voltage = _number(self.hass, battery["entities"].get("grid_voltage", ""))
        now_mono = monotonic()
        if voltage is None:
            guard.pop("outside_since", None)
            return bool(guard.get("suspended")), "grid_voltage_unavailable"
        if 200.0 <= voltage <= 250.0:
            guard.pop("outside_since", None)
            if guard.get("suspended"):
                elapsed = now_mono - float(guard.get("suspended_at", now_mono))
                if battery.get("grid_return_resume") and elapsed <= 4 * 60 * 60:
                    guard.clear()
                    # Force the next scheduled command to reclaim control.
                    self._marstek_cache.pop(battery_id, None)
                    self._mqtt_cache.pop(battery_id, None)
                    return False, "grid_returned"
                return True, "grid_loss_latched"
            return False, ""
        outside_since = guard.setdefault("outside_since", now_mono)
        if not guard.get("suspended") and now_mono - float(outside_since) >= 60:
            guard["suspended"] = True
            guard["suspended_at"] = now_mono
        return bool(guard.get("suspended")), (
            "grid_loss_detected" if guard.get("suspended") else "grid_loss_pending"
        )

    async def async_apply_disable_transitions(
        self,
        old_config: dict[str, Any],
        new_config: dict[str, Any],
    ) -> None:
        """Apply a fallback only after an active-to-disabled change.

        A disabled battery is deliberately left untouched at integration
        startup and during every periodic tick.  The configured fallback is a
        transition command, not a state that Battery Manager must enforce.
        """
        old_batteries = {
            str(item.get("id") or item.get("name")): item
            for item in old_config.get("batteries", [])
            if isinstance(item, dict)
        }
        for battery in new_config.get("batteries", []):
            if not isinstance(battery, dict):
                continue
            battery_id = str(battery.get("id") or battery.get("name"))
            previous = old_batteries.get(battery_id)
            adapter = battery.get("adapter")
            if previous is None or adapter not in (
                "marstek_entities",
                "hoymiles_msa2",
            ):
                continue
            was_active = bool(
                previous.get("enabled")
                and previous.get("operation_mode") == MODE_SCHEDULE
            )
            is_active = bool(
                battery.get("enabled")
                and battery.get("operation_mode") == MODE_SCHEDULE
            )
            if not was_active or is_active:
                continue
            try:
                if adapter == "marstek_entities":
                    # A new explicit deactivation must be applied even when
                    # the same fallback was used during an earlier transition.
                    self._marstek_cache.pop(battery_id, None)
                    command = await self._async_apply_disabled_marstek(battery)
                else:
                    command = await self._async_apply_disabled_msa2(battery)
                status = {
                    "action": "disabled",
                    "reason": "gestion_desactivee",
                }
                if command:
                    status.update(command)
                    self._last_commands[battery_id] = command
                self._last_decisions[battery_id] = status
            except Exception as err:  # Do not prevent the remaining saves.
                _LOGGER.exception(
                    "Unable to apply disabled fallback for battery %s",
                    battery.get("name"),
                )
                self._last_decisions[battery_id] = {
                    "action": "blocked",
                    "reason": "command_error",
                    "error": str(err),
                }

    def status(self) -> dict[str, Any]:
        """Return current decisions for the panel."""
        decisions = {}
        for battery_id, decision in self._last_decisions.items():
            decisions[battery_id] = {
                **decision,
                **self._last_commands.get(battery_id, {}),
            }
        return {"decisions": decisions}

    async def _async_tick(self, now: datetime) -> None:
        config = self.store.data
        grid = _number(self.hass, config.get("grid_power_entity", ""))
        grid_available = grid is not None
        if not grid_available:
            self._last_decisions["_manager"] = {
                "action": "blocked",
                "reason": "grid_sensor_unavailable",
            }
            # Fixed schedules and their SOC protections must keep running even
            # when the collective grid sensor is temporarily unavailable.
            grid = 0.0
        if config.get("grid_power_inverted"):
            grid = -grid

        local_now = dt_util.as_local(now)
        index = slot_index(local_now)
        self_consumption: list[dict[str, Any]] = []
        for battery in config.get("batteries", []):
            battery_id = str(battery.get("id") or battery.get("name"))
            if not battery.get("enabled") or battery.get("operation_mode") != MODE_SCHEDULE:
                self._grid_guards.pop(battery_id, None)
                previous = self._last_decisions.get(battery_id, {})
                disabled_status = {
                    "action": "disabled",
                    "reason": "gestion_desactivee",
                }
                if previous.get("command_action"):
                    disabled_status.update(
                        {
                            key: previous[key]
                            for key in (
                                "command_action",
                                "command_power_w",
                                "command_transport",
                                "command_sent_at",
                            )
                            if key in previous
                        }
                    )
                self._last_decisions[battery_id] = disabled_status
                continue
            slot = battery["schedule"][index]
            grid_suspended, grid_reason = self._grid_guard_suspended(battery)
            if grid_suspended or slot["action"] == ACTION_DEFAULT_MODE:
                reason = grid_reason if grid_suspended else "retour_mode_defaut"
                status = {
                    "action": ACTION_DEFAULT_MODE,
                    "reason": reason,
                    "slot": index,
                }
                try:
                    command = await self._async_apply_default_mode(battery)
                    if command:
                        status.update(command)
                        self._last_commands[battery_id] = command
                except Exception as err:
                    _LOGGER.exception(
                        "Unable to apply default mode to battery %s",
                        battery.get("name"),
                    )
                    status.update(
                        {"action": "blocked", "reason": "command_error", "error": str(err)}
                    )
                self._last_decisions[battery_id] = status
                continue
            if (
                battery.get("adapter") == "marstek_entities"
                and not battery["entities"].get("rs485_control_mode")
            ):
                self._last_decisions[battery_id] = {
                    "action": "blocked",
                    "reason": "rs485_control_missing",
                }
                continue
            soc = _number(self.hass, battery["entities"].get("soc", ""))
            if soc is None:
                self._last_decisions[battery_id] = {
                    "action": "blocked",
                    "reason": "soc_unavailable",
                }
                continue
            self._update_latches(battery_id, battery, soc)
            if slot["action"] in (ACTION_SELF_CONSUMPTION, ACTION_SOLAR_CHARGE):
                if not grid_available:
                    self._last_decisions[battery_id] = {
                        "action": "blocked",
                        "reason": "grid_sensor_unavailable",
                    }
                    continue
                power = _number(self.hass, battery["entities"].get("power", ""))
                if power is None:
                    self._last_decisions[battery_id] = {
                        "action": "blocked",
                        "reason": "power_sensor_unavailable",
                    }
                    continue
                if battery.get("power_inverted"):
                    power = -power
                self_consumption.append(
                    {
                        "id": battery_id,
                        "battery": battery,
                        "slot": slot,
                        "soc": soc,
                        "power": power,
                    }
                )
                continue
            decision = decide(
                battery,
                slot,
                soc,
                grid,
                self._charge_latches.get(battery_id, False),
                self._discharge_latches.get(battery_id, False),
                int(config.get("deadband_w", 30)),
            )
            self._last_decisions[battery_id] = {
                "action": decision.action,
                "charge_w": decision.charge_w,
                "discharge_w": decision.discharge_w,
                "reason": decision.reason,
                "slot": index,
                "soc": soc,
            }
            try:
                await self._async_apply(battery, decision)
            except Exception as err:  # One battery must never stop the cycle.
                _LOGGER.exception(
                    "Unable to apply command to battery %s", battery.get("name")
                )
                self._last_decisions[battery_id].update(
                    {"action": "blocked", "reason": "command_error", "error": str(err)}
                )

        # Reconstruct the grid exchange that would exist without the batteries.
        # The normalized battery convention is positive while charging and
        # negative while discharging, whereas the grid convention is positive
        # consumption and negative injection. Its contribution must therefore
        # be subtracted from the measured grid value. Adding it causes feedback
        # oscillations and systematically underestimates an available surplus.
        # Multiple batteries then share this collective target by capacity.
        if self_consumption:
            collective_target = (
                grid
                - sum(item["power"] for item in self_consumption)
                + float(config.get("grid_zero_correction_w", 0))
            )
            # Apply the command hysteresis once to the collective target. All
            # batteries are then updated from the same frozen target instead
            # of accumulating one independent tolerance per battery.
            collective_hysteresis = max(
                0, int(config.get("command_hysteresis_w", 30))
            )
            collective_signature = tuple(
                sorted((item["id"], item["slot"]["action"]) for item in self_consumption)
            )
            if (
                collective_signature == self._collective_signature
                and self._collective_target_w is not None
                and abs(collective_target - self._collective_target_w)
                < collective_hysteresis
            ):
                collective_target = self._collective_target_w
            else:
                self._collective_target_w = collective_target
                self._collective_signature = collective_signature
            collective_deadband = max(0, int(config.get("deadband_w", 30)))
            if abs(collective_target) <= collective_deadband:
                collective_target = 0.0
            # Exclude SOC-blocked batteries before calculating the weights.
            # Previously their theoretical share was reserved and then lost
            # when decide() changed it to Standby.  The remaining batteries
            # must receive that share instead.
            provisional: dict[str, Decision] = {}
            for item in self_consumption:
                battery_id = item["id"]
                provisional[battery_id] = decide(
                    item["battery"],
                    item["slot"],
                    item["soc"],
                    collective_target,
                    self._charge_latches.get(battery_id, False),
                    self._discharge_latches.get(battery_id, False),
                    0,
                )
            expected_action = "charge" if collective_target < 0 else "discharge"
            eligible = [
                item
                for item in self_consumption
                if collective_target == 0
                or provisional[item["id"]].action == expected_action
            ]
            # Batteries excluded by their SOC protection, and solar-only
            # batteries facing an import, must be stopped explicitly.
            for item in self_consumption:
                if item in eligible:
                    continue
                battery_id = item["id"]
                decision = provisional[battery_id]
                self._last_decisions[battery_id] = {
                    "action": decision.action,
                    "charge_w": 0,
                    "discharge_w": 0,
                    "reason": decision.reason,
                    "slot": index,
                    "soc": item["soc"],
                    "collective_target_w": round(collective_target, 1),
                    "allocated_target_w": 0.0,
                }
                try:
                    await self._async_apply(item["battery"], decision, collective=True)
                except Exception as err:
                    _LOGGER.exception(
                        "Unable to stop solar-charge battery %s",
                        item["battery"].get("name"),
                    )
                    self._last_decisions[battery_id].update(
                        {"action": "blocked", "reason": "command_error", "error": str(err)}
                    )
            # Capacity-weighted allocation with redistribution when one
            # battery reaches its configured/tier power limit.
            shares = self._allocate_collective(eligible, collective_target)
            for item, share in zip(eligible, shares, strict=True):
                battery_id = item["id"]
                decision = decide(
                    item["battery"],
                    item["slot"],
                    item["soc"],
                    share,
                    self._charge_latches.get(battery_id, False),
                    self._discharge_latches.get(battery_id, False),
                    0,
                )
                self._last_decisions[battery_id] = {
                    "action": decision.action,
                    "charge_w": decision.charge_w,
                    "discharge_w": decision.discharge_w,
                    "reason": decision.reason,
                    "slot": index,
                    "soc": item["soc"],
                    "collective_target_w": round(collective_target, 1),
                    "allocated_target_w": round(share, 1),
                }
                try:
                    await self._async_apply(item["battery"], decision, collective=True)
                except Exception as err:  # Keep the remaining batteries alive.
                    _LOGGER.exception(
                        "Unable to apply collective command to battery %s",
                        item["battery"].get("name"),
                    )
                    self._last_decisions[battery_id].update(
                        {"action": "blocked", "reason": "command_error", "error": str(err)}
                    )
        else:
            self._collective_target_w = None
            self._collective_signature = None

    def _allocate_collective(
        self, items: list[dict[str, Any]], target_w: float
    ) -> list[float]:
        """Allocate a signed target by capacity and redistribute capped shares."""
        if not items or target_w == 0:
            return [0.0] * len(items)
        charging = target_w < 0
        remaining = abs(target_w)
        shares = [0.0] * len(items)
        active = set(range(len(items)))
        while active and remaining > 0.01:
            total_weight = sum(
                max(0.1, float(items[i]["battery"].get("capacity_kwh") or 0.1))
                for i in active
            )
            distributed = 0.0
            saturated: set[int] = set()
            for i in active:
                item = items[i]
                battery = item["battery"]
                weight = max(0.1, float(battery.get("capacity_kwh") or 0.1))
                proposed = remaining * weight / total_weight
                if charging:
                    limit = min(
                        int(battery["limits"]["max_charge_w"]),
                        int(item["slot"]["charge_w"]),
                    )
                    tier = charge_tier_limit(battery, item["soc"])
                    if tier is not None:
                        limit = min(limit, int(tier))
                else:
                    limit = min(
                        int(battery["limits"]["max_discharge_w"]),
                        int(item["slot"]["discharge_w"]),
                    )
                available = max(0.0, float(limit) - shares[i])
                addition = min(proposed, available)
                shares[i] += addition
                distributed += addition
                if available <= proposed + 0.01:
                    saturated.add(i)
            remaining -= distributed
            active -= saturated
            if distributed <= 0.01 or not saturated:
                break
        sign = -1.0 if charging else 1.0
        return [sign * value for value in shares]

    def _record_command(
        self,
        battery: dict[str, Any],
        decision: Decision,
        power_w: float | None,
        transport: str,
    ) -> None:
        """Expose the effective command for the diagnostic panel."""
        battery_id = str(battery.get("id") or battery.get("name"))
        current = self._last_decisions.setdefault(battery_id, {})
        current.update(
            {
                "action": decision.action,
                "reason": decision.reason or current.get("reason", ""),
                "command_action": decision.action,
                "command_power_w": power_w,
                "command_transport": transport,
                "command_sent_at": dt_util.now().isoformat(),
            }
        )
        self._last_commands[battery_id] = {
            key: current[key]
            for key in (
                "command_action",
                "command_power_w",
                "command_transport",
                "command_sent_at",
            )
        }

    def _update_latches(
        self, battery_id: str, battery: dict[str, Any], soc: float
    ) -> None:
        limits = battery["limits"]
        charge_blocked = self._charge_latches.get(battery_id, False)
        if soc >= float(limits["max_soc"]):
            charge_blocked = True
        elif soc <= float(limits["max_soc_resume"]):
            charge_blocked = False
        self._charge_latches[battery_id] = charge_blocked

        discharge_blocked = self._discharge_latches.get(battery_id, False)
        if soc <= float(limits["min_soc"]):
            discharge_blocked = True
        elif soc >= float(limits["min_soc_resume"]):
            discharge_blocked = False
        self._discharge_latches[battery_id] = discharge_blocked

    async def _async_apply(
        self,
        battery: dict[str, Any],
        decision: Decision,
        collective: bool = False,
    ) -> None:
        """Apply a command only for explicitly supported adapters."""
        decision = self._compensate_decision(battery, decision)
        adapter = battery.get("adapter")
        if adapter == "hoymiles_msa2":
            await self._async_apply_msa2(battery, decision, collective)
        elif adapter == "marstek_entities":
            await self._async_apply_marstek(battery, decision, collective)
        else:
            _LOGGER.debug("Monitoring-only battery: %s", battery.get("name"))

    def _compensate_decision(
        self, battery: dict[str, Any], decision: Decision
    ) -> Decision:
        """Apply the measured offset after logical scheduling limits.

        SOC tiers and schedule limits cap the useful power calculated by the
        model.  A positive compensation may exceed those logical caps so the
        measured power can still reach the requested value.  The configured
        battery maximum remains the absolute command limit.
        """
        if decision.action not in ("charge", "discharge"):
            return decision
        charging = decision.action == "charge"
        calculated = decision.charge_w if charging else decision.discharge_w
        if calculated <= 0:
            return decision
        key = "charge_compensation_w" if charging else "discharge_compensation_w"
        compensation = max(-200, min(200, int(battery.get(key, 0) or 0)))
        if charging:
            maximum = int(battery["limits"]["max_charge_w"])
        else:
            maximum = int(battery["limits"]["max_discharge_w"])
        effective = max(0, min(maximum, int(calculated) + compensation))
        battery_id = str(battery.get("id") or battery.get("name"))
        self._last_decisions.setdefault(battery_id, {}).update(
            {
                "calculated_command_w": int(calculated),
                "compensation_w": compensation,
            }
        )
        if charging:
            return Decision(
                decision.action,
                charge_w=effective,
                reason=decision.reason,
            )
        return Decision(
            decision.action,
            discharge_w=effective,
            reason=decision.reason,
        )

    async def _async_apply_msa2(
        self,
        battery: dict[str, Any],
        decision: Decision,
        collective: bool = False,
    ) -> None:
        mode_topic = battery["mqtt"].get("mode_topic")
        power_topic = battery["mqtt"].get("power_topic")
        if not mode_topic or not power_topic:
            return
        # Last-line protection: never send a discharge command below the
        # configured global minimum SOC, even if an earlier decision is stale.
        soc = _number(self.hass, battery["entities"].get("soc", ""))
        if (
            decision.action == "discharge"
            and soc is not None
            and soc <= float(battery["limits"]["min_soc"])
        ):
            decision = Decision(ACTION_STANDBY, reason="soc_minimum")
        power = decision.discharge_w if decision.action == "discharge" else -decision.charge_w
        if decision.action == "standby":
            power = 0
        battery_id = str(battery.get("id") or battery.get("name"))
        cache = self._mqtt_cache.setdefault(battery_id, {})
        cache.pop("fallback_profile", None)
        hysteresis = 0 if collective else int(
            self.store.data.get("command_hysteresis_w", 30)
        )
        action_changed = cache.get("action") != decision.action
        previous_power = cache.get("power")
        power_changed = previous_power is None or (
            float(power) != float(previous_power)
            and abs(float(power) - float(previous_power)) >= hysteresis
        )
        refresh_due = self._command_refresh_due(battery, cache)
        if not (action_changed or power_changed or refresh_due):
            return
        await mqtt.async_publish(
            self.hass, mode_topic, "mqtt_ctrl", qos=0, retain=False
        )
        payload = f"{float(power):.1f}"
        await mqtt.async_publish(self.hass, power_topic, payload, qos=0, retain=False)
        cache.update(
            {
                "action": decision.action,
                "power": float(power),
                "sent_monotonic": monotonic(),
            }
        )
        self._record_command(battery, decision, float(payload), "mqtt")

    def _command_refresh_due(
        self, battery: dict[str, Any], cache: dict[str, Any]
    ) -> bool:
        """Return whether an unchanged command must be refreshed."""
        interval = max(0, int(battery.get("command_refresh_s", 60)))
        last_sent = cache.get("sent_monotonic")
        return bool(
            last_sent is None
            or (interval > 0 and monotonic() - float(last_sent) >= interval)
        )

    async def _async_apply_marstek(
        self,
        battery: dict[str, Any],
        decision: Decision,
        collective: bool = False,
    ) -> None:
        entities = battery["entities"]
        values = battery["mode_values"]
        work_mode_entity = entities.get("work_mode")
        force_mode_entity = entities.get("force_mode")
        rs485_entity = entities.get("rs485_control_mode")
        battery_id = str(battery.get("id") or battery.get("name"))
        cache = self._marstek_cache.setdefault(battery_id, {})

        # Max Charge/Discharge are persistent values in the Marstek inverter.
        # Read their real HA states on every cycle and correct only a mismatch.
        # This also initializes the limits immediately when control is enabled.
        soc = _number(self.hass, entities.get("soc", ""))
        max_charge = int(battery["limits"]["max_charge_w"])
        if soc is not None:
            tier = charge_tier_limit(battery, soc)
            if tier is not None:
                # The tier limits useful charging power, not the corrective
                # command offset.  Raise the inverter ceiling by a positive
                # compensation while retaining the configured absolute max.
                charge_compensation = max(
                    0,
                    min(200, int(battery.get("charge_compensation_w", 0) or 0)),
                )
                max_charge = min(max_charge, int(tier) + charge_compensation)
        max_discharge = int(battery["limits"]["max_discharge_w"])
        limits_changed = False
        limits_changed |= await self._ensure_number_value(
            entities.get("max_charge_power"), max_charge
        )
        limits_changed |= await self._ensure_number_value(
            entities.get("max_discharge_power"), max_discharge
        )

        if decision.action == ACTION_NATIVE_SELF_CONSUMPTION:
            native_value = values.get("native_self_consumption") or values.get(
                "self_consumption"
            )
            refresh_due = self._command_refresh_due(battery, cache)
            did_send = limits_changed
            leaving_forced_control = cache.get("profile") != ACTION_NATIVE_SELF_CONSUMPTION
            # Stop forced control first, release RS485, then select Marstek's
            # native algorithm. RS485 is a maintained control mode, not a pulse.
            if force_mode_entity and (
                leaving_forced_control
                or refresh_due
                or not self._state_matches(force_mode_entity, values.get("standby"))
            ):
                await self._select(force_mode_entity, values.get("standby"))
                did_send = True
                await asyncio.sleep(0.15)
            if leaving_forced_control:
                if entities.get("charge_power"):
                    await self._number(entities["charge_power"], 0)
                if entities.get("discharge_power"):
                    await self._number(entities["discharge_power"], 0)
                did_send = True
            if rs485_entity and (
                leaving_forced_control
                or refresh_due
                or self._rs485_enabled(rs485_entity)
            ):
                await self._set_rs485(rs485_entity, False)
                did_send = True
                await asyncio.sleep(0.15)
            if work_mode_entity and (
                leaving_forced_control
                or refresh_due
                or not self._state_matches(work_mode_entity, native_value)
            ):
                await self._select(work_mode_entity, native_value)
                did_send = True
                await asyncio.sleep(0.15)
            cache["profile"] = ACTION_NATIVE_SELF_CONSUMPTION
            if did_send:
                cache["sent_monotonic"] = monotonic()
                self._record_command(
                    battery, decision, None, "marstek_entities"
                )
            return

        # Forced control is enabled by the maintained RS485 switch. User Work
        # Mode must not be changed: Force Mode and Set Power are sufficient.
        target_entity = (
            entities.get("charge_power")
            if decision.action == "charge"
            else entities.get("discharge_power")
        )
        value = decision.charge_w if decision.action == "charge" else decision.discharge_w
        force_mode_value = values.get(decision.action)
        previous_power = cache.get("power")
        hysteresis = 0 if collective else int(
            self.store.data.get("command_hysteresis_w", 30)
        )
        power_changed = bool(
            target_entity
            and decision.action in ("charge", "discharge")
            and (
                previous_power is None
                or (
                    value != previous_power
                    and abs(float(value) - float(previous_power)) >= hysteresis
                )
            )
        )
        needs_sequence = (
            cache.get("profile") != decision.action
            or (force_mode_entity and not self._state_matches(force_mode_entity, force_mode_value))
            or (rs485_entity and not self._rs485_enabled(rs485_entity))
            or self._command_refresh_due(battery, cache)
        )
        if needs_sequence:
            if (
                force_mode_entity
                and cache.get("profile") not in (None, decision.action, ACTION_STANDBY)
            ):
                await self._select(force_mode_entity, values.get("standby"))
                await asyncio.sleep(0.15)
            if rs485_entity:
                await self._set_rs485(rs485_entity, True)
                await asyncio.sleep(0.15)
            if target_entity and decision.action in ("charge", "discharge"):
                await self._number(target_entity, value)
                cache["power"] = value
                await asyncio.sleep(0.15)
            elif decision.action == ACTION_STANDBY:
                if entities.get("charge_power"):
                    await self._number(entities["charge_power"], 0)
                if entities.get("discharge_power"):
                    await self._number(entities["discharge_power"], 0)
                cache["power"] = 0
            if force_mode_entity and force_mode_value:
                await self._select(force_mode_entity, force_mode_value)
            cache["profile"] = decision.action
            cache["sent_monotonic"] = monotonic()
        elif power_changed:
            # With RS485 maintained ON, changing Set Power is immediately used.
            await self._number(target_entity, value)
            cache["power"] = value
            cache["sent_monotonic"] = monotonic()
        applied_power = value if decision.action in ("charge", "discharge") else 0
        if limits_changed and not (needs_sequence or power_changed):
            cache["sent_monotonic"] = monotonic()
        if needs_sequence or power_changed or limits_changed:
            self._record_command(
                battery, decision, float(applied_power), "marstek_entities"
            )

    def _state(self, entity_id: str) -> str | None:
        state = self.hass.states.get(entity_id)
        return state.state if state is not None else None

    def _state_matches(self, entity_id: str, expected: str | None) -> bool:
        current = self._state(entity_id)
        if current is None or expected is None:
            return False
        normalize = lambda value: "".join(character for character in value.casefold() if character.isalnum())
        return normalize(current) == normalize(expected)

    async def _select(self, entity_id: str, option: str | None) -> bool:
        if not entity_id or not option:
            return False
        state = self.hass.states.get(entity_id)
        available = state.attributes.get("options", []) if state else []
        resolved = option
        if isinstance(available, list) and available:
            normalize = lambda value: "".join(
                character for character in str(value).casefold()
                if character.isalnum()
            )
            expected = normalize(option)
            resolved = next(
                (candidate for candidate in available if normalize(candidate) == expected),
                None,
            )
            if resolved is None:
                aliases = {
                    "selfconsumption": {"antifeed", "selfuse"},
                    "aioptimization": {"ai", "aioptimization"},
                }
                accepted = aliases.get(expected, set())
                resolved = next(
                    (candidate for candidate in available if normalize(candidate) in accepted),
                    None,
                )
            if resolved is None:
                _LOGGER.error(
                    "Invalid option %r for %s; available options: %s",
                    option,
                    entity_id,
                    available,
                )
                raise ValueError(
                    f"Invalid option {option!r} for {entity_id}; "
                    f"available options: {available}"
                )
        await self.hass.services.async_call(
            "select",
            "select_option",
            {"entity_id": entity_id, "option": resolved},
            blocking=True,
        )
        return True

    async def _number(self, entity_id: str, value: float) -> None:
        await self.hass.services.async_call(
            "number",
            "set_value",
            {"entity_id": entity_id, "value": value},
            blocking=True,
        )

    async def _ensure_number_value(
        self, entity_id: str | None, expected: float, tolerance: float = 0.1
    ) -> bool:
        """Set a numeric entity only when its real state differs."""
        if not entity_id:
            return False
        current = _number(self.hass, entity_id)
        # An unavailable/unknown entity cannot be verified safely. Do not
        # repeatedly write blindly; retry the comparison on the next cycle.
        if current is None:
            return False
        if abs(current - float(expected)) <= tolerance:
            return False
        await self._number(entity_id, expected)
        return True

    def _rs485_enabled(self, entity_id: str) -> bool:
        """Return the maintained Marstek RS485 control state."""
        value = str(self._state(entity_id) or "").casefold()
        return value in ("1", "on", "true", "enabled")

    async def _set_rs485(self, entity_id: str, enabled: bool) -> None:
        """Enable or release the maintained Marstek RS485 control mode."""
        domain = entity_id.partition(".")[0]
        if domain in ("switch", "input_boolean"):
            await self.hass.services.async_call(
                domain,
                "turn_on" if enabled else "turn_off",
                {"entity_id": entity_id},
                blocking=True,
            )
        elif domain in ("number", "input_number"):
            await self.hass.services.async_call(
                domain,
                "set_value",
                {"entity_id": entity_id, "value": 1 if enabled else 0},
                blocking=True,
            )
        else:
            await self.hass.services.async_call(
                domain,
                "select_option",
                {"entity_id": entity_id, "option": "1" if enabled else "0"},
                blocking=True,
            )

    async def _async_apply_disabled_marstek(
        self, battery: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Apply the explicitly selected Marstek fallback once."""
        entities = battery["entities"]
        values = battery["mode_values"]
        rs485_entity = entities.get("rs485_control_mode")
        force_mode_entity = entities.get("force_mode")
        work_mode_entity = entities.get("work_mode")
        battery_id = str(battery.get("id") or battery.get("name"))
        cache = self._marstek_cache.setdefault(battery_id, {})
        behavior = battery.get("disabled_behavior", "standby")
        profile = f"disabled_{behavior}"
        if cache.get("profile") == profile:
            return None
        # Lock before writing to the battery. A bookkeeping error after a
        # successful command must never repeat the fallback every second.
        cache.clear()
        cache["profile"] = profile

        if behavior in (
            ACTION_NATIVE_SELF_CONSUMPTION,
            "manual",
            "ai_optimization",
        ):
            if force_mode_entity:
                await self._select(force_mode_entity, values.get("standby"))
                await asyncio.sleep(0.15)
            if entities.get("charge_power"):
                await self._number(entities["charge_power"], 0)
            if entities.get("discharge_power"):
                await self._number(entities["discharge_power"], 0)
            if rs485_entity:
                await self._set_rs485(rs485_entity, False)
                await asyncio.sleep(0.15)
            if entities.get("max_charge_power"):
                await self._number(
                    entities["max_charge_power"],
                    int(battery["limits"]["max_charge_w"]),
                )
            if entities.get("max_discharge_power"):
                await self._number(
                    entities["max_discharge_power"],
                    int(battery["limits"]["max_discharge_w"]),
                )
            if work_mode_entity:
                if behavior == "manual":
                    work_mode_value = values.get("manual")
                elif behavior == "ai_optimization":
                    work_mode_value = values.get("ai_optimization") or "AI Optimization"
                else:
                    work_mode_value = (
                        values.get("native_self_consumption")
                        or values.get("self_consumption")
                    )
                await self._select(work_mode_entity, work_mode_value)
            command_action = behavior
            command_power = None
        else:
            if entities.get("charge_power"):
                await self._number(entities["charge_power"], 0)
            if entities.get("discharge_power"):
                await self._number(entities["discharge_power"], 0)
            if rs485_entity:
                await self._set_rs485(rs485_entity, True)
                await asyncio.sleep(0.15)
            if force_mode_entity:
                await self._select(force_mode_entity, values.get("standby"))
            command_action = ACTION_STANDBY
            command_power = 0.0

        return {
            "command_action": command_action,
            "command_power_w": command_power,
            "command_transport": "marstek_entities",
            "command_sent_at": dt_util.now().isoformat(),
        }

    async def _async_apply_disabled_msa2(
        self, battery: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Apply the selected MS-A2 fallback after explicit deactivation."""
        mode_topic = battery["mqtt"].get("mode_topic")
        power_topic = battery["mqtt"].get("power_topic")
        if not mode_topic:
            return None
        behavior = battery.get("disabled_behavior", "standby")
        battery_id = str(battery.get("id") or battery.get("name"))
        cache = self._mqtt_cache.setdefault(battery_id, {})
        profile = f"disabled_{behavior}"
        if cache.get("fallback_profile") == profile:
            return None
        if behavior == ACTION_NATIVE_SELF_CONSUMPTION:
            # `general` releases mqtt_ctrl and restores Hoymiles' own EMS.
            await mqtt.async_publish(
                self.hass, mode_topic, "general", qos=0, retain=False
            )
            command_action = ACTION_NATIVE_SELF_CONSUMPTION
            command_power = None
            command_mqtt_mode = "general"
        elif behavior == "native_schedule":
            await mqtt.async_publish(
                self.hass, mode_topic, "tou_plan", qos=0, retain=False
            )
            command_action = "native_schedule"
            command_power = None
            command_mqtt_mode = "tou_plan"
        else:
            if not power_topic:
                return None
            await mqtt.async_publish(
                self.hass, mode_topic, "mqtt_ctrl", qos=0, retain=False
            )
            await mqtt.async_publish(
                self.hass, power_topic, "0.0", qos=0, retain=False
            )
            command_action = ACTION_STANDBY
            command_power = 0.0
            command_mqtt_mode = "mqtt_ctrl"
        cache.update(
            {
                "action": command_action,
                "power": command_power,
                "sent_monotonic": monotonic(),
                "fallback_profile": profile,
            }
        )
        return {
            "command_action": command_action,
            "command_power_w": command_power,
            "command_transport": "mqtt",
            "command_mqtt_mode": command_mqtt_mode,
            "command_sent_at": dt_util.now().isoformat(),
        }
