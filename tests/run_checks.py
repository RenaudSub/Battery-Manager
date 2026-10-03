"""Run offline checks with HA boundary doubles: python3 tests/run_checks.py.

These checks exercise the real notification rules, delivery state machine,
SQLite journal and existing scheduling model. They do not emulate a live HA
installation or confirm physical battery/phone receipt.
"""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'custom_components' / 'battery_manager'
for name, path in [('custom_components', ROOT/'custom_components'), ('custom_components.battery_manager', SOURCE)]:
    mod = ModuleType(name); mod.__path__ = [str(path)]; sys.modules[name] = mod

def module(name):
    item = ModuleType(name);sys.modules[name] = item;return item

# Import only the integration's business logic with explicit HA doubles.
for name in ('homeassistant','homeassistant.components','homeassistant.helpers','homeassistant.util'):
    mod=module(name);mod.__path__=[]
mqtt=module('homeassistant.components.mqtt');mqtt.is_connected=lambda hass: True
constants=module('homeassistant.const');constants.STATE_UNKNOWN='unknown';constants.STATE_UNAVAILABLE='unavailable'
events=module('homeassistant.helpers.event');events.async_track_time_interval=lambda *args,**kwargs: (lambda:None)
storage=module('homeassistant.helpers.storage')
class FakeStore:
    def __class_getitem__(cls, _): return cls
    def __init__(self, *args): self.saved=None
    async def async_load(self): return self.saved
    async def async_save(self, data): self.saved=deepcopy(data)
    def async_delay_save(self, fn, delay): self.saved=deepcopy(fn())
storage.Store=FakeStore
core=module('homeassistant.core');core.HomeAssistant=object
clock=module('homeassistant.util.dt')
NOW=datetime(2026,9,29,6,30,tzinfo=timezone.utc)
clock.now=lambda: NOW;clock.utcnow=lambda: NOW;clock.as_local=lambda dt: dt
clock.parse_datetime=lambda value: datetime.fromisoformat(value) if value else None

from custom_components.battery_manager.activity import ActivityJournal, configuration_changes
from custom_components.battery_manager.notification_rules import CATALOG, normalize_notifications, threshold_for, RULES, in_window
from custom_components.battery_manager.notifications import NotificationManager
from custom_components.battery_manager.model import Decision, default_battery
from custom_components.battery_manager.store import BatteryManagerStore
from custom_components.battery_manager.controller import BatteryController

class FakeServices:
    def __init__(self): self.calls=[];self.fail=False
    def has_service(self, domain, action): return action.startswith('mobile_app_')
    async def async_call(self, domain, action, payload, **kwargs):
        if self.fail: raise RuntimeError('test transport failure')
        self.calls.append((domain,action,payload))
        entity_id=payload.get('entity_id') if isinstance(payload,dict) else None
        if entity_id and action in ('turn_on','turn_off') and hasattr(self,'hass'):
            self.hass.put(entity_id,'on' if action=='turn_on' else 'off')

class FakeHass:
    def __init__(self, path):
        self.config=SimpleNamespace(path=lambda *p: str(Path(path).joinpath(*p)))
        self.services=FakeServices()
        self.services.hass=self
        self.entities={}
        self.states=SimpleNamespace(get=lambda key:self.entities.get(key))
    async def async_add_executor_job(self, fn, *args): return await asyncio.to_thread(fn,*args)
    def put(self,key,value): self.entities[key]=SimpleNamespace(state=str(value),entity_id=key,attributes={},last_reported=NOW)

TARGET={'id':'phone','action':'notify.mobile_app_s23ultra2sub','name':'Mon téléphone','enabled':True,'start':'07:00','end':'22:00'}

class BackupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.hass=FakeHass(self.tmp.name)
        self.battery=default_battery();self.battery.update(id='b1',name='BAT1',adapter='marstek_entities')
        self.battery['entities'].update(backup_function='switch.backup',grid_voltage='sensor.grid_voltage')
        self.config={'batteries':[self.battery],'backup_actions':{'entity_id':'switch.cumulus','restore_on_exit':True}}
        self.controller=BatteryController(self.hass,SimpleNamespace(data=self.config));self.controller._backup_loaded=True
    async def asyncTearDown(self):self.tmp.cleanup()
    async def test_one_shot_backup_action_and_grid_recovery(self):
        self.hass.put('switch.cumulus','on');self.hass.put('switch.backup','on');self.hass.put('sensor.grid_voltage',1.6)
        await self.controller._async_update_backup_state(self.config)
        self.assertEqual(self.hass.entities['switch.cumulus'].state,'off')
        self.assertIn('b1',self.controller._backup_blocked_ids)
        calls=len(self.hass.services.calls)
        await self.controller._async_update_backup_state(self.config)
        self.assertEqual(len(self.hass.services.calls),calls)
        self.hass.put('switch.backup','off');self.hass.put('sensor.grid_voltage',235)
        with patch('custom_components.battery_manager.controller.monotonic',side_effect=[100,131]):
            await self.controller._async_update_backup_state(self.config)
            await self.controller._async_update_backup_state(self.config)
        self.assertNotIn('b1',self.controller._backup_blocked_ids)
        self.assertEqual(self.hass.entities['switch.cumulus'].state,'on')
    async def test_marstek_command_is_suppressed_while_backup_switch_is_on(self):
        self.hass.put('switch.backup','on')
        await self.controller._async_apply_marstek(self.battery,Decision('charge',charge_w=500))
        self.assertEqual(self.hass.services.calls,[])
    async def test_initially_off_action_is_never_started_on_exit(self):
        self.hass.put('switch.cumulus','off');self.hass.put('switch.backup','on');self.hass.put('sensor.grid_voltage',1.6)
        await self.controller._async_update_backup_state(self.config)
        self.hass.put('switch.backup','off');self.hass.put('sensor.grid_voltage',235)
        with patch('custom_components.battery_manager.controller.monotonic',side_effect=[100,131]):
            await self.controller._async_update_backup_state(self.config)
            await self.controller._async_update_backup_state(self.config)
        self.assertEqual(self.hass.services.calls,[])
        self.assertEqual(self.hass.entities['switch.cumulus'].state,'off')

def fixture():
    batteries=[]
    for i in range(1,4):
        b=default_battery();b['id']=f'b{i}';b['name']=f'BAT{i}'
        b['limits']['min_soc']=10+i*5
        b['entities'].update(soc=f'sensor.b{i}_soc',power=f'sensor.b{i}_power',temperature=f'sensor.b{i}_temperature')
        batteries.append(b)
    return {'batteries':batteries,'notifications':normalize_notifications({'targets':[TARGET]},batteries),'grid_power_entity':'sensor.grid','grid_power_inverted':False,'schedule_profiles':[{'id':'sunny','name':'Ensoleillé'},{'id':'cloudy','name':'Nuageux'},{'id':'rainy','name':'Pluvieux'}],'active_profile':'sunny','weather':{}}

