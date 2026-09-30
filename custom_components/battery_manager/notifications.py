"""Opt-in mobile notifications, durable episodes and per-target quiet hours."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
import logging
import math
from pathlib import Path
from time import time

from homeassistant.components import mqtt
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .notification_rules import CATALOG, RULES, in_window, threshold_for

_LOGGER = logging.getLogger(__name__)


def read_number(hass, entity_id):
    state = hass.states.get(entity_id) if entity_id else None
    try:
        value = float(state.state) if state else None
        return value if value is not None and math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


class NotificationManager:
    def __init__(self, hass, store, journal):
        self.hass, self.store, self.journal = hass, store, journal
        self._storage = Store(hass, 1, "battery_manager.notifications_state")
        self.data = {"episodes": {}, "history": {}}
        self._busy = False
        self._labels = {}
        self._last_flush = 0.0

    async def async_load(self):
        self.data = await self._storage.async_load() or self.data
        def labels():
            root = Path(__file__).parent / "frontend" / "translations"
            return {lang: json.loads((root / f"{lang}.json").read_text()) for lang in ("fr", "en", "es")}
        self._labels = await self.hass.async_add_executor_job(labels)

    async def async_close(self):
        await self._storage.async_save(self.data)
        await self.journal.async_flush()

    def title(self, key):
        language = self.store.data.get("notifications", {}).get("language", "fr")
        labels = self._labels.get(language, self._labels.get("fr", {})).get("notifications", {})
        return labels.get("rules", {}).get(key, {}).get("title", key)

    def translated_reason(self, key):
        language = self.store.data.get("notifications", {}).get("language", "fr")
        return self._labels.get(language, self._labels.get("fr", {})).get("reasons", {}).get(key, key)

    def profile_name(self, profile_id):
        if not profile_id:
            return "—"
        for profile in self.store.data.get("schedule_profiles", []):
            if profile.get("id") == profile_id:
                return profile.get("name") or profile_id
        return profile_id

    def note_command(self, battery, action, power, reason=""):
        key = str(battery.get("id") or battery.get("name"))
        old = self.data["history"].setdefault(key, {})
        command = [action, power]
        if old.get("logged_command") == command:
            return
        old["logged_command"] = command
        grid = read_number(self.hass, self.store.data.get("grid_power_entity", ""))
        if grid is not None and self.store.data.get("grid_power_inverted"):
            grid = -grid
        soc = read_number(self.hass, battery.get("entities", {}).get("soc", ""))
        mode = {"charge": "charge", "discharge": "décharge", "standby": "veille", "native_self_consumption": "autoconsommation native", "self_consumption": "autoconsommation collective", "default_mode": "retour au mode par défaut"}.get(action, action)
        values = []
        if soc is not None:
            values.append(f"SOC {soc:g}%")
        if grid is not None:
            values.append(f"{'Conso' if grid >= 0 else 'Injection'} {abs(grid):.0f}W")
        if reason:
            values.append(f"Motif : {reason}")
        content = f"Consigne de {mode}" + (f" {abs(power):g}W" if power is not None else "")
        if values:
            content += " (" + ", ".join(values) + ")"
        self.journal.add("commands", f"Consigne sur {battery['name']}", content + " — commande envoyée", key)

    async def async_test(self, target, rule_id=None):
        # Explicit test is the only action which bypasses quiet hours/disabled.
        title = "Battery Manager"
        message = f"Test : {self.title(rule_id)}" if rule_id else "Test de notification Battery Manager"
        return await self._send(target, message, f"test_{rule_id or target['id']}", test=True)

    async def _send(self, target, message, tag, test=False):
        action = target["action"]
        try:
            if not self.hass.services.has_service("notify", action.split(".", 1)[1]):
                raise ValueError(f"Action indisponible : {action}")
            await self.hass.services.async_call("notify", action.split(".", 1)[1], {"title": "Battery Manager", "message": message, "data": {"tag": f"battery_manager_{tag}"}}, blocking=True)
        except Exception as err:
            self.journal.add("notifications", "Échec de notification", f"{target['name']} : {message} — {err}")
            _LOGGER.warning("Battery Manager notification failed for %s: %s", action, err)
            return False
        self.journal.add("notifications", "Notification de test" if test else "Notification envoyée", f"{target['name']} : {message} — action Home Assistant exécutée")
        return True

    def _condition(self, key, b, rule, snapshot, history, episode, status):
        spec = RULES[key]
        threshold = threshold_for(spec, rule, b)
        soc, power, temperature = snapshot["soc"], snapshot["power"], snapshot["temperature"]
        hysteresis = 2 if spec["unit"] in ("%", "°C") else 10 if spec["unit"] == "W" else 0
        if key in ("soc_low", "soc_high", "full", "temperature_high", "temperature_low", "charge_overpower", "discharge_overpower"):
            value = temperature if key.startswith("temperature") else power if "overpower" in key else soc
            if value is None:
                return None, "Mesure indisponible"
            if key == "discharge_overpower":
                value = -value
            low = key in ("soc_low", "temperature_low")
            adjusted = threshold + hysteresis if low and episode.get("active") else threshold - hysteresis if not low and episode.get("active") else threshold
            identity = str(b.get("id") or b["name"])
            linked = rule["batteries"].get(identity, {}).get("threshold") is None
            if linked and episode.get("active"):
                if key == "soc_low":
                    adjusted = max(threshold, float(b.get("limits", {}).get("min_soc_resume", threshold + 2)))
                elif key in ("soc_high", "full"):
                    adjusted = min(threshold, float(b.get("limits", {}).get("max_soc_resume", threshold - 2)))
            truth = value < adjusted if low else value >= adjusted if key == "full" else value > adjusted
            return truth, f"{'Température' if key.startswith('temperature') else 'Puissance' if 'overpower' in key else 'SOC'} {value:g}{spec['unit']} ; seuil {threshold:g}{spec['unit']}"
        if key == "soc_gap":
            selected = [read_number(self.hass, x["entities"].get("soc", "")) for x in self.store.data.get("batteries", []) if rule["batteries"].get(str(x.get("id") or x["name"]), {}).get("enabled", True)]
            selected = [x for x in selected if x is not None]
            gap = max(abs(soc - other) for other in selected) if soc is not None and len(selected) >= 2 else None
            return (gap > threshold - (2 if episode.get("active") else 0) if gap is not None else None), f"Écart SOC {gap:g}% ; seuil {threshold:g}%" if gap is not None else "Deux SOC disponibles sont nécessaires"
        if key == "soc_recovered":
            return snapshot.get("recovered_soc", False) and soc is not None and soc >= threshold, f"SOC {soc:g}%" if soc is not None else ""
        if key == "temperature_recovered":
            return snapshot.get("recovered_temperature", False), f"Température {temperature:g}°C" if temperature is not None else ""
        if key in ("charge_start", "discharge_start", "charge_end", "discharge_end"):
            return snapshot.get("rule_events", {}).get(key, False), f"Puissance {power:g}W" if power is not None else ""
        if key == "standby":
            return power is not None and abs(power) <= threshold, f"Puissance {power:g}W" if power is not None else ""
        decision = status.get("decisions", {}).get(snapshot["id"], {})
        command = decision.get("command_action")
        target = decision.get("command_power_w")
        controlling = b.get("enabled") and b.get("adapter") != "generic" and command in ("charge", "discharge", "standby", "self_consumption", "solar_charge")
        if key == "mode_unexpected":
            if not controlling or b.get("adapter") != "marstek_entities":
                return None, "Contrôle du mode disponible pour Marstek avec retour Force Mode"
            entity = b["entities"].get("force_mode")
            actual = self.hass.states.get(entity) if entity else None
            expected = b.get("mode_values", {}).get(command if command in ("charge", "discharge") else "standby")
            normalize = lambda text: "".join(c for c in str(text).casefold() if c.isalnum())
            return (normalize(actual.state) != normalize(expected) if actual and actual.state not in ("unknown", "unavailable") and expected else None), f"Mode lu {actual.state if actual else 'indisponible'} ; mode demandé {expected}"
        if key in ("underpower", "standby_power", "command_unconfirmed"):
            if not controlling or power is None or target is None:
                return None, "Consigne et puissance mesurée nécessaires"
            expected = abs(float(target)) if command == "charge" else -abs(float(target)) if command == "discharge" else 0.0
            if key == "standby_power":
                return command == "standby" and abs(power) > threshold, f"Veille demandée ; puissance {power:g}W"
            if key == "underpower":
                return abs(expected) > 20 and (power * expected < 0 or abs(power) < abs(expected) * threshold / 100), f"Mesuré {power:g}W ; demandé {expected:g}W ; minimum {threshold:g}%"
            return abs(power - expected) > threshold, f"Mesuré {power:g}W ; demandé {expected:g}W ; tolérance {threshold:g}W"
        if key == "command_error":
            return snapshot["command_fault"], decision.get("error", "Erreur de commande")
        if key == "command_recovered":
            return snapshot.get("recovered_command", False), "Les commandes sont de nouveau envoyées sans erreur"
        if key in ("program_start", "program_end", "automatic_mode"):
            event = snapshot.get("program_event", {})
            scheduled = b.get("enabled") and b.get("control_mode") == "schedule"
            valid = bool(event) and scheduled
            if key == "program_end":
                valid = valid and event.get("previous") is not None
            if key == "automatic_mode":
                valid = valid and event.get("previous") is not None and event.get("previous") != event.get("current")
            return valid, f"{event.get('previous', '—')} → {event.get('current', '—')} ; profil {status.get('effective_profile')}"
        if key == "program_blocked":
            reason = decision.get("reason", "")
            return reason in ("soc_minimum", "soc_maximum", "soc_unavailable", "grid_sensor_unavailable", "power_sensor_unavailable", "rs485_control_missing", "command_error"), f"Programme non appliqué : {reason}"
        if key == "battery_unavailable":
            return snapshot["configured"] and not snapshot["available"], "SOC et puissance indisponibles"
        if key == "battery_recovered":
            return snapshot.get("recovered_available", False), "Mesures de la batterie rétablies"
        if key == "sensor_unavailable":
            return bool(snapshot["missing"]), "Mesures indisponibles : " + ", ".join(snapshot["missing"])
        if key == "sensor_stale":
            stale = []
            for role in ("soc", "power", "temperature"):
                entity = b["entities"].get(role)
                state = self.hass.states.get(entity) if entity else None
                # last_reported advances on identical values: a stable SOC is
                # not an offline battery. No fallback to last_changed.
                reported = getattr(state, "last_reported", None)
                if reported and (dt_util.utcnow() - reported).total_seconds() > threshold * 60:
                    stale.append(role)
            return bool(stale), "Mesures sans nouveau rapport depuis " + f"{threshold:g} min : " + ", ".join(stale)
        if key == "connection_lost":
            return (not snapshot["connected"] if snapshot["connected"] is not None else None), "Connexion au broker MQTT Home Assistant perdue (ne confirme pas la liaison propre à la batterie)"
        if key == "connection_recovered":
            return snapshot.get("recovered_connected", False), "Connexion au broker MQTT Home Assistant rétablie"
        return False, ""

    def _snapshot(self, b, rule_config, status, previous):
        key = str(b.get("id") or b["name"])
        e = b.get("entities", {})
        snapshot = {"id": key, **{role: read_number(self.hass, e.get(role, "")) for role in ("soc", "power", "temperature")}}
        if snapshot["power"] is not None and b.get("power_inverted"):
            snapshot["power"] = -snapshot["power"]
        snapshot["available"] = snapshot["soc"] is not None or snapshot["power"] is not None
        snapshot["configured"] = bool(e.get("soc") or e.get("power"))
        snapshot["missing"] = [role for role in ("soc", "power", "temperature") if e.get(role) and snapshot[role] is None]
        power = snapshot["power"]
        snapshot["phase"] = None if power is None else "charge" if power > 20 else "discharge" if power < -20 else "standby"
        snapshot["phase_event"] = previous.get("phase_event")
        for phase in ("charge", "discharge"):
            snapshot[f"ended_{phase}"] = previous.get(f"ended_{phase}", False)
        if snapshot["phase"] is not None and previous.get("phase") is not None and snapshot["phase"] != previous["phase"]:
            snapshot["phase_event"] = snapshot["phase"]
            for phase in ("charge", "discharge"):
                snapshot[f"ended_{phase}"] = previous["phase"] == phase
        elif snapshot["phase"] in ("charge", "discharge"):
            snapshot[f"ended_{snapshot['phase']}"] = False
        snapshot["rule_phases"] = {}
        snapshot["rule_events"] = {}
        for event in ("charge_start", "discharge_start", "charge_end", "discharge_end"):
            value = threshold_for(RULES[event], rule_config[event], b)
            charging = power is not None and (power > value if event.startswith("charge") else power < -value)
            observed = None if power is None else charging
            before = previous.get("rule_phases", {}).get(event)
            snapshot["rule_phases"][event] = observed
            wanted = not charging if event.endswith("end") else charging
            trigger = (before is True and not charging) if event.endswith("end") else (before is False and charging)
            snapshot["rule_events"][event] = observed is not None and wanted and (trigger or previous.get("rule_events", {}).get(event, False))
        d = status.get("decisions", {}).get(key, {})
        reported_error = d.get("reason") == "command_error"
        failure = previous.get("command_failure_stamp", 0)
        if reported_error:
            failure = time()
        sent = dt_util.parse_datetime(d.get("command_sent_at", "")) if d.get("command_sent_at") else None
        snapshot["command_failure_stamp"] = failure
        snapshot["command_fault"] = reported_error or (previous.get("command_fault", False) and (sent is None or sent.timestamp() <= failure))
        snapshot["connected"] = mqtt.is_connected(self.hass) if b.get("adapter") == "hoymiles_msa2" else None
        snapshot["low_soc"] = snapshot["soc"] is not None and snapshot["soc"] < threshold_for(RULES["soc_low"], rule_config["soc_low"], b)
        high = threshold_for(RULES["temperature_high"], rule_config["temperature_high"], b)
        low = threshold_for(RULES["temperature_low"], rule_config["temperature_low"], b)
        snapshot["temperature_fault"] = snapshot["temperature"] is not None and (snapshot["temperature"] > high or snapshot["temperature"] < low)
        for field, recovery, bad in (("low_soc", "soc", True), ("temperature_fault", "temperature", True), ("command_fault", "command", True), ("available", "available", False), ("connected", "connected", False)):
            flag = f"recovered_{recovery}"
            snapshot[flag] = previous.get(flag, False)
            if snapshot[field] == bad:
                snapshot[flag] = False
            elif previous.get(field) == bad and snapshot[field] is not None:
                snapshot[flag] = True
        # Profile / slot content changes, rather than 15-minute boundaries
        # containing identical actions, define a program transition.
        local = dt_util.now()
        slots = b.get("schedules", {}).get(status.get("effective_profile"), [])
        slot = slots[local.weekday()][local.hour * 4 + local.minute // 15] if len(slots) == 7 else b["schedule"][local.hour * 4 + local.minute // 15]
        program = [status.get("effective_profile"), slot, b.get("control_mode")]
        snapshot["program"] = program
        snapshot["program_event"] = previous.get("program_event", {})
        if program != previous.get("program"):
            snapshot["program_event"] = {"previous": previous.get("program", [None, {}])[1].get("action") if previous.get("program") else None, "current": slot.get("action"), "token": time()}
            if b.get("enabled") and b.get("control_mode") == "schedule":
                self.journal.add("scheduler", f"Planificateur sur {b['name']}", f"Programme {snapshot['program_event']['previous'] or '—'} → {slot.get('action')} ; profil {status.get('effective_profile')}", key)
        snapshot["logged_command"] = previous.get("logged_command")
        fault_signature = (d.get("reason"), d.get("error")) if d.get("action") == "blocked" or d.get("reason") in ("soc_minimum", "soc_maximum") else None
        snapshot["fault_signature"] = fault_signature
        if fault_signature and list(fault_signature) != previous.get("fault_signature") and fault_signature != previous.get("fault_signature"):
            self.journal.add("commands", f"Commande sur {b['name']}", f"Action bloquée : {d.get('reason')}" + (f" — {d['error']}" if d.get("error") else ""), key)
        return snapshot

    async def _evaluate(self, key, identity, condition, message, rule, targets, now, fingerprint, token=None, transient=False, dispatch_condition=True):
        cache_key = f"{key}:{identity}"
        state = self.data["episodes"].setdefault(cache_key, {})
        if state.get("fingerprint") != fingerprint or (token is not None and state.get("token") != token):
            last_sent = state.get("last_sent", {})
            state.clear()
            state.update({"fingerprint": fingerprint, "token": token, "delivered": [], "last_sent": last_sent})
        if condition is None:
            if not state.get("active"):
                state["since"] = None
            return
        if not condition:
            if state.get("pending"):
                for target_id in state["pending"]:
                    self.journal.add("notifications", "Notification abandonnée", f"{message} — condition disparue avant l’ouverture du créneau ({target_id})")
            state.update({"since": None, "active": False, "delivered": [], "pending": []})
            return
        stamp = now.timestamp()
        if state.get("since") is None:
            state["since"] = stamp
        if stamp - state["since"] < rule["confirm_s"]:
            return
        state["active"] = True
        for target in targets:
            tid = target["id"]
            if not target.get("enabled") or tid not in rule["targets"] or tid in state.get("delivered", []):
                continue
            if not in_window(target, now):
                if transient:
                    state.setdefault("delivered", []).append(tid)
                    self.journal.add("notifications", "Notification ignorée", f"{target['name']} : {message} — événement hors créneau")
                if not transient and tid not in state.setdefault("pending", []):
                    state["pending"].append(tid)
                    self.journal.add("notifications", "Notification différée", f"{target['name']} : {message} — hors créneau")
                continue
            if not dispatch_condition:
                if tid in state.get("pending", []):
                    self.journal.add("notifications", "Notification abandonnée", f"{target['name']} : {message} — seuil non franchi à l’ouverture du créneau")
                    state["pending"].remove(tid)
                    state.setdefault("delivered", []).append(tid)
                continue
            if transient and stamp - state["since"] > max(60, rule["confirm_s"] + 60):
                continue
            if stamp - state.get("last_sent", {}).get(tid, 0) < rule["cooldown_s"]:
                continue
            if stamp - state.get("attempts", {}).get(tid, 0) < 300:
                continue
            state.setdefault("attempts", {})[tid] = stamp
            if await self._send(target, message, cache_key):
                state.setdefault("delivered", []).append(tid)
                state.setdefault("last_sent", {})[tid] = stamp
                state["pending"] = [t for t in state.get("pending", []) if t != tid]

    async def async_tick(self, status):
        if self._busy:
            return
        self._busy = True
        try:
            await self._async_tick(status)
        except Exception:
            _LOGGER.exception("Unable to evaluate Battery Manager notifications")
        finally:
            self._busy = False

    async def _async_tick(self, status):
        config = self.store.data["notifications"]
        rules, targets = config["rules"], config["targets"]
        now = dt_util.now()
        global_old = self.data["history"].get("_global", {})
        weather = status.get("weather", {})
        grid_configured = bool(self.store.data.get("grid_power_entity"))
        weather_configured = bool(self.store.data.get("weather", {}).get("entity_id"))
        global_new = {"grid_bad": grid_configured and read_number(self.hass, self.store.data.get("grid_power_entity")) is None, "weather_bad": weather_configured and not weather.get("available", False), "profile": weather.get("selected_profile"), "available": weather.get("available")}
        for field in ("grid", "weather"):
            recovered = f"{field}_recovered"
            global_new[recovered] = False if global_new[f"{field}_bad"] else global_old.get(recovered, False) or global_old.get(f"{field}_bad", False)
        if weather_configured and (global_new["profile"], global_new["available"]) != (global_old.get("profile"), global_old.get("available")):
            old_profile = self.profile_name(global_old.get("profile"))
            new_profile = self.profile_name(global_new["profile"])
            reason = self.translated_reason(weather.get("reason", ""))
            self.journal.add("weather", "Gestion météo", f"Profil {old_profile} → {new_profile} ; données {'disponibles' if global_new['available'] else 'indisponibles'} ; motif {reason}")
            global_new["profile_event"] = time() if global_old.get("profile") is not None and global_new["profile"] != global_old.get("profile") else global_old.get("profile_event")
        else:
            global_new["profile_event"] = global_old.get("profile_event")
        self.data["history"]["_global"] = global_new
        for spec in CATALOG:
            key, rule = spec["id"], rules[spec["id"]]
            if spec["scope"] != "global":
                continue
            value = {"grid_unavailable": global_new["grid_bad"], "grid_recovered": global_new["grid_recovered"], "weather_unavailable": global_new["weather_bad"], "weather_recovered": global_new["weather_recovered"], "weather_change": bool(global_new.get("profile_event"))}[key]
            message = f"{self.title(key)} : {global_new['profile'] or '—'}" if key.startswith("weather") else self.title(key)
            await self._evaluate(key, "global", value, message, rule, targets, now, json.dumps(rule, sort_keys=True), token=global_new.get("profile_event") if key == "weather_change" else None, transient=key == "weather_change")
        batteries = self.store.data.get("batteries", [])
        snapshots = []
        for b in batteries:
            identity = str(b.get("id") or b["name"])
            previous = self.data["history"].get(identity, {})
            snapshot = self._snapshot(b, rules, status, previous)
            snapshots.append((b, snapshot))
            for spec in CATALOG:
                key, rule = spec["id"], rules[spec["id"]]
                if spec["scope"] == "global" or key == "daily_summary":
                    continue
                selected = rule["batteries"].get(identity, {}).get("enabled", True)
                state = self.data["episodes"].get(f"{key}:{identity}", {})
                condition, detail = self._condition(key, b, rule, snapshot, previous, state, status)
                message = f"{self.title(key)} — {b['name']} : {detail}"
                token = snapshot["program_event"].get("token") if key in ("program_start", "program_end", "automatic_mode") else None
                parameters = [rule["batteries"].get(identity), threshold_for(spec, rule, b), rule["confirm_s"]]
                if key in ("underpower", "command_unconfirmed", "standby_power", "mode_unexpected"):
                    command = status.get("decisions", {}).get(identity, {})
                    parameters.append([command.get("command_action"), command.get("command_power_w")])
                fingerprint = json.dumps(parameters, sort_keys=True)
                dispatch_condition = condition
                if key in ("soc_low", "soc_high", "full", "temperature_high", "temperature_low", "charge_overpower", "discharge_overpower"):
                    dispatch_condition, _ = self._condition(key, b, rule, snapshot, previous, {}, status)
                await self._evaluate(key, identity, condition if selected else False, message, rule, targets, now, fingerprint, token=token, transient=key in ("program_start", "program_end", "automatic_mode", "charge_start", "charge_end", "discharge_start", "discharge_end", "soc_recovered", "temperature_recovered", "command_recovered", "battery_recovered", "connection_recovered"), dispatch_condition=dispatch_condition)
            snapshot["logged_command"] = self.data["history"].get(identity, {}).get("logged_command", snapshot.get("logged_command"))
            self.data["history"][identity] = snapshot
        summary = rules["daily_summary"]
        parts = []
        for b, snapshot in snapshots:
            if not summary["batteries"].get(snapshot["id"], {}).get("enabled", True):
                continue
            text = f"{b['name']} : SOC {snapshot['soc']:g}%" if snapshot["soc"] is not None else f"{b['name']} : SOC indisponible"
            for role, label in (("charged_today", "charge"), ("discharged_today", "décharge")):
                state = self.hass.states.get(b["entities"].get(role, ""))
                if state and read_number(self.hass, state.entity_id) is not None:
                    text += f" ; {label} {state.state} {state.attributes.get('unit_of_measurement', '')}"
            if snapshot["command_fault"] or not snapshot["available"]:
                text += " ; anomalie en cours"
            parts.append(text)
        await self._evaluate("daily_summary", "global", bool(parts) and now.strftime("%H:%M") >= summary.get("time", "20:00"), self.title("daily_summary") + "\n" + "\n".join(parts), summary, targets, now, "summary", token=now.date().isoformat())
        valid_ids = {str(b.get("id") or b["name"]) for b in batteries} | {"global"}
        self.data["episodes"] = {key: value for key, value in self.data["episodes"].items() if key.split(":", 1)[-1] in valid_ids}
        self.data["history"] = {key: value for key, value in self.data["history"].items() if key == "_global" or key in valid_ids}
        # One scheduled write per interval: do not keep postponing the save
        # at every 5-second control tick.
        if time() - self._last_flush >= 15:
            self._storage.async_delay_save(lambda: deepcopy(self.data), 1)
            await self.journal.async_flush()
            self._last_flush = time()