class RuleTests(unittest.TestCase):
    def test_default_opt_in_and_linked_thresholds(self):
        config=fixture();n=config['notifications']
        self.assertTrue(all(not r['targets'] for r in n['rules'].values()))
        self.assertTrue(all(x['enabled'] for r in n['rules'].values() for x in r['batteries'].values()))
        b=config['batteries'][0];rule=n['rules']['soc_low']
        self.assertEqual(threshold_for(RULES['soc_low'],rule,b),15)
        b['limits']['min_soc']=18;self.assertEqual(threshold_for(RULES['soc_low'],rule,b),18)
        rule['batteries']['b1']['threshold']=12;self.assertEqual(threshold_for(RULES['soc_low'],rule,b),12)
        self.assertEqual(n['rules']['charge_start']['rearm_h'],14)
        self.assertEqual(n['rules']['discharge_start']['rearm_h'],14)
    def test_target_validation_and_midnight(self):
        for start,end in [('22:00','07:00'),('07:00','07:00'),('25:00','26:00')]:
            with self.assertRaises(ValueError):normalize_notifications({'targets':[{**TARGET,'start':start,'end':end}]},[])
        with self.assertRaises(ValueError):normalize_notifications({'targets':[TARGET,{**TARGET,'id':'second'}]},[])
        with self.assertRaises(ValueError):normalize_notifications({'targets':[{**TARGET,'action':'switch.turn_on'}]},[])
        self.assertFalse(in_window(TARGET,NOW.replace(hour=6)))
        self.assertTrue(in_window(TARGET,NOW.replace(hour=7)))
        self.assertFalse(in_window(TARGET,NOW.replace(hour=22)))
    def test_removed_targets_are_unassigned(self):
        config=fixture();n=config['notifications'];n['rules']['soc_low']['targets']=['phone']
        n['targets']=[];new=normalize_notifications(n,config['batteries'])
        self.assertEqual(new['rules']['soc_low']['targets'],[])
    def test_invalid_threshold_rejected(self):
        config=fixture();n=config['notifications']
        for value in (float('nan'),101,-1):
            n['rules']['soc_low']['batteries']['b1']['threshold']=value
            with self.assertRaises(ValueError):normalize_notifications(n,config['batteries'])
    def test_catalog_translation_coverage(self):
        for lang in ('fr','en','es'):
            data=json.loads((SOURCE/'frontend'/'translations'/f'{lang}.json').read_text())
            self.assertEqual(set(data['notifications']['rules']),set(RULES))
    def test_audit_planning_compact(self):
        config=fixture();changed=deepcopy(config)
        changed['batteries'][0]['limits']['min_soc']=20
        changed['batteries'][0]['schedules']['sunny'][0][0]['action']='charge'
        changes=list(configuration_changes(config,changed))
        self.assertTrue(any('15' in s and '20' in s for s in changes))
        self.assertTrue(any('planification' in s for s in changes))
        self.assertLess(len(changes),5)
    def test_mobile_navigation_and_command_panels_contract(self):
        panel=(SOURCE/'frontend'/'battery-manager-panel.js').read_text()
        self.assertIn('.profile-menu{order:1',panel)
        self.assertIn('.navigation-menu{order:2;flex-shrink:0;margin-left:auto}',panel)
        self.assertIn('.navigation-menu .actions-menu-content{right:0;left:auto',panel)
        self.assertIn('battery_manager_overview_sections',panel)
        self.assertIn('this._openCommandSections = new Set(overviewSections.commands);',panel)
        self.assertIn('this._openSetpointSections = new Set(overviewSections.setpoints);',panel)
        self.assertEqual(panel.count('<details class="command-status" data-command-device='),2)
        self.assertIn('<details class="section-divider setpoint-box" data-setpoint-device=',panel)
        self.assertNotIn('overview.sent_at',panel)

class WeatherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.hass=FakeHass(self.tmp.name)
        self.controller=BatteryController(self.hass,SimpleNamespace(data={}))
        self.weather={
            'rain_threshold_mm':0.5,'sunny_cloud_max':40,'cloud_hysteresis':10,
            'condition_map':{'sunny':'sunny','cloudy':'cloudy','rainy':'rainy','pouring':'rainy','lightning-rainy':'rainy','hail':'rainy','snowy-rainy':'rainy'},
        }
    async def asyncTearDown(self):self.tmp.cleanup()
    async def test_light_rain_uses_cloud_cover(self):
        self.weather['sunny_cloud_max']=20
        selected,reason=self.controller._classify_weather('rainy',30,0.1,self.weather)
        self.assertEqual(selected,'cloudy')
        self.assertEqual(reason,'precipitation_below_threshold')
    async def test_rain_at_threshold_selects_rainy(self):
        selected,reason=self.controller._classify_weather('rainy',10,0.5,self.weather)
        self.assertEqual(selected,'rainy')
        self.assertEqual(reason,'precipitation_threshold')
    async def test_precipitation_amount_has_priority_even_if_condition_is_cloudy(self):
        selected,reason=self.controller._classify_weather('cloudy',10,0.7,self.weather)
        self.assertEqual(selected,'rainy')
        self.assertEqual(reason,'precipitation_threshold')
    async def test_severe_condition_has_priority(self):
        selected,reason=self.controller._classify_weather('pouring',10,0.1,self.weather)
        self.assertEqual(selected,'rainy')
        self.assertEqual(reason,'severe_precipitation')
    async def test_missing_precipitation_uses_condition(self):
        selected,reason=self.controller._classify_weather('rainy',10,None,self.weather)
        self.assertEqual(selected,'rainy')
        self.assertEqual(reason,'precipitation_unavailable')
    async def test_rain_threshold_is_persisted_and_normalized(self):
        store=BatteryManagerStore(self.hass);await store.async_load({})
        self.assertEqual(store.data['weather']['rain_threshold_mm'],0.5)
        config=deepcopy(store.data);config['weather']['rain_threshold_mm']=0.8
        await store.async_save(config)
        self.assertEqual(store.data['weather']['rain_threshold_mm'],0.8)

class JournalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.hass=FakeHass(self.tmp.name)
        self.journal=ActivityJournal(self.hass,max_bytes=100000)
    async def asyncTearDown(self): self.tmp.cleanup()
    async def test_survives_restart_and_paginates(self):
        for i in range(8):self.journal.add('commands','Consigne BAT1',str(i))
        self.journal.add('users','Action','SOC 15 → 20',actor='admin')
        await self.journal.async_flush()
        reopened=ActivityJournal(self.hass)
        first=await reopened.async_read('commands',limit=3)
        second=await reopened.async_read('commands',before=first['next'],limit=3)
        self.assertEqual([e['content'] for e in first['entries']],['7','6','5'])
        self.assertEqual([e['content'] for e in second['entries']],['4','3','2'])
        filtered=await reopened.async_read('users',search='SOC')
        self.assertEqual(filtered['entries'][0]['actor'],'admin')
    async def test_actual_disk_size_is_bounded(self):
        for i in range(2000):self.journal.add('commands','BAT1',str(i)+'x'*900)
        await self.journal.async_flush()
        result=await self.journal.async_read('commands')
        self.assertLessEqual(result['bytes'],100000)
        self.assertLess(result['count'],2000)
        self.assertEqual(result['entries'][0]['content'].split('x')[0],'1999')
    async def test_retention_and_clear(self):
        self.journal._pending.append((datetime.now(timezone.utc).timestamp()-31*86400,'commands','old','expired',None,None))
        self.journal.add('commands','new','keep')
        await self.journal.async_flush()
        result=await self.journal.async_read('commands')
        self.assertEqual(len(result['entries']),1)
        await self.journal.async_clear()
        self.assertEqual((await self.journal.async_read('commands'))['count'],0)

class NotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        global NOW
        NOW=datetime(2026,9,29,6,30,tzinfo=timezone.utc)
        self.tmp=tempfile.TemporaryDirectory();self.hass=FakeHass(self.tmp.name)
        self.config=fixture();self.store=SimpleNamespace(data=self.config)
        self.journal=ActivityJournal(self.hass);self.manager=NotificationManager(self.hass,self.store,self.journal)
        await self.manager.async_load()
        for b in self.config['batteries']:
            self.hass.put(b['entities']['soc'],90);self.hass.put(b['entities']['power'],0);self.hass.put(b['entities']['temperature'],25)
        self.hass.put('sensor.grid',750)
    async def asyncTearDown(self):self.tmp.cleanup()
    def enable(self,key,confirm=0):
        rule=self.config['notifications']['rules'][key];rule['targets']=['phone'];rule['confirm_s']=confirm;rule['rearm_h']=0
        return rule
    async def tick(self,hour=None,minutes=0):
        global NOW
        if hour is not None: NOW=NOW.replace(hour=hour,minute=minutes)
        await self.manager._async_tick({'decisions':{},'effective_profile':'sunny','weather':{}})
    async def test_zero_recipients_zero_delivery(self):
        self.hass.put('sensor.b1_soc',5);await self.tick(10)
        self.assertEqual(self.hass.services.calls,[])
    async def test_charge_start_rearm_blocks_repeated_transition(self):
        self.enable('charge_start')['rearm_h']=14
        await self.tick(8,0)
        self.hass.put('sensor.b1_power',300);await self.tick(8,1)
        self.hass.put('sensor.b1_power',0);await self.tick(8,5)
        self.hass.put('sensor.b1_power',350);await self.tick(8,10)
        self.assertEqual(len(self.hass.services.calls),1)
        rows=await self.journal.async_read('notifications')
        self.assertTrue(any('inhibée' in e['kind'] for e in rows['entries']))
    async def test_deferred_then_disappears(self):
        self.enable('soc_low');self.hass.put('sensor.b1_soc',5);await self.tick()
        self.assertFalse(self.hass.services.calls)
        self.hass.put('sensor.b1_soc',18);await self.tick(7)
        self.assertFalse(self.hass.services.calls)
        rows=await self.journal.async_read('notifications')
        self.assertTrue(any('abandonnée' in e['kind'] for e in rows['entries']))
    async def test_deferred_inside_hysteresis_does_not_send(self):
        self.enable('soc_low');self.hass.put('sensor.b1_soc',14);await self.tick()
        self.hass.put('sensor.b1_soc',16);await self.tick(7)
        self.assertFalse(self.hass.services.calls)
    async def test_still_low_sends_once_and_survives_restart(self):
        self.enable('soc_low');self.hass.put('sensor.b1_soc',5);await self.tick()
        await self.tick(7);await self.tick(8)
        self.assertEqual(len(self.hass.services.calls),1)
        state=json.loads(json.dumps(self.manager.data))
        self.manager=NotificationManager(self.hass,self.store,self.journal);await self.manager.async_load();self.manager.data=state
        await self.tick(9);self.assertEqual(len(self.hass.services.calls),1)
        self.hass.put('sensor.b1_soc',20);await self.tick(10)
        self.hass.put('sensor.b1_soc',5);await self.tick(11)
        self.assertEqual(len(self.hass.services.calls),2)
    async def test_target_windows_independent(self):
        self.config['notifications']['targets'].append({**TARGET,'id':'tablet','action':'notify.mobile_app_tablet','name':'Tablette','start':'09:00'})
        rule=self.enable('soc_low');rule['targets'].append('tablet')
        self.hass.put('sensor.b1_soc',5);await self.tick(7)
        self.assertEqual(len(self.hass.services.calls),1)
        await self.tick(9);self.assertEqual(len(self.hass.services.calls),2)
    async def test_disabled_target(self):
        self.enable('soc_low');self.config['notifications']['targets'][0]['enabled']=False
        self.hass.put('sensor.b1_soc',5);await self.tick(10)
        self.assertEqual(self.hass.services.calls,[])
    async def test_confirmation(self):
        global NOW
        self.enable('soc_low',120);self.hass.put('sensor.b1_soc',5);await self.tick(10)
        NOW+=timedelta(seconds=119);await self.tick();self.assertFalse(self.hass.services.calls)
        NOW+=timedelta(seconds=1);await self.tick();self.assertEqual(len(self.hass.services.calls),1)
    async def test_failure_isolated_and_backoff(self):
        self.enable('soc_low');self.hass.services.fail=True;self.hass.put('sensor.b1_soc',5)
        await self.tick(10);self.hass.services.fail=False;await self.tick(10,1)
        self.assertFalse(self.hass.services.calls)
        await self.tick(10,5);self.assertEqual(len(self.hass.services.calls),1)
    async def test_explicit_test_bypasses_quiet_hours(self):
        await self.manager.async_test({**TARGET,'enabled':False})
        self.assertEqual(len(self.hass.services.calls),1)
    async def test_charge_power_convention_marstek(self):
        self.enable('command_unconfirmed');b=self.config['batteries'][0];b.update(enabled=True,adapter='marstek_entities')
        self.hass.put('sensor.b1_power',500)
        status={'decisions':{'b1':{'command_action':'charge','command_power_w':500}},'effective_profile':'sunny','weather':{}}
        global NOW;NOW=NOW.replace(hour=10)
        await self.manager._async_tick(status);self.assertFalse(self.hass.services.calls)
        self.hass.put('sensor.b1_power',-500);await self.manager._async_tick(status)
        self.assertEqual(len(self.hass.services.calls),1)
    async def test_mqtt_charge_convention(self):
        self.enable('command_unconfirmed');b=self.config['batteries'][0];b.update(enabled=True,adapter='hoymiles_msa2')
        self.hass.put('sensor.b1_power',500)
        global NOW;NOW=NOW.replace(hour=10)
        await self.manager._async_tick({'decisions':{'b1':{'command_action':'charge','command_power_w':-500}},'effective_profile':'sunny','weather':{}})
        self.assertFalse(self.hass.services.calls)
    async def test_battery_unconfigured_not_offline(self):
        self.enable('battery_unavailable');self.config['batteries'][0]['entities'].update(soc='',power='')
        await self.tick(10);self.assertFalse(self.hass.services.calls)
    async def test_charge_transition_custom_threshold(self):
        rule=self.enable('charge_start');rule['batteries']['b1']['threshold']=5
        await self.tick(10);self.hass.put('sensor.b1_power',8);await self.tick(10,1)
        self.assertEqual(len(self.hass.services.calls),1)
    async def test_daily_summary_once_per_target_per_day(self):
        self.enable('daily_summary');await self.tick(20);await self.tick(21)
        self.assertEqual(len(self.hass.services.calls),1)
        global NOW;NOW+=timedelta(days=1);await self.tick(20)
        self.assertEqual(len(self.hass.services.calls),2)
    async def test_command_log_deduplicates_refresh(self):
        b=self.config['batteries'][0]
        self.manager.note_command(b,'discharge',376,'programme');self.manager.note_command(b,'discharge',376,'programme')
        self.manager.note_command(b,'discharge',377,'programme')
        rows=await self.journal.async_read('commands')
        self.assertEqual(len(rows['entries']),2)
    async def test_transient_program_event_outside_window_not_replayed(self):
        rule=self.enable('program_start');b=self.config['batteries'][0]
        b.update(enabled=True,control_mode='schedule')
        await self.tick()
        self.assertFalse(self.hass.services.calls)
        await self.tick(7)
        self.assertFalse(self.hass.services.calls)
    async def test_missing_measure_restarts_unconfirmed_duration(self):
        global NOW
        self.enable('soc_low',120);self.hass.put('sensor.b1_soc',5);await self.tick(10)
        NOW+=timedelta(seconds=100);self.hass.put('sensor.b1_soc','unavailable');await self.tick()
        NOW+=timedelta(seconds=100);self.hass.put('sensor.b1_soc',5);await self.tick()
        self.assertFalse(self.hass.services.calls)
        NOW+=timedelta(seconds=120);await self.tick();self.assertEqual(len(self.hass.services.calls),1)
    async def test_soc_gap_respects_each_battery_threshold(self):
        rule=self.enable('soc_gap');rule['batteries']['b1']['threshold']=30
        rule['batteries']['b2']['threshold']=10;rule['batteries']['b3']['enabled']=False
        self.hass.put('sensor.b1_soc',50);self.hass.put('sensor.b2_soc',70)
        await self.tick(10)
        self.assertEqual(len(self.hass.services.calls),1)
        self.assertIn('BAT2',self.hass.services.calls[0][2]['message'])
    async def test_matching_force_mode_ignores_case(self):
        self.enable('mode_unexpected');b=self.config['batteries'][0]
        b.update(enabled=True,adapter='marstek_entities');b['entities']['force_mode']='select.force'
        self.hass.put('select.force','cHaRgE')
        global NOW;NOW=NOW.replace(hour=10)
        await self.manager._async_tick({'decisions':{'b1':{'command_action':'charge','command_power_w':500}},'effective_profile':'sunny','weather':{}})
        self.assertFalse(self.hass.services.calls)
    async def test_journal_audits_target_creation(self):
        old=fixture();old['notifications']['targets']=[]
        changes=list(configuration_changes(old,fixture()))
        self.assertTrue(any('Création de la cible Mon téléphone' in change for change in changes))

    async def test_store_preserves_notifications_on_other_saves(self):
        store=BatteryManagerStore(self.hass);await store.async_load({})
        config=deepcopy(self.config);config['notifications']['rules']['soc_low']['targets']=['phone']
        await store.async_save(config)
        await store.async_save(deepcopy(store.data))
        self.assertEqual(store.data['notifications']['rules']['soc_low']['targets'],['phone'])

# Existing model checks remain unchanged and run in the same isolated harness.
spec=importlib.util.spec_from_file_location('original_model_checks',ROOT/'tests'/'test_model.py')
original=importlib.util.module_from_spec(spec);spec.loader.exec_module(original)
def load_tests(loader, tests, pattern):
    for name in dir(original):
        if name.startswith('test_'):tests.addTest(unittest.FunctionTestCase(getattr(original,name)))
    return tests

if __name__=='__main__':
    if '--fixture' in sys.argv:
        print(json.dumps({'config':fixture(),'status':{'decisions':{},'effective_profile':'sunny'},'notification_catalog':CATALOG,'notification_actions':['notify.mobile_app_s23ultra2sub','notify.mobile_app_tablet']}))
    else:unittest.main(verbosity=2)
