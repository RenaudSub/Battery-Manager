const ACTIONS = {
  charge: { color: "#1976d2" }, discharge: { color: "#ef6c00" },
  self_consumption: { color: "#2e7d32" }, solar_charge: { color: "#f9a825" },
  native_self_consumption: { color: "#8e24aa" },
  default_mode: { color: "#ffffff" },
  standby: { color: "#78909c" },
};
const PANEL_VERSION = "0.5.5";
const ASSET_BASE = "/battery_manager/frontend/assets/";
const BATTERY_MODELS = {
  generic: [{id:"generic", label:""}],
  marstek_entities: [{id:"venus_e_3", label:"Venus E 3.0", image:"marstek-venus-e3.svg"}, {id:"generic", label:""}],
  hoymiles_msa2: [{id:"ms_a2", label:"MS-A2", image:"hoymiles-ms-a2.jpg"}, {id:"generic", label:""}],
};
const SUPPORTED_LANGUAGES = ["fr", "en", "es"];

const emptySlot = () => ({ action: "standby", charge_w: 0, discharge_w: 0, min_soc: null, max_soc: null });
const emptyWeek = () => Array.from({length:7},()=>Array.from({ length:96 }, emptySlot));
const defaultBattery = () => ({
  id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
  name: "Nouvelle batterie",
  adapter: "generic",
  model: "generic",
  enabled: false,
  operation_mode: "disabled",
  control_mode: "disabled",
  disabled_behavior: "standby",
  command_refresh_s: 60,
  capacity_kwh: 0,
  charge_compensation_w: 0,
  discharge_compensation_w: 0,
  power_inverted: false,
  grid_loss_return_default: false,
  grid_return_resume: false,
  source_device_id: "",
  entities: {
    power: "", soc: "", state: "", temperature: "", grid_voltage: "", backup_function: "", ac_current: "",
    dc_voltage: "", dc_current: "", dc_power: "", total_capacity: "",
    charged_today: "", discharged_today: "", cycle_count: "", cycle_count_calc: "",
    max_cell_voltage: "", min_cell_voltage: "", work_mode: "",
    force_mode: "", rs485_control_mode: "",
    charge_power: "", discharge_power: "", max_charge_power: "",
    max_discharge_power: "",
  },
  mqtt: { mode_topic: "", power_topic: "" },
  mode_values: {
    manual: "Manual", charge: "Charge", discharge: "Discharge",
    self_consumption: "Self Consumption", ai_optimization: "AI Optimization", standby: "Standby",
    native_self_consumption: "Self Consumption",
  },
  limits: {
    min_soc: 10, min_soc_resume: 11, max_soc: 98, max_soc_resume: 97,
    max_charge_w: 2500, max_discharge_w: 800,
  },
  charge_tiers: [
    { from_soc: 0, to_soc: 85, max_charge_w: 2500 },
    { from_soc: 85, to_soc: 92, max_charge_w: 2000 },
    { from_soc: 92, to_soc: 95, max_charge_w: 1200 },
    { from_soc: 95, to_soc: 100, max_charge_w: 700 },
  ],
  schedule: Array.from({ length: 96 }, emptySlot),
  schedules: { sunny:emptyWeek(), cloudy:emptyWeek(), rainy:emptyWeek() },
});

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

class BatteryManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._loaded = false;
    this._tab = "overview";
    this._selected = 0;
    this._config = null;
    this._status = {};
    this._marstekDevices = [];
    this._openDiagnostics = new Set();
    const overviewSections = this._storedOverviewSections();
    this._openCommandSections = new Set(overviewSections.commands);
    this._openSetpointSections = new Set(overviewSections.setpoints);
    this._languageOverride = this._storedLanguage();
    this._translations = {};
    this._fallbackTranslations = {};
    this._loadedLocale = null;
    this._rangeEditor = { start:"00:00", end:"00:00", action:"charge", charge_w:null, discharge_w:null, min_soc:null, max_soc:null };
    this._editingProfile = "sunny";
    this._selectedDays = [0];
    this._notificationCatalog = [];
    this._notificationActions = [];
    this._manageTargets = false;
    this._targetDraft = {id:"",name:"",action:"",enabled:true,start:"07:00",end:"22:00"};
    this._journalCategory = "commands";
    this._journal = {entries:[]};
    this._journalSearch = "";
    this._journalSince = "";
    this._journalUntil = "";
  }

  set hass(value) {
    const themeChanged = this._hass?.themes?.darkMode !== value?.themes?.darkMode;
    this._hass = value;
    if (!this._loaded) this._load();
    else if (this._languageOverride === "auto" && this._loadedLocale !== this._locale()) {
      this._loadTranslations().then(() => this._render());
    } else if (this._tab === "overview" && !this._overviewControlHasFocus()) this._render();
    else if (this._tab === "batteries") {
      if(themeChanged) this._render();
      else {
        const meter=this.shadowRoot.querySelector(".grid-settings .section-art");
        if(meter) meter.innerHTML=this._meterGraphic();
        const tiers=this.shadowRoot.querySelector(".tier-art");
        if(tiers && this._config.batteries[this._selected]) tiers.innerHTML=this._tierGraphic(this._config.batteries[this._selected]);
      }
    }
  }

  set panel(value) { this._panel = value; }

  connectedCallback() {
    this._refreshTimer = setInterval(() => this._refreshStatus(), 10000);
  }

  disconnectedCallback() {
    clearInterval(this._refreshTimer);
    this._networkResizeObserver?.disconnect();
  }

  async _refreshStatus() {
    if (!this._hass || !this._loaded || this._tab !== "overview") return;
    try {
      const result = await this._hass.callWS({ type: "battery_manager/config" });
      this._status = result.status || {};
      if (!this._overviewControlHasFocus()) this._render();
    } catch (_) { /* A temporary disconnect is shown by entity availability. */ }
  }

  _overviewControlHasFocus() {
    const active = this.shadowRoot?.activeElement;
    return Boolean(active?.matches?.("[data-quick-mode]") || this.shadowRoot?.querySelector("details.profile-menu[open], details.navigation-menu[open]"));
  }

  async _load() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      const result = await this._hass.callWS({ type: "battery_manager/config" });
      this._config = result.config;
      this._status = result.status || {};
      this._marstekDevices = result.marstek_devices || [];
      this._notificationCatalog = result.notification_catalog || [];
      this._notificationActions = result.notification_actions || [];
      this._editingProfile = this._config.schedule_profiles?.some(p=>p.id===this._editingProfile) ? this._editingProfile : (this._config.schedule_profiles?.[0]?.id || "sunny");
      for (const battery of this._config.batteries || []) {
        if (battery.adapter !== "marstek_entities" || !battery.source_device_id) continue;
        const device = this._marstekDevices.find((item) => item.device_id === battery.source_device_id);
        if (!device) continue;
        for (const [role, entityId] of Object.entries(device.mapping || {})) {
          const legacyNominalEnergy = role === "total_capacity"
            && /(?:battery_total_energy|battery_total_capacity|total_capacity)$/.test(battery.entities[role] || "");
          if (!battery.entities[role] || legacyNominalEnergy) battery.entities[role] = entityId;
        }
      }
      await this._loadTranslations();
      this._loaded = true;
      this._render();
    } catch (err) {
      this.shadowRoot.innerHTML = `<ha-alert alert-type="error">${esc(err.message || err)}</ha-alert>`;
    } finally {
      this._loading = false;
    }
  }

  _storedLanguage() {
    try { return localStorage.getItem("battery_manager_language") || "auto"; }
    catch (_) { return "auto"; }
  }

  _storedOverviewSections() {
    try {
      const value = JSON.parse(localStorage.getItem("battery_manager_overview_sections") || "{}");
      return {
        commands: Array.isArray(value.commands) ? value.commands.map(String) : [],
        setpoints: Array.isArray(value.setpoints) ? value.setpoints.map(String) : [],
      };
    } catch (_) { return {commands:[],setpoints:[]}; }
  }

  _storeOverviewSections() {
    try {
      localStorage.setItem("battery_manager_overview_sections", JSON.stringify({
        commands:[...this._openCommandSections],
        setpoints:[...this._openSetpointSections],
      }));
    } catch (_) { /* Browser storage unavailable. */ }
  }

  _locale() {
    const requested = this._languageOverride === "auto" ? (this._hass?.language || "en") : this._languageOverride;
    const locale = String(requested).toLowerCase().split(/[-_]/)[0];
    return SUPPORTED_LANGUAGES.includes(locale) ? locale : "en";
  }

  async _loadTranslations() {
    const locale = this._locale();
    const load = async (language) => {
      const response = await fetch(`/battery_manager/frontend/translations/${language}.json?v=${PANEL_VERSION}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Translation ${language}: HTTP ${response.status}`);
      return response.json();
    };
    try {
      this._fallbackTranslations = await load("en");
      this._translations = locale === "en" ? this._fallbackTranslations : await load(locale);
      this._loadedLocale = locale;
    } catch (_) {
      this._translations = this._fallbackTranslations;
      this._loadedLocale = "en";
    }
  }

  _lookup(source, key) { return key.split(".").reduce((value, part) => value?.[part], source); }
  _t(key, variables = {}) {
    let value = this._lookup(this._translations, key) ?? this._lookup(this._fallbackTranslations, key) ?? key;
    for (const [name, replacement] of Object.entries(variables)) value = String(value).replaceAll(`{${name}}`, replacement);
    return value;
  }
  _translatedValue(section, value) {
    const key = `${section}.${value}`;
    const translated = this._lookup(this._translations, key) ?? this._lookup(this._fallbackTranslations, key);
    return translated ?? value;
  }
  _action(value) { return this._translatedValue("actions", value); }
  _adapter(value) { return this._translatedValue("adapters", value); }
  _reason(value) { return value ? this._translatedValue("reasons", value) : ""; }

  _state(entityId) {
    if (!entityId) return { state: "—", unit: "" };
    const state = this._hass?.states?.[entityId];
    return state
      ? { state: state.state, unit: state.attributes.unit_of_measurement || "" }
      : { state: this._t("diagnostic.unavailable"), unit: "" };
  }

  _styles() {
    return `<style>
      :host { display:block; color:var(--primary-text-color); background:var(--primary-background-color); min-height:100vh; }
      * { box-sizing:border-box; }
      header { position:sticky; top:0; z-index:3; display:flex; align-items:center; gap:12px; padding:12px 18px;
        background:var(--app-header-background-color, var(--card-background-color)); box-shadow:0 2px 8px #0002; }
      header h1 { font-size:20px; margin:0 auto 0 0; }
      .language-select { min-width:105px; padding:7px; }
      .profile-menu { position:relative; }
      .profile-menu summary { list-style:none; min-width:155px; padding:8px 12px; border:1px solid var(--divider-color); border-radius:9px; background:var(--card-background-color); cursor:pointer; font-weight:700; }
      .profile-menu summary::-webkit-details-marker { display:none; }
      .profile-menu-content,.actions-menu-content { position:absolute; z-index:20; right:0; top:calc(100% + 5px); min-width:210px; padding:6px; border:1px solid var(--divider-color); border-radius:10px; background:var(--card-background-color); box-shadow:0 8px 24px #0005; display:grid; gap:4px; }
      .profile-menu-content button,.actions-menu-content button { text-align:left; white-space:nowrap; }
      .navigation-menu { position:relative; }
      .navigation-menu summary { list-style:none; display:grid; place-items:center; width:42px; height:42px; border-radius:50%; cursor:pointer; background:var(--secondary-background-color); }
      .navigation-menu summary::-webkit-details-marker { display:none; }
      .navigation-menu summary ha-icon { width:24px; height:24px; }
      .navigation-menu .actions-menu-content button.active { color:#fff; background:var(--primary-color); }
      .actions-menu { position:relative; flex:0 0 auto; }
      .actions-menu summary { list-style:none; padding:10px 14px; border-radius:10px; background:var(--secondary-background-color); cursor:pointer; font-weight:600; }
      nav button, button { border:0; border-radius:10px; padding:10px 14px; cursor:pointer; color:var(--primary-text-color);
        background:var(--secondary-background-color); font-weight:600; }
      nav button.active, button.primary { color:#fff; background:var(--primary-color); }
      main { max-width:1500px; margin:auto; padding:18px; }
      .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .card { background:var(--card-background-color); border-radius:16px; padding:16px; box-shadow:var(--ha-card-box-shadow,0 2px 8px #0002); }
      .battery-head { display:flex; align-items:center; gap:8px; }
      .battery-head ha-icon { color:var(--primary-color); width:28px; height:28px; }
      .battery-head h2 { font-size:17px; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .battery-head { justify-content:space-between; }
      .battery-title { display:flex; align-items:center; gap:7px; min-width:0; flex:1 1 auto; }
      .battery-title > div { min-width:0; }
      .battery-online { font-weight:700; font-size:12px; }
      .online { color:#2e7d32; } .offline,.error { color:#c62828; }
      .quick-control { min-width:0; width:142px; padding:7px 5px; font-weight:700; }
      .battery-summary { display:grid; grid-template-columns:94px 1fr; align-items:center; gap:14px; margin:14px 0 4px; }
      .soc-ring { --soc:0; --soc-color:#c62828; width:88px; height:88px; border-radius:50%; display:grid; place-items:center;
        background:
          repeating-conic-gradient(from -0.8deg, #111 0 1.6deg, transparent 1.6deg 36deg),
          conic-gradient(var(--soc-color) calc(var(--soc)*1%), var(--divider-color) 0); }
      .soc-ring::before { content:""; width:66px; height:66px; border-radius:50%; background:var(--card-background-color); grid-area:1/1; }
      .soc-ring strong { grid-area:1/1; z-index:1; font-size:20px; }
      [data-more-info] { cursor:pointer; }
      [data-more-info]:hover { filter:brightness(.92); }
      .live-power { font-size:22px; font-weight:800; line-height:1.2; }
      .battery-power-block{align-self:stretch;display:grid;grid-template-rows:1fr auto;align-items:center;min-width:0}
      .charge-estimate{justify-self:end;font-size:12px;font-weight:700;color:var(--secondary-text-color);white-space:nowrap}
      .backup-power{color:#ef6c00!important;display:flex;align-items:center;gap:7px}.backup-power ha-icon{color:#ef6c00}
      .charging { color:#2e7d32; } .discharging { color:#c62828; } .waiting-power { color:var(--primary-text-color); }
      .section-divider { border-top:1px solid var(--divider-color); margin-top:12px; padding-top:10px; }
      .setpoint-box { font-size:13px; line-height:1.45; }
      .setpoint-box > summary { cursor:pointer; font-weight:700; }
      .setpoint-box[open] > summary { margin-bottom:5px; }
      .setpoint-body { display:grid; gap:2px; }
      .setpoint-transmitted { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
      .setpoint-transmitted > span { min-width:0; }
      .setpoint-transmitted time { margin-left:auto; white-space:nowrap; color:var(--secondary-text-color); }
      .monitor-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px 12px; }
      .monitor-item { display:flex; align-items:center; gap:7px; min-width:0; }
      .monitor-item ha-icon { color:var(--primary-color); width:20px; flex:0 0 20px; }
      .monitor-item span { color:var(--secondary-text-color); font-size:12px; }
      .monitor-item strong { margin-left:auto; text-align:right; }
      .conversion { display:flex; justify-content:space-between; margin-top:9px; font-weight:700; }
      .temperature-line { display:flex; justify-content:space-between; gap:8px; margin-top:7px; font-size:13px; }
      .capacity-line { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:7px; font-size:13px; align-items:start; }
      .capacity-line > span { min-width:0; display:flex; flex-direction:column; align-items:center; text-align:center; }
      .capacity-line b { display:block; white-space:nowrap; margin-top:2px; }
      .bms-details { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 18px; border-top:1px solid var(--divider-color); margin-top:10px; padding-top:10px; }
      .bms-detail { display:grid; grid-template-columns:20px minmax(0,1fr) auto; align-items:center; gap:7px; min-width:0; font-size:13px; }
      .bms-detail ha-icon { color:var(--primary-color); width:20px; }
      .bms-detail span { min-width:0; }
      .bms-detail strong { white-space:nowrap; text-align:right; }
      .temp-good { color:#2e7d32; } .temp-warn { color:#ef6c00; } .temp-hot { color:#c62828; }
      .muted { color:var(--secondary-text-color); font-size:13px; }
      .metrics { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-top:16px; }
      .metric { padding:12px; border-radius:12px; background:var(--secondary-background-color); text-align:center; }
      .metric strong { display:block; font-size:20px; margin-top:4px; }
      .status { margin-top:14px; border-left:4px solid var(--primary-color); padding:9px 12px; background:var(--secondary-background-color); }
      .transmitted-command { display:block; margin-top:5px; font-weight:600; }
      .mqtt-topic { overflow-wrap:anywhere; font-family:monospace; font-size:11px; }
      .grid-power-card { display:grid; grid-template-columns:1fr 1.2fr 1fr; align-items:center; text-align:center; margin-bottom:14px; border-left:5px solid var(--primary-color); padding-top:12px; padding-bottom:12px; }
      .grid-power-block { min-width:0; }
      .grid-power-block strong { display:block; font-size:19px; white-space:nowrap; }
      .grid-power-now strong { font-size:26px; }
      .grid-power-value { display:flex; align-items:center; justify-content:center; gap:8px; }
      .grid-trend { width:26px; font-size:26px; line-height:1; font-weight:900; }
      .trend-good { color:#2e7d32; } .trend-bad { color:#c62828; } .trend-neutral { color:var(--secondary-text-color); }
      .grid-injection strong,.grid-injection .muted { color:#2e7d32; }
      .grid-consumption strong,.grid-consumption .muted { color:#c62828; }
      .inverter-state { border-top:1px solid var(--divider-color); border-bottom:1px solid var(--divider-color); padding:8px 0; margin-top:8px; }
      .hoymiles-monitoring .inverter-state { border-top:0; margin-top:0; padding-top:0; }
      .grid-power-label { color:var(--secondary-text-color); font-size:12px; }
      .command-status { margin-top:12px; padding-top:10px; border-top:1px solid var(--divider-color); }
      .command-status > summary { cursor:pointer; font-size:14px; font-weight:700; }
      .command-status[open] > summary { margin-bottom:8px; }
      .command-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:5px 8px; border-radius:8px; }
      .command-row:nth-child(even) { background:var(--secondary-background-color); }
      .command-row span { color:var(--secondary-text-color); font-size:13px; }
      .command-row strong { text-align:right; overflow-wrap:anywhere; }
      .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:end; margin-bottom:16px; }
      .schedule-toolbar { flex-wrap:nowrap; overflow:visible; padding-bottom:4px; }
      .schedule-toolbar label { flex:0 0 90px; }
      .schedule-toolbar label:first-child { flex-basis:150px; }
      .schedule-toolbar label:nth-child(4) { flex-basis:175px; }
      .schedule-toolbar label:nth-child(7),.schedule-toolbar label:nth-child(8) { flex-basis:63px; }
      .schedule-toolbar input,.schedule-toolbar select { min-width:0; width:100%; padding:8px; }
      .schedule-toolbar button { flex:0 0 auto; }
      .toolbar .save-right { margin-left:auto; }
      .config-toolbar .language-select { margin-left:0; }
      label { display:flex; flex-direction:column; gap:6px; font-size:13px; color:var(--secondary-text-color); }
      input, select { min-width:130px; padding:10px; border:1px solid var(--divider-color); border-radius:9px;
        color:var(--primary-text-color); background:var(--card-background-color); }
      ha-entity-picker { display:block; width:100%; min-width:250px; }
      input[type=checkbox] { min-width:auto; width:20px; height:20px; }
      .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:14px; }
      fieldset { border:1px solid var(--divider-color); border-radius:14px; margin:16px 0; padding:15px; }
      legend { padding:0 8px; font-weight:700; }
      .schedule-scroll { overflow-x:auto; padding-bottom:8px; }
      .schedule { display:grid; grid-template-columns:repeat(96, minmax(11px,1fr)); gap:2px; min-width:1150px; }
      .slot { min-width:11px; height:34px; border-radius:4px; padding:0; border:2px solid transparent; }
      .slot.hour { border-left-color:var(--divider-color); }
      .slot:hover { transform:translateY(-2px); border-color:var(--primary-text-color); }
      .hours { display:grid; grid-template-columns:repeat(96,minmax(11px,1fr)); gap:2px; font-size:10px; min-width:1150px; margin-bottom:3px; }
      .hours span { grid-column:span 4; padding-left:1px; }
      .schedule-stack { display:grid; gap:16px; }
      .schedule-card { border:2px solid transparent; }
      .schedule-card.selected { border-color:var(--primary-color); }
      .schedule-title { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .profile-tabs { display:flex; gap:7px; align-items:center; justify-content:center; overflow:auto; margin:12px 0; }
      .profile-tabs button.active-edit { outline:3px solid var(--primary-color); }
      .profile-tabs button.active-run::after { content:" ●"; color:#2e7d32; }
      .weekly-wrap { display:flex; gap:14px; overflow-x:auto; padding-bottom:10px; }
      .weekly-card { min-width:410px; flex:1 0 410px; }
      .week-grid { display:grid; grid-template-columns:44px repeat(7,1fr); grid-template-rows:26px repeat(96,8px); user-select:none; }
      .day-head { text-align:center; font-size:11px; font-weight:700; position:sticky; top:0; z-index:1; background:var(--card-background-color); }
      .time-label { font-size:9px; transform:translateY(-4px); color:var(--secondary-text-color); cursor:crosshair; }
      .week-slot { border:0; border-right:1px solid #0002; border-bottom:1px solid #0001; padding:0; border-radius:0; min-width:45px; cursor:crosshair; }
      .week-slot.hour { border-top:1px solid var(--divider-color); }
      .week-slot.selected { outline:2px solid var(--primary-color); z-index:1; opacity:.65; }
      .weather-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; align-items:start; }
      .weather-grid fieldset { min-width:0; margin:0; }
      .weather-grid ha-entity-picker { min-width:0; width:100%; overflow:hidden; }
      .weather-source-pickers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
      .weather-analysis .form-grid { grid-template-columns:repeat(3,max-content); gap:9px 18px; justify-content:start; }
      .weather-analysis label { align-items:flex-start; text-align:left; }
      .weather-analysis input { min-width:80px; width:80px; padding:8px; text-align:left; }
      .weather-analysis input[type="time"] { min-width:100px; width:100px; }
      .weather-conditions .form-grid { grid-template-columns:repeat(auto-fit,minmax(135px,1fr)); gap:8px 10px; }
      .weather-conditions select { min-width:0; width:100%; padding:8px; }
      .weather-source,.weather-conditions { grid-column:1 / -1; }
      .weather-analysis { grid-column:1; grid-row:2; }
      .weather-diagnostic { grid-column:2; grid-row:2; }
      .weather-conditions { grid-row:3; }
      .weather-top-actions { display:flex; justify-content:flex-end; gap:8px; margin:0 0 14px auto; }
      .weather-top-actions button { padding:7px 11px; }
      .weather-diagnostic { line-height:1.45; }
      .weather-diagnostic-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px 18px; }
      .weather-diagnostic-item { min-width:0; }
      dialog { color:var(--primary-text-color); background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:16px; padding:20px; min-width:min(620px,90vw); box-shadow:0 12px 40px #0007; }
      dialog::backdrop { background:#0008; }
      .entity-with-option { display:grid; gap:8px; }
      .entity-with-option > label { display:flex; flex-direction:row; align-items:center; gap:10px; }
      .legend { display:flex; flex-wrap:wrap; justify-content:center; gap:14px; margin:15px 0; }
      .schedule-help { text-align:center; }
      .legend span::before { content:""; display:inline-block; width:12px; height:12px; border-radius:3px; margin-right:5px; background:var(--c); }
      .tiers { width:min(100%,560px); margin:auto; border-collapse:collapse; }
      .tiers th,.tiers td { text-align:left; padding:8px; border-bottom:1px solid var(--divider-color); }
      .tiers input { min-width:70px; width:100%; }
      .actions { display:flex; gap:8px; margin-top:18px; }
      .danger { background:#c62828; color:white; }
      .notice { padding:12px; border-radius:10px; background:#ff980022; border-left:4px solid #ff9800; margin-bottom:16px; }
      details.entities { margin-top:16px; border-top:1px solid var(--divider-color); padding-top:12px; }
      details.entities summary { cursor:pointer; font-weight:700; }
      .entity-table-wrap { overflow:auto; max-height:520px; margin-top:12px; }
      .entity-table { width:100%; border-collapse:collapse; font-size:13px; }
      .entity-table th,.entity-table td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--divider-color); }
      .entity-table tr.problem { background:#c6282814; }
      .entity-table code { color:var(--secondary-text-color); }
      .ok { color:#2e7d32; } .bad { color:#c62828; font-weight:700; }
      .compact-section .form-grid { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:end; justify-content:flex-start; }
      .compact-section label { text-align:left; align-items:flex-start; }
      .compact-section input,.compact-section select { padding:8px; text-align:left; }
      .compact-section input[type="number"] { min-width:80px; width:80px; }
      .grid-settings ha-entity-picker { min-width:340px; width:340px; }
      .grid-settings label:has(input[type="checkbox"]) { min-width:140px; }
      .general-settings input[type="text"] { min-width:220px; width:220px; }
      .general-settings select[data-path="adapter"] { min-width:150px; width:150px; }
      .general-settings select[data-path="disabled_behavior"] { min-width:220px; width:220px; }
      @media(max-width:1100px){ main{padding:12px}.grid{gap:9px}.battery-card{padding:12px}.battery-head h2{font-size:15px}.quick-control{width:130px}.battery-summary{grid-template-columns:82px 1fr;gap:8px}.soc-ring{width:78px;height:78px}.soc-ring::before{width:58px;height:58px}.soc-ring strong{font-size:17px}.live-power{font-size:18px}.capacity-line{gap:5px;font-size:12px}.bms-details{gap:7px 8px}.bms-detail{grid-template-columns:18px minmax(0,1fr);gap:4px}.bms-detail strong{grid-column:2;text-align:left}.command-row{padding-left:5px;padding-right:5px}.weather-analysis .form-grid{grid-template-columns:repeat(2,max-content)} }
      @media(max-width:820px){ .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.weather-conditions .form-grid{grid-template-columns:repeat(4,minmax(110px,1fr))}.schedule-toolbar{overflow-x:auto}.weather-analysis .form-grid{grid-template-columns:repeat(2,max-content)} }
      @media(max-width:700px){ header{gap:8px;padding:10px 12px}header h1{font-size:17px}.profile-menu summary{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}main{padding:10px}.grid{grid-template-columns:1fr}.weather-grid{display:block}.weather-grid fieldset{margin-bottom:10px}.weather-source-pickers{grid-template-columns:1fr}.weather-conditions .form-grid{grid-template-columns:repeat(2,minmax(115px,1fr))}.weather-analysis .form-grid{grid-template-columns:repeat(2,max-content);gap:9px 12px}.weather-diagnostic-grid{grid-template-columns:1fr}.grid-power-card{grid-template-columns:1fr 1.1fr 1fr;padding-left:8px;padding-right:8px}.grid-power-block strong{font-size:15px}.grid-power-now strong{font-size:21px}.grid-power-block:not(.grid-power-now) .muted{display:none}.config-toolbar{align-items:end}.config-toolbar .save-right{margin-left:0}.grid-settings ha-entity-picker{min-width:260px;width:100%} }
      .notification-targets,.notification-batteries,.notification-recipients {display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0}
      .notification-targets label,.notification-recipients label{display:flex;flex-direction:row;gap:6px;align-items:center;flex-wrap:wrap}
      .notification-battery{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px;border:1px solid var(--divider-color);border-radius:7px}
      .notification-battery input[type=number]{min-width:0;width:70px;padding:7px}
      .notification-battery label{display:flex;flex-direction:row;align-items:center;gap:6px}
      .notification-rule h3{margin:0}.notification-rule{border-top:1px solid var(--divider-color);padding:15px 0}
      .notification-rule .muted{margin:6px 0}.notification-group{margin-bottom:16px}
      .notification-group>summary{cursor:pointer;font-weight:600;padding:8px}
      .notification-advanced{margin-top:10px}.notification-advanced .form-grid{margin-top:10px}
      .target-manager{margin:15px 0;padding:12px;border:1px solid var(--divider-color);border-radius:8px}
      .journal-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:12px 0}
      .journal-toolbar label{display:flex;flex-direction:column;gap:5px}.journal-toolbar input{max-width:190px}
      .journal-lines{--journal-kind-width:190px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5}
      .journal-lines.journal-wide-kind{--journal-kind-width:260px}
      .journal-line{display:grid;grid-template-columns:158px var(--journal-kind-width) minmax(0,1fr);gap:14px;padding:5px 8px;border-bottom:1px solid var(--divider-color)}
      .journal-line span{overflow-wrap:anywhere;white-space:pre-wrap}.journal-line time{white-space:nowrap;color:var(--secondary-text-color)}
      .journal-line:nth-child(even){background:var(--secondary-background-color)}
      .journal-tabs{display:flex;flex-wrap:wrap;gap:7px}.journal-tabs .active{background:var(--primary-color);color:var(--text-primary-color,#fff)}
      .about-hero{text-align:center;padding:28px 12px}.about-hero h2{font-size:32px;margin:0 0 14px}.about-links{display:flex;justify-content:center;gap:18px;flex-wrap:wrap}.about-sections details{border-top:1px solid var(--divider-color);padding:10px 2px}.about-sections summary{cursor:pointer;font-weight:700}.about-sections p,.about-sections li{line-height:1.55}.backup-action-grid{display:grid;grid-template-columns:minmax(280px,520px) auto;gap:18px;align-items:end}.backup-action-grid label{display:flex;gap:8px;align-items:center}
      @media(max-width:700px){header{flex-wrap:wrap}header h1{flex:1 1 calc(100% - 60px);min-width:0;order:0}.profile-menu{order:1;max-width:calc(100% - 54px)}.profile-menu summary{max-width:100%}.profile-menu .profile-menu-content{left:0;right:auto;max-width:calc(100vw - 24px)}.navigation-menu{order:2;flex-shrink:0;margin-left:auto}.navigation-menu .actions-menu-content{right:0;left:auto;max-width:calc(100vw - 24px)}.target-manager select{min-width:0;max-width:100%}.target-manager .form-grid,.backup-action-grid{grid-template-columns:minmax(0,1fr)}.journal-line{grid-template-columns:minmax(0,1fr);gap:2px}.notification-battery{width:100%}.notification-batteries{display:block}.notification-battery{margin:8px 0;box-sizing:border-box}.journal-toolbar input{max-width:100%}}

      .about-brand{width:min(800px,100%)}.about-brand img{display:block;width:100%;height:auto;border-radius:12px}.about-version{text-align:right;font-weight:600;margin:6px 4px 14px;color:var(--secondary-text-color)}
      .configuration-theme{--neo-bg:#e8edf2;--neo-input:#f0f4f7;--neo-text:#253e48;--neo-muted:#526975;--neo-border:#a9c4ca;--neo-light:#ffffff;--neo-shadow:#bdc8d3;--neo-accent:#397e8c;background:var(--neo-bg);color:var(--neo-text);padding:12px 18px;border-radius:24px}
      .configuration-theme[data-dark="true"]{--neo-bg:#222e36;--neo-input:#273740;--neo-text:#e1eef2;--neo-muted:#b6ccd4;--neo-border:#4c747e;--neo-light:#34454e;--neo-shadow:#141e24;--neo-accent:#74bfce}
      .configuration-theme fieldset{background:linear-gradient(135deg,var(--neo-input),var(--neo-bg));border:1px solid var(--neo-border);border-radius:22px;padding:22px;margin:16px 0 24px;box-shadow:7px 7px 16px var(--neo-shadow),-5px -5px 14px var(--neo-light);min-width:0}
      .configuration-theme fieldset fieldset{box-shadow:none;margin:20px 0 0;border-radius:15px;padding:16px}
      .configuration-theme legend{font-size:19px;font-weight:600;color:var(--neo-text)}
      .configuration-theme label{color:var(--neo-text);line-height:1.4;min-width:0;align-items:stretch;font-size:13px}
      .configuration-theme .muted{color:var(--neo-muted)}
      .configuration-theme .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:18px;align-items:end}
      .configuration-theme input,.configuration-theme select{width:100%;min-width:0;max-width:100%;color:var(--neo-text);background:var(--neo-input);border:1px solid var(--neo-border);border-radius:13px;padding:11px 12px;font-size:14px;box-shadow:inset 3px 3px 7px var(--neo-shadow),inset -3px -3px 7px var(--neo-light)}
      .configuration-theme input:focus-visible,.configuration-theme select:focus-visible,.configuration-theme button:focus-visible{outline:3px solid var(--neo-accent);outline-offset:3px}
      .configuration-theme button{border:1px solid var(--neo-border);border-radius:13px;color:var(--neo-text);background:var(--neo-input);box-shadow:4px 4px 9px var(--neo-shadow),-3px -3px 8px var(--neo-light)}
      .configuration-theme button.primary{background:var(--neo-accent);color:var(--neo-bg);font-weight:600}
      .configuration-theme button:active{box-shadow:inset 2px 2px 5px var(--neo-shadow)}
      .configuration-theme input:disabled,.configuration-theme select:disabled,.configuration-theme button:disabled{opacity:.5;cursor:not-allowed}
      .configuration-theme ha-entity-picker{min-width:0;width:100%;padding:6px;border:1px solid var(--neo-border);border-radius:15px;background:var(--neo-input);box-shadow:inset 3px 3px 7px var(--neo-shadow),inset -3px -3px 7px var(--neo-light);--primary-text-color:var(--neo-text);--secondary-text-color:var(--neo-muted);--primary-color:var(--neo-accent);--card-background-color:var(--neo-input);--secondary-background-color:var(--neo-input);--input-fill-color:var(--neo-input);--input-ink-color:var(--neo-text);--input-label-ink-color:var(--neo-muted);--mdc-text-field-fill-color:var(--neo-input);--mdc-text-field-ink-color:var(--neo-text);--mdc-theme-surface:var(--neo-input);--mdc-theme-on-surface:var(--neo-text)}
      .configuration-theme .illustrated-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:28px;align-items:center}
      .configuration-theme .section-art{width:100%;display:flex;justify-content:center;align-items:center;color:var(--neo-text);filter:drop-shadow(5px 8px 6px #173e4a20)}
      .configuration-theme .section-art svg{width:100%;max-height:245px}.configuration-theme .battery-product{width:100%;height:220px;object-fit:contain;mix-blend-mode:multiply}
      .configuration-theme[data-dark="true"] .battery-product{mix-blend-mode:normal;background:#e8edf2;border-radius:18px;padding:10px}
      .configuration-theme .section-content{min-width:0}.configuration-theme .network-picker{margin-bottom:24px}
      .configuration-theme .identification-grid{grid-template-columns:minmax(110px,.8fr) minmax(150px,1.2fr) minmax(120px,.8fr) minmax(170px,1.2fr);margin-bottom:22px}
      .configuration-theme .network-controls{grid-template-columns:repeat(5,minmax(0,1fr))}.configuration-theme .general-controls{grid-template-columns:repeat(4,minmax(0,1fr))}
      .configuration-theme .info-entities-grid{grid-template-columns:repeat(5,minmax(0,1fr));align-items:start}
      .configuration-theme .number-control{display:flex;align-items:center;padding:4px;border:1px solid var(--neo-border);border-radius:24px;background:var(--neo-input);box-shadow:inset 3px 3px 7px var(--neo-shadow),inset -3px -3px 7px var(--neo-light)}
      .configuration-theme .number-control input{border:0;box-shadow:none;background:transparent;width:100%;min-width:0;text-align:center;padding:6px 0;appearance:textfield;-moz-appearance:textfield}
      .configuration-theme .number-control input::-webkit-inner-spin-button{appearance:none}.configuration-theme .number-control button{flex:0 0 32px;width:32px;height:32px;border-radius:50%;padding:0;font-size:22px}
      .configuration-theme input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:58px;height:31px;padding:3px;border-radius:22px;position:relative;cursor:pointer;flex-shrink:0;margin:5px 0}
      .configuration-theme input[type="checkbox"]::before{content:"";display:block;width:23px;height:23px;border-radius:50%;background:var(--neo-light);box-shadow:1px 2px 4px var(--neo-shadow);transition:transform .15s}
      .configuration-theme input[type="checkbox"]:checked{background:var(--neo-accent)}.configuration-theme input[type="checkbox"]:checked::before{transform:translateX(26px)}
      .configuration-theme .tiers{width:100%;table-layout:fixed;border-collapse:collapse}.configuration-theme .tiers th{text-align:left;color:var(--neo-text);padding:0 10px 12px;font-weight:500}
      .configuration-theme .tiers td{padding:12px 10px;border-top:1px solid var(--neo-border)}.configuration-theme .tiers td:first-child input{background:var(--tier-color);color:#173b49;font-weight:600}
      .configuration-theme .tiers input{min-width:0;width:100%}.configuration-theme .tiers input[readonly]{cursor:default}.configuration-theme .tier-save{text-align:right;margin-top:16px}
      @media(max-width:1250px){.configuration-theme .info-entities-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.configuration-theme .illustrated-layout{grid-template-columns:140px minmax(0,1fr);gap:20px}.configuration-theme .identification-grid,.configuration-theme .general-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.configuration-theme .network-controls{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:850px){.configuration-theme .info-entities-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.configuration-theme .network-controls{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:600px){.configuration-theme{padding:4px 10px}.configuration-theme fieldset{padding:16px 12px}.configuration-theme .illustrated-layout{grid-template-columns:minmax(0,1fr);gap:16px}.configuration-theme .section-art{max-width:130px;margin:auto}.configuration-theme .battery-product{height:150px}.configuration-theme .info-entities-grid,.configuration-theme .identification-grid,.configuration-theme .general-controls,.configuration-theme .network-controls,.configuration-theme .form-grid{grid-template-columns:minmax(0,1fr)}.configuration-theme .tiers th,.configuration-theme .tiers td{padding:8px 4px;font-size:12px}.configuration-theme .tiers input{font-size:13px;padding:9px 5px}.configuration-theme legend{font-size:16px}}

      /* Shared label alignment applies to every configuration control. */
      .configuration-theme label{align-items:stretch;text-align:center}
      .configuration-theme .general-settings select,.configuration-theme .general-settings input[type="text"]{width:100%;min-width:0}
      .configuration-theme .entity-field{display:flex;flex-direction:column;gap:6px;min-width:0}
      .configuration-theme .entity-label{text-align:center;color:var(--neo-text);font-size:13px;line-height:1.4}
      .configuration-theme input[type="checkbox"]{align-self:center;margin:5px auto}
      .configuration-theme .entity-with-option>label{margin-top:8px;text-align:center;width:100%;flex-direction:column;align-items:stretch}
      .configuration-theme .tiers th{text-align:center}
      .configuration-theme .network-controls{grid-template-columns:repeat(4,minmax(0,1fr)) max-content}
      .configuration-theme .network-controls>label:last-child{max-width:175px}
      .configuration-theme .marstek-detection-grid{grid-template-columns:minmax(0,50%) max-content;align-items:end;gap:8px 18px}
      .configuration-theme .marstek-detection-grid>button{justify-self:start;align-self:end;min-height:42px}
      .configuration-theme .detection-status{grid-column:1;text-align:right;margin:0;line-height:1.4}
      .configuration-theme .info-entities-grid .grid-recovery-option{align-self:stretch;justify-content:space-between}
      .about-brand{margin-left:auto;margin-right:auto}
      @media(max-width:1250px){.configuration-theme .network-controls{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:850px){.configuration-theme .network-controls{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:600px){.configuration-theme .network-controls,.configuration-theme .marstek-detection-grid{grid-template-columns:minmax(0,1fr)}.configuration-theme .network-controls>label:last-child{max-width:none}.configuration-theme .marstek-detection-grid>button{justify-self:stretch}.configuration-theme .detection-status{grid-column:auto}}
    </style>`;
  }

  _render() {
    if (!this._config) return;
    const body = this._tab === "overview" ? this._overview()
      : this._tab === "weather" ? this._weatherEditor()
      : this._tab === "notifications" ? this._notificationsEditor()
      : this._tab === "journal" ? this._journalEditor()
      : this._tab === "actions" ? this._actionsEditor()
      : this._tab === "about" ? this._aboutEditor()
      : this._tab === "batteries" ? this._batteryEditor()
      : this._scheduleEditor();
    this.shadowRoot.innerHTML = `${this._styles()}
      <header><ha-icon icon="mdi:battery-charging"></ha-icon><h1>${this._t("title")} v${PANEL_VERSION}</h1>
      <details class="profile-menu"><summary>${this._config.active_profile==="auto"?`${this._t("profiles.auto")} → ${esc((this._config.schedule_profiles||[]).find(p=>p.id===this._status.effective_profile)?.name||this._status.effective_profile||"—")}`:`${this._t("profiles.manual")} → ${esc((this._config.schedule_profiles||[]).find(p=>p.id===this._config.active_profile)?.name||this._config.active_profile)}`}</summary><div class="profile-menu-content">
        <button data-active-profile="auto">${this._t("profiles.auto")}</button>
        ${(this._config.schedule_profiles||[]).map(p=>`<button data-active-profile="${esc(p.id)}">${esc(p.name)}</button>`).join("")}
      </div></details>
      <details class="navigation-menu"><summary aria-label="${esc(this._t("tabs.configuration"))}"><ha-icon icon="mdi:cog"></ha-icon></summary><div class="actions-menu-content">
        <button data-tab="overview" class="${this._tab === "overview" ? "active" : ""}">${this._t("tabs.overview")}</button>
        <button data-tab="weather" class="${this._tab === "weather" ? "active" : ""}">${this._t("tabs.weather")}</button>
        <button data-tab="batteries" class="${this._tab === "batteries" ? "active" : ""}">${this._t("tabs.configuration")}</button>
        <button data-tab="schedule" class="${this._tab === "schedule" ? "active" : ""}">${this._t("tabs.schedule")}</button>
        <button data-tab="notifications" class="${this._tab === "notifications" ? "active" : ""}">${this._t("tabs.notifications")}</button>
        <button data-tab="journal" class="${this._tab === "journal" ? "active" : ""}">${this._t("tabs.journal")}</button>
        <button data-tab="actions" class="${this._tab === "actions" ? "active" : ""}">${this._t("tabs.actions")}</button>
        <button data-tab="about" class="${this._tab === "about" ? "active" : ""}">${this._t("tabs.about")}</button>
      </div></details></header><main>${body}</main>`;
    this._bind();
    this._bindNotificationsAndJournal();
  }

  _actionsEditor() {
    const action=this._config.backup_actions||={entity_id:"",restore_on_exit:false};
    return `<div class="card"><div class="toolbar"><h2>${this._t("backup_actions.title")}</h2><button id="save" class="primary save-right">${this._t("buttons.save")}</button></div>
      <p class="muted">${this._t("backup_actions.help")}</p><div class="backup-action-grid">
      <ha-entity-picker data-entity-path="_global.backup_actions.entity_id" data-label="${esc(this._t("backup_actions.entity"))}" data-domains="switch,input_boolean" value="${esc(action.entity_id||"")}" allow-custom-entity></ha-entity-picker>
      <label><input data-path="_global.backup_actions.restore_on_exit" type="checkbox" ${action.restore_on_exit?"checked":""}>${this._t("backup_actions.restore")}</label></div>
      <p class="muted">${this._t("backup_actions.once")}</p></div>`;
  }

  _aboutEditor() {
    const sections=["installation","configuration","overview","quick_modes","scheduler","weather","collective","protections","compensation","backup","actions","notifications","journal","diagnostics","maintenance"];
    return `<div class="card"><div class="about-hero"><div class="about-brand"><img src="${ASSET_BASE}battery-manager-banner.jpg?v=${PANEL_VERSION}" alt="Battery Manager"><div class="about-version">v${PANEL_VERSION}</div></div><div class="about-links">
      <a href="https://github.com/RenaudSub/Battery-Manager" target="_blank" rel="noopener">${this._t("about.project")}</a>
      <a href="https://www.logisub.com/battery-manager.html" target="_blank" rel="noopener">${this._t("about.website")}</a>
      <span class="about-author">Intégration par SUBRINI Renaud</span></div></div><hr>
      <h2>${this._t("about.guide")}</h2><p>${this._t("about.introduction")}</p><div class="about-sections">${sections.map(id=>`<details><summary>${this._t(`about.sections.${id}.title`)}</summary><p>${this._t(`about.sections.${id}.text`)}</p></details>`).join("")}</div></div>`;
  }


  _notificationsEditor() {
    const n=this._config.notifications||{targets:[],rules:{}},t=(key)=>this._t(`notifications.${key}`);
    const draft=this._targetDraft;
    const actionOptions=[...new Set([...this._notificationActions,...n.targets.map(x=>x.action)])];
    const manager=this._manageTargets?`<div class="target-manager"><div class="toolbar">
      <select id="targetSelect"><option value="">${t("new_target")}</option>${n.targets.map(x=>`<option value="${esc(x.id)}" ${draft.id===x.id?"selected":""}>${esc(x.name)}</option>`).join("")}</select></div>
      <div class="form-grid"><label>${t("action")}<select data-target-field="action"><option value="">${t("choose")}</option>${actionOptions.map(a=>`<option value="${esc(a)}" ${draft.action===a?"selected":""}>${esc(a)}${this._notificationActions.includes(a)?"":` (${t("unavailable")})`}</option>`).join("")}</select></label>
      <label>${t("name")}<input data-target-field="name" maxlength="100" value="${esc(draft.name)}"></label>
      <label>${this._t("schedule.start")}<input data-target-field="start" type="time" value="${esc(draft.start)}"></label>
      <label>${this._t("schedule.end")}<input data-target-field="end" type="time" value="${esc(draft.end)}"></label></div>
      <p class="muted">${t("hours_help")}</p><div class="toolbar"><button id="applyTarget">${draft.id?t("update"):this._t("buttons.add")}</button>${draft.id?`<button id="testDraftTarget">${t("test_target")}</button><button id="deleteTarget" class="danger">${this._t("buttons.delete")}</button>`:""}</div></div>`:"";
    const groups=[
      ["soc",["soc_low","soc_high","full","soc_recovered","soc_gap"]],
      ["temperature",["temperature_high","temperature_low","temperature_recovered"]],
      ["battery",["charge_start","charge_end","discharge_start","discharge_end","standby","mode_unexpected"]],
      ["power",["underpower","charge_overpower","discharge_overpower","standby_power"]],
      ["commands",["command_error","command_unconfirmed","command_recovered"]],
      ["scheduler",["program_start","program_end","program_blocked","automatic_mode"]],
      ["weather",["weather_change","weather_unavailable","weather_recovered"]],
      ["availability",["battery_unavailable","battery_recovered","sensor_unavailable","sensor_stale","grid_unavailable","grid_recovered","connection_lost","connection_recovered"]],
      ["summary",["daily_summary"]]
    ];
    return `<div class="card"><div class="toolbar"><h2>${t("targets")}</h2><button id="manageTargets" class="save-right">${t("manage")}</button><button id="save" class="primary">${this._t("buttons.save")}</button></div>
      <div class="notification-targets">${n.targets.map(x=>`<label><input type="checkbox" data-target-enabled="${esc(x.id)}" ${x.enabled?"checked":""}><b>${esc(x.name)}</b><span class="muted">${esc(x.start)}–${esc(x.end)}</span></label>`).join("")||`<span class="muted">${t("no_targets")}</span>`}</div>${manager}
      <p class="muted">${t("delivery_help")}</p></div>
      ${groups.map(([group,ids])=>`<details class="card notification-group" data-notification-group="${group}" ${this._openNotificationGroups?.has(group)||(!this._openNotificationGroups&&group==="soc")?"open":""}><summary>${t(`groups.${group}`)}</summary>${ids.map(id=>this._notificationRule(id)).join("")}</details>`).join("")}`;
  }

  _notificationRule(id) {
    const n=this._config.notifications,spec=this._notificationCatalog.find(x=>x.id===id);
    if(!spec)return "";
    const rule=n.rules[id],t=(key)=>this._t(`notifications.${key}`);
    const batteries=spec.scope==="battery"?`<div class="notification-batteries">${this._config.batteries.map(b=>{
      const key=String(b.id||b.name),cfg=rule.batteries[key]||{enabled:true,threshold:null};
      const fallback=spec.source?(b.limits?.[spec.source]??spec.default):spec.default;
      const value=cfg.threshold??fallback;
      const minimum=spec.unit==="°C"?-100:0, maximum=spec.unit==="%"?100:spec.unit==="°C"?200:spec.unit==="min"?1440:100000;
      return `<div class="notification-battery"><label><input type="checkbox" data-rule-battery="${id}" data-battery-id="${esc(key)}" ${cfg.enabled?"checked":""}>${esc(b.name)}</label>${spec.default!==null?`<label>${spec.unit==="%"&&id.startsWith("soc")?"SOC":t("threshold")}<input aria-label="${esc(b.name)} ${t("threshold")}" type="number" min="${minimum}" max="${maximum}" step="any" data-rule-threshold="${id}" data-battery-id="${esc(key)}" value="${esc(value)}" ${cfg.enabled?"":"disabled"}>${esc(spec.unit)}</label>${spec.source?`<span class="muted">${cfg.threshold==null?t("from_config"):t("custom")}</span>${cfg.threshold!=null?`<button data-reset-threshold="${id}" data-battery-id="${esc(key)}">${t("reset_config")}</button>`:""}`:""}`:""}</div>`;
    }).join("")}</div>`:"";
    return `<section class="notification-rule"><h3>${t(`rules.${id}.title`)}</h3><p class="muted">${t(`rules.${id}.description`)}</p>${batteries}
      ${id==="daily_summary"?`<label>${t("summary_time")} <input type="time" data-rule-time="${id}" value="${esc(rule.time||"20:00")}"></label>`:""}
      <div class="notification-recipients"><b>${t("recipients")} :</b>${n.targets.map(x=>`<label><input type="checkbox" data-rule-target="${id}" data-target-id="${esc(x.id)}" ${rule.targets.includes(x.id)?"checked":""}>${esc(x.name)}${x.enabled?"":` (${t("disabled")})`}</label>`).join("")}${rule.targets.length?"":`<span class="muted">${t("no_recipients")}</span>`}</div>
      <details class="notification-advanced"><summary>${t("advanced")}</summary><div class="form-grid"><label>${t("confirm")}<input type="number" min="0" max="86400" data-rule-setting="${id}" data-setting="confirm_s" value="${rule.confirm_s}"></label><label>${t("rearm_hours")}<input type="number" min="0" max="720" step="0.25" data-rule-setting="${id}" data-setting="rearm_h" value="${rule.rearm_h}"></label></div><p class="muted">${t("rearm_help")}</p><p class="muted">${t("test_help")}</p><button data-test-rule="${id}" ${rule.targets.length?"":"disabled"}>${t("test_rule")}</button></details></section>`;
  }

  _journalEditor() {
    const t=(key)=>this._t(`journal.${key}`);
    return `<div class="card"><div class="toolbar"><h2>${this._t("tabs.journal")}</h2><button id="clearJournal" class="danger save-right">${t("clear")}</button></div>
      <div class="journal-tabs">${["commands","scheduler","weather","notifications","users"].map(id=>`<button data-journal-category="${id}" class="${id===this._journalCategory?"active":""}">${t(`tabs.${id}`)}</button>`).join("")}</div>
      <div class="journal-toolbar"><label>${t("search")}<input id="journalSearch" type="search" value="${esc(this._journalSearch)}"></label><label>${t("from")}<input id="journalSince" type="date" value="${esc(this._journalSince)}"></label><label>${t("until")}<input id="journalUntil" type="date" value="${esc(this._journalUntil)}"></label><button id="refreshJournal">${t("refresh")}</button></div>
      <p class="muted" id="journalMeta">${t("retention")}</p><div class="journal-lines ${["commands","scheduler"].includes(this._journalCategory)?"journal-wide-kind":""}" id="journalLines">${this._journalRows()}</div><button id="moreJournal" ${this._journal.next?"":"hidden"}>${t("more")}</button></div>`;
  }

  _journalRows() {
    const zone=this._hass.config?.time_zone||undefined;
    return this._journal.entries?.length?this._journal.entries.map(row=>`<div class="journal-line"><time>${esc(new Date(row.stamp*1000).toLocaleString("fr-FR",{timeZone:zone,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"}).replace(",", ""))}</time><span>${esc(row.kind)}</span><span>${esc(row.content)}</span></div>`).join(""):`<p class="muted">${this._t("journal.empty")}</p>`;
  }

  async _loadJournal(append=false) {
    if(this._journalLoading)return;
    this._journalLoading=true;
    const requestCategory=this._journalCategory;
    try{
      const request={type:"battery_manager/journal",category:requestCategory,search:this._journalSearch};
      if(append&&this._journal.next)request.before=this._journal.next;
      if(this._journalSince)request.since=new Date(this._journalSince+"T00:00:00").getTime()/1000;
      if(this._journalUntil)request.until=new Date(this._journalUntil+"T00:00:00").getTime()/1000+86400;
      const result=await this._hass.callWS(request);
      if(requestCategory!==this._journalCategory)return;
      this._journal={...result,entries:append?[...this._journal.entries,...result.entries]:result.entries};
      const rows=this.shadowRoot.querySelector("#journalLines");if(rows)rows.innerHTML=this._journalRows();
      const meta=this.shadowRoot.querySelector("#journalMeta");if(meta)meta.textContent=`${this._t("journal.retention")} · ${(result.bytes/1000000).toFixed(2)} / 50 Mo · ${result.count} ${this._t("journal.entries")}`;
      const more=this.shadowRoot.querySelector("#moreJournal");if(more)more.hidden=!result.next;
    }catch(err){alert(this._t("journal.error",{details:err.message||err}));}
    finally{this._journalLoading=false;}
  }

  async _testNotification(payload) {
    try{
      const result=await this._hass.callWS({type:"battery_manager/test_notification",...payload});
      alert(result.results.map(x=>`${x.target} : ${this._t(`notifications.${x.sent?"test_ok":"test_failed"}`)}`).join("\n"));
    }catch(err){alert(this._t("journal.error",{details:err.message||err}));}
  }

  _bindNotificationsAndJournal() {
    const q=(s)=>this.shadowRoot.querySelector(s),all=(s)=>this.shadowRoot.querySelectorAll(s), n=this._config.notifications;
    if(q("#manageTargets"))q("#manageTargets").onclick=()=>{this._manageTargets=!this._manageTargets;this._render();};
    if(q("#targetSelect"))q("#targetSelect").onchange=e=>{const target=n.targets.find(x=>x.id===e.target.value);this._targetDraft=target?structuredClone(target):{id:"",name:"",action:"",enabled:true,start:"07:00",end:"22:00"};this._render();};
    all("[data-target-field]").forEach(el=>el.onchange=()=>this._targetDraft[el.dataset.targetField]=el.value);
    if(q("#applyTarget"))q("#applyTarget").onclick=()=>{
      // Capture fields on click, including input not yet blurred.
      all("[data-target-field]").forEach(el=>this._targetDraft[el.dataset.targetField]=el.value);
      const d=this._targetDraft;
      if(!d.name.trim()||!this._notificationActions.includes(d.action)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.end)||d.start>=d.end){alert(this._t("notifications.invalid_target"));return;}
      if(n.targets.some(x=>x.action===d.action&&x.id!==d.id)){alert(this._t("notifications.duplicate_target"));return;}
      const target={...d,id:d.id||(crypto.randomUUID?.()||`target_${Date.now()}_${Math.random().toString(36).slice(2)}`),name:d.name.trim()};
      const index=n.targets.findIndex(x=>x.id===target.id);if(index<0)n.targets.push(target);else n.targets[index]=target;
      this._targetDraft={id:"",name:"",action:"",enabled:true,start:"07:00",end:"22:00"};this._render();
    };
    if(q("#deleteTarget"))q("#deleteTarget").onclick=()=>{if(!confirm(this._t("notifications.confirm_delete")))return;const id=this._targetDraft.id;n.targets=n.targets.filter(x=>x.id!==id);for(const rule of Object.values(n.rules))rule.targets=rule.targets.filter(x=>x!==id);this._targetDraft={id:"",name:"",action:"",enabled:true,start:"07:00",end:"22:00"};this._render();};
    if(q("#testDraftTarget"))q("#testDraftTarget").onclick=()=>this._testNotification({target:this._targetDraft});
    all("[data-target-enabled]").forEach(el=>el.onchange=()=>{n.targets.find(x=>x.id===el.dataset.targetEnabled).enabled=el.checked;this._render();});
    all("[data-rule-battery]").forEach(el=>el.onchange=()=>{n.rules[el.dataset.ruleBattery].batteries[el.dataset.batteryId].enabled=el.checked;this._render();});
    all("[data-rule-threshold]").forEach(el=>el.onchange=()=>{if(!el.checkValidity()||el.value===""){el.reportValidity();this._render();return;}n.rules[el.dataset.ruleThreshold].batteries[el.dataset.batteryId].threshold=Number(el.value);this._render();});
    all("[data-reset-threshold]").forEach(el=>el.onclick=()=>{n.rules[el.dataset.resetThreshold].batteries[el.dataset.batteryId].threshold=null;this._render();});
    all("[data-rule-target]").forEach(el=>el.onchange=()=>{const rule=n.rules[el.dataset.ruleTarget],id=el.dataset.targetId;rule.targets=el.checked?[...new Set([...rule.targets,id])]:rule.targets.filter(x=>x!==id);this._render();});
    all("[data-rule-setting]").forEach(el=>el.onchange=()=>{if(!el.checkValidity()){el.reportValidity();return;}n.rules[el.dataset.ruleSetting][el.dataset.setting]=Number(el.value);});
    all("[data-rule-time]").forEach(el=>el.onchange=()=>n.rules[el.dataset.ruleTime].time=el.value);
    all("[data-test-rule]").forEach(el=>el.onclick=async()=>{if(await this._save())await this._testNotification({rule_id:el.dataset.testRule});});
    all("details[data-notification-group]").forEach(el=>el.ontoggle=()=>{this._openNotificationGroups||=new Set(["soc"]);if(el.open)this._openNotificationGroups.add(el.dataset.notificationGroup);else this._openNotificationGroups.delete(el.dataset.notificationGroup);});
    all("[data-journal-category]").forEach(el=>el.onclick=()=>{if(this._journalLoading)return;this._journalCategory=el.dataset.journalCategory;this._journal={entries:[]};this._render();this._loadJournal();});
    for(const [id,field] of [["journalSearch","_journalSearch"],["journalSince","_journalSince"],["journalUntil","_journalUntil"]])if(q("#"+id))q("#"+id).onchange=e=>{this[field]=e.target.value;this._loadJournal();};
    if(q("#journalSearch"))q("#journalSearch").onkeydown=e=>{if(e.key==="Enter"){this._journalSearch=e.target.value;this._loadJournal();}};
    if(q("#refreshJournal"))q("#refreshJournal").onclick=()=>this._loadJournal();
    if(q("#moreJournal"))q("#moreJournal").onclick=()=>this._loadJournal(true);
    if(q("#clearJournal"))q("#clearJournal").onclick=async()=>{if(!confirm(this._t("journal.confirm_clear")))return;try{await this._hass.callWS({type:"battery_manager/clear_journal"});await this._loadJournal();}catch(err){alert(this._t("journal.error",{details:err.message||err}));}};
  }

  _overview() {
    if (!this._config.batteries.length) return `<div class="card">${this._t("overview.none")}</div>`;
    const rawGrid = this._state(this._config.grid_power_entity);
    const numericGrid = Number(rawGrid.state);
    const effectiveGrid = this._config.grid_power_inverted && Number.isFinite(numericGrid) ? -numericGrid : rawGrid.state;
    const gridBlock = (label, value, current = false, trend = "") => {
      const numeric = Number(value);
      const shown = Number.isFinite(numeric) ? `${Math.round(numeric)} ${rawGrid.unit || "W"}` : "—";
      const direction = Number.isFinite(numeric)
        ? this._t(numeric >= 0 ? "overview.consumption" : "overview.injection") : "";
      const flowClass = !Number.isFinite(numeric) || numeric === 0 ? "" : numeric < 0 ? "grid-injection" : "grid-consumption";
      return `<div class="grid-power-block ${current ? "grid-power-now" : ""} ${flowClass}"><div class="grid-power-label">${label}</div><div class="grid-power-value">${trend}<strong>${esc(shown)}</strong></div><div class="muted">${esc(direction)}</div></div>`;
    };
    const trend = this._gridTrend(effectiveGrid, this._status.grid_average_15m);
    const gridCard = `<section class="card grid-power-card">
      ${gridBlock(this._t("overview.average_1m"), this._status.grid_average_1m)}
      ${gridBlock(this._t("overview.network_power"), effectiveGrid, true, trend)}
      ${gridBlock(this._t("overview.average_15m"), this._status.grid_average_15m)}
    </section>`;
    return `${gridCard}<div class="grid">${this._config.batteries.map((b) => {
      const rawPower = this._state(b.entities.power);
      const numericPower = Number(rawPower.state);
      const normalizedPower = b.power_inverted && Number.isFinite(numericPower) ? -numericPower : numericPower;
      const soc = this._state(b.entities.soc);
      const temp = this._state(b.entities.temperature);
      const decisionKey = b.id || b.name;
      const sectionKey = String(decisionKey);
      const decision = this._status.decisions?.[decisionKey] || {};
      const backupBlocked = ["backup","backup_recovery"].includes(decision.action);
      const device = this._marstekDevices.find((item) => item.device_id === b.source_device_id);
      const connectivity = this._batteryConnectivity(b);
      const socNumber = Math.max(0, Math.min(100, Number(soc.state) || 0));
      const socColor = socNumber < 30 ? "#c62828" : socNumber < 50 ? "#ef6c00" : "#43a047";
      const powerClass = backupBlocked ? "backup-power" : normalizedPower > 10 ? "charging" : normalizedPower < -10 ? "discharging" : "waiting-power";
      const powerText = backupBlocked ? this._t(decision.action === "backup" ? "overview.backup_mode" : "overview.backup_recovery")
        : !Number.isFinite(normalizedPower) ? "—"
        : normalizedPower > 10 ? `${Math.round(Math.abs(normalizedPower))} W ${this._t("overview.in_charge")}`
        : normalizedPower < -10 ? `${Math.round(Math.abs(normalizedPower))} W ${this._t("overview.in_discharge")}`
        : this._t("control_modes.standby");
      const chargeEstimate = this._chargeEstimate(decisionKey, normalizedPower);
      return `<section class="card battery-card"><div class="battery-head"><div class="battery-title"><ha-icon icon="mdi:battery-medium"></ha-icon>
        <div><h2>${esc(b.name)}</h2><div class="battery-online ${connectivity.className}">${this._t("overview.status")} : ${this._t(`overview.${connectivity.label}`)}</div></div></div>
        <select class="quick-control" aria-label="${esc(this._t("overview.management"))}" data-quick-mode="${esc(decisionKey)}" ${backupBlocked?"disabled":""}>${this._controlOptions(b, backupBlocked?"backup":(b.control_mode || (b.enabled ? "schedule" : "disabled")))}</select></div>
        <div class="battery-summary"><div class="soc-ring" data-more-info="${esc(b.entities.soc)}" style="--soc:${socNumber};--soc-color:${socColor}"><strong>${Number.isFinite(Number(soc.state)) ? `${Math.round(Number(soc.state))}%` : "—"}</strong></div>
        <div class="battery-power-block"><div class="live-power ${powerClass}" data-more-info="${esc(b.entities.power)}">${backupBlocked?`<ha-icon icon="mdi:alert"></ha-icon>${esc(powerText)}`:esc(powerText)}</div>${backupBlocked?"":chargeEstimate}</div></div>
        ${b.adapter === "marstek_entities" ? this._marstekCommandStatus(b) : ""}
        ${b.adapter === "hoymiles_msa2" ? this._msa2CommandStatus(b, decision) : ""}
        <details class="section-divider setpoint-box" data-setpoint-device="${esc(sectionKey)}" ${this._openSetpointSections.has(sectionKey)?"open":""}><summary>${this._t("overview.current_setpoint")}</summary><div class="setpoint-body">
          <div>${this._t("overview.current_mode")} : ${esc(this._currentModeLabel(b, decision))}</div>
          <div class="setpoint-transmitted"><span>${this._t("overview.transmitted_command")} : ${backupBlocked?this._t("overview.no_backup_command"):this._commandText(decision, b)}</span>${decision.command_sent_at?`<time>${esc(this._formatCommandTime(decision.command_sent_at))}</time>`:""}</div>
          ${decision.calculated_command_w !== undefined ? `<div>${this._t("overview.calculated_command")} : ${esc(decision.calculated_command_w)} W · ${this._t("overview.compensation")} : ${decision.compensation_w > 0 ? "+" : ""}${esc(decision.compensation_w)} W</div>` : ""}
        </div></details>
        ${this._batteryMonitoring(b, normalizedPower, temp, decisionKey)}
        ${device ? this._entityDiagnostic(device) : ""}</section>`;
    }).join("")}</div>`;
  }

  _controlOptions(battery, selected) {
    const modes = ["schedule", "charge", "self_consumption", "native_self_consumption", "solar_charge", "standby", "disabled"];
    if (battery.adapter === "marstek_entities" && battery.entities?.backup_function) modes.splice(6,0,"backup");
    return modes.map((mode) => `<option value="${mode}" ${mode===selected?"selected":""}>${this._t(`control_modes.${mode}`)}</option>`).join("");
  }

  _chargeEstimate(batteryId, power) {
    const estimate = this._status.charge_estimates?.[batteryId];
    if (!estimate || !Number.isFinite(power) || power < 50 || !estimate.completion_at) return "";
    const date = new Date(estimate.completion_at);
    if (Number.isNaN(date.getTime())) return "";
    const time = date.toLocaleTimeString(this._locale(), {hour:"2-digit", minute:"2-digit"});
    const target = Number(estimate.target_soc);
    const targetLabel = Number.isFinite(target) ? String(Number(target.toFixed(1))) : "100";
    return `<div class="charge-estimate">${esc(this._t("overview.charge_eta", {target:targetLabel, time}))}</div>`;
  }

  _formatCommandTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat(this._locale(), {
      hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false,
    }).formatToParts(date).map(part=>[part.type,part.value]));
    return `(${parts.hour}h${parts.minute}:${parts.second})`;
  }

  _gridTrend(currentValue, averageValue) {
    const current = Number(currentValue), average = Number(averageValue);
    if (!Number.isFinite(current) || !Number.isFinite(average) || current === 0) return "";
    const magnitudeDelta = Math.abs(current) - Math.abs(average);
    if (Math.abs(magnitudeDelta) < 10) return `<span class="grid-trend trend-neutral">→</span>`;
    const increasing = magnitudeDelta > 0;
    const favorable = current < 0 ? increasing : !increasing;
    return `<span class="grid-trend ${favorable ? "trend-good" : "trend-bad"}">${increasing ? "↑" : "↓"}</span>`;
  }

  _currentModeLabel(battery, decision={}) {
    if (decision.action === "backup") return this._t("overview.backup_mode");
    if (decision.action === "backup_recovery") return this._t("overview.backup_recovery");
    let mode = battery.control_mode || (battery.enabled ? "schedule" : "disabled");
    if (mode === "schedule") {
      const now = new Date();
      const index = now.getHours() * 4 + Math.floor(now.getMinutes() / 15);
      const day=(now.getDay()+6)%7, profile=this._status.effective_profile||this._config.active_profile||"sunny";
      mode = battery.schedules?.[profile]?.[day]?.[index]?.action || battery.schedule?.[index]?.action || "standby";
    }
    if (mode === "disabled") return this._t("control_modes.disabled");
    return this._action(mode);
  }

  _batteryConnectivity(battery) {
    const ids = [battery.entities?.soc, battery.entities?.power].filter(Boolean);
    const states = ids.map((id) => this._hass?.states?.[id]);
    if (!ids.length || states.some((state) => !state || ["unknown","unavailable"].includes(state.state))) return {label:"offline",className:"offline"};
    const inverterState = this._hass?.states?.[battery.entities?.state];
    if (inverterState && /error|fault|alarm|erreur|défaut/i.test(String(inverterState.state))) return {label:"error",className:"error"};
    return {label:"online",className:"online"};
  }

  _batteryMonitoring(battery, normalizedAcPower, temperature, batteryId) {
    const e = battery.entities || {};
    const item = (icon, label, entityId) => { const value=this._state(entityId); return `<div class="monitor-item" data-more-info="${esc(entityId)}"><ha-icon icon="${icon}"></ha-icon><span>${label}</span><strong>${esc(value.state)} ${esc(value.unit)}</strong></div>`; };
    const dcPowerState = this._state(e.dc_power);
    const dcPower = Math.abs(Number(dcPowerState.state));
    const acPower = Math.abs(Number(normalizedAcPower));
    let conversion = "—";
    if (Number.isFinite(acPower) && Number.isFinite(dcPower) && acPower >= 50 && dcPower >= 50) {
      const ratio = normalizedAcPower >= 0 ? dcPower / acPower : acPower / dcPower;
      if (ratio > 0 && ratio <= 1.2) conversion = `${(ratio * 100).toFixed(1)} %`;
    }
    const tempNumber = Number(temperature.state);
    const tempClass = !Number.isFinite(tempNumber) ? "" : tempNumber > 40 ? "temp-hot" : tempNumber > 33 ? "temp-warn" : "temp-good";
    const daily = this._status.temperature_daily?.[batteryId] || {};
    const inverter = this._state(e.state), capacity = this._state(e.total_capacity), charged = this._state(e.charged_today), discharged = this._state(e.discharged_today);
    const bmsItem = (fallbackIcon, label, entityId) => {
      const value=this._state(entityId), icon=this._hass?.states?.[entityId]?.attributes?.icon || fallbackIcon;
      return `<div class="bms-detail" data-more-info="${esc(entityId)}"><ha-icon icon="${esc(icon)}"></ha-icon><span>${label}</span><strong>${esc(value.state)} ${esc(value.unit)}</strong></div>`;
    };
    const detailedMonitoring = battery.adapter === "hoymiles_msa2" ? "" : `<div class="monitor-grid">
      ${item("mdi:sine-wave", "AC V", e.grid_voltage)}${item("mdi:battery-charging", "DC V", e.dc_voltage)}
      ${item("mdi:current-ac", "AC A", e.ac_current)}${item("mdi:current-dc", "DC A", e.dc_current)}
      ${item("mdi:flash", "AC W", e.power)}${item("mdi:flash", "DC W", e.dc_power)}
      </div><div class="conversion"><span>${this._t("overview.conversion")}</span><strong>${conversion}</strong></div>
      <div class="temperature-line"><span>${this._t("fields.temperature")}</span><strong class="${tempClass}" data-more-info="${esc(e.temperature)}">${esc(temperature.state)} ${esc(temperature.unit)}</strong><span class="temp-good">↓ ${daily.min ?? "—"}°C</span><span class="temp-hot">↑ ${daily.max ?? "—"}°C</span></div>`;
    const capacityMonitoring = battery.adapter === "hoymiles_msa2"
      ? `<div class="capacity-line"><span data-more-info="${esc(e.charged_today)}">${this._t("overview.charged_today")} <b>${esc(charged.state)} ${esc(charged.unit)}</b></span><span data-more-info="${esc(e.discharged_today)}">${this._t("overview.discharged_today")} <b>${esc(discharged.state)} ${esc(discharged.unit)}</b></span></div>`
      : `<div class="capacity-line"><span data-more-info="${esc(e.total_capacity)}">${this._t("overview.total_capacity")} <b>${esc(capacity.state)} ${esc(capacity.unit)}</b></span><span data-more-info="${esc(e.charged_today)}">${this._t("overview.charged_today")} <b>${esc(charged.state)} ${esc(charged.unit)}</b></span><span data-more-info="${esc(e.discharged_today)}">${this._t("overview.discharged_today")} <b>${esc(discharged.state)} ${esc(discharged.unit)}</b></span></div>`;
    const bmsDetails = battery.adapter === "marstek_entities" ? `<div class="bms-details">
      ${bmsItem("mdi:counter", this._t("overview.cycle_count"), e.cycle_count)}
      ${bmsItem("mdi:counter", this._t("overview.cycle_count_calc"), e.cycle_count_calc)}
      ${bmsItem("mdi:sine-wave", this._t("overview.max_cell_voltage"), e.max_cell_voltage)}
      ${bmsItem("mdi:sine-wave", this._t("overview.min_cell_voltage"), e.min_cell_voltage)}
      </div>` : "";
    return `<div class="section-divider ${battery.adapter === "hoymiles_msa2" ? "hoymiles-monitoring" : ""}">${detailedMonitoring}
      <div class="temperature-line inverter-state" data-more-info="${esc(e.state)}"><span>${this._t("overview.inverter_status")}</span><strong>${esc(inverter.state)}</strong></div>
      ${capacityMonitoring}${bmsDetails}</div>`;
  }

  _commandText(decision, battery) {
    if (!decision.command_action) return this._t("overview.not_sent");
    const fallbackActions = ["native_self_consumption", "native_schedule", "manual", "ai_optimization"];
    const action = fallbackActions.includes(decision.command_action)
      ? this._fallbackLabel({...battery, disabled_behavior: decision.command_action})
      : this._action(decision.command_action);
    return decision.command_power_w === null || decision.command_power_w === undefined
      ? action : `${action} · ${esc(decision.command_power_w)} W`;
  }

  _fallbackKey(battery) {
    const behavior = battery?.disabled_behavior || "standby";
    if (behavior === "native_self_consumption") {
      return battery?.adapter === "hoymiles_msa2"
        ? "native_self_consumption_hoymiles"
        : "native_self_consumption";
    }
    return behavior;
  }

  _fallbackLabel(battery) {
    return this._t(`fallback.${this._fallbackKey(battery)}`);
  }

  _fallbackOptions(battery) {
    const behaviors = battery.adapter === "hoymiles_msa2"
      ? ["standby", "native_self_consumption", "native_schedule"]
      : ["standby", "native_self_consumption", "manual", "ai_optimization"];
    return behaviors.map((behavior) => {
      const candidate = {...battery, disabled_behavior: behavior};
      return `<option value="${behavior}" ${battery.disabled_behavior===behavior?"selected":""}>${this._fallbackLabel(candidate)}</option>`;
    }).join("");
  }

  _msa2CommandStatus(battery, decision) {
    const state = this._state(battery.entities?.state);
    const key = String(battery.id || battery.name);
    return `<details class="command-status" data-command-device="${esc(key)}" ${this._openCommandSections.has(key)?"open":""}><summary>${this._t("overview.msa2_live_commands")}</summary><div class="command-body">
      <div class="command-row" data-more-info="${esc(battery.entities?.state)}"><span>${this._t("fields.state")}</span><strong>${esc(state.state)}</strong></div>
      <div class="command-row"><span>${this._t("fields.ems_topic")}</span><strong class="mqtt-topic">${esc(battery.mqtt?.mode_topic || "—")}</strong></div>
      <div class="command-row"><span>${this._t("fields.power_topic")}</span><strong class="mqtt-topic">${esc(battery.mqtt?.power_topic || "—")}</strong></div>
      <div class="command-row"><span>${this._t("overview.last_mqtt_mode")}</span><strong>${decision.command_transport === "mqtt" ? esc(decision.command_mqtt_mode || "mqtt_ctrl") : "—"}</strong></div>
      <div class="command-row"><span>${this._t("overview.last_mqtt_power")}</span><strong>${decision.command_transport === "mqtt" && decision.command_power_w !== undefined ? `${esc(decision.command_power_w)} W` : "—"}</strong></div>
    </div></details>`;
  }

  _marstekCommandStatus(battery) {
    const entities = battery.entities || {};
    const key = String(battery.id || battery.name);
    const row = (label, entityId) => {
      const value = this._state(entityId);
      return `<div class="command-row" data-more-info="${esc(entityId)}"><span>${this._t(label)}</span><strong>${esc(value.state)} ${esc(value.unit)}</strong></div>`;
    };
    return `<details class="command-status" data-command-device="${esc(key)}" ${this._openCommandSections.has(key)?"open":""}><summary>${this._t("overview.marstek_live_commands")}</summary><div class="command-body">
      ${row("fields.force_mode", entities.force_mode)}
      ${row("fields.rs485_control_mode", entities.rs485_control_mode)}
      ${row("fields.charge_setpoint", entities.charge_power)}
      ${row("fields.discharge_setpoint", entities.discharge_power)}
      ${row("fields.max_charge", entities.max_charge_power)}
      ${row("fields.max_discharge", entities.max_discharge_power)}
      ${row("fields.user_work_mode", entities.work_mode)}
    </div></details>`;
  }

  _entityDiagnostic(device) {
    const rows = device.entities.map((entity) => {
      const current = this._hass?.states?.[entity.entity_id];
      const problem = !entity.disabled && (!current || current.state === "unavailable" || current.state === "unknown");
      const value = entity.disabled ? this._t("diagnostic.disabled")
        : !current ? this._t("diagnostic.not_loaded")
        : `${current.state}${current.attributes?.unit_of_measurement ? ` ${current.attributes.unit_of_measurement}` : ""}`;
      return { entity, problem, value };
    });
    const problems = rows.filter((row) => row.problem).length;
    const active = rows.filter((row) => !row.entity.disabled).length;
    const isOpen = this._openDiagnostics.has(device.device_id);
    return `<details class="entities" data-device-id="${esc(device.device_id)}" ${isOpen ? "open" : ""}><summary>${this._t("diagnostic.summary", {total:rows.length, active, problems})}</summary>
      <div class="entity-table-wrap"><table class="entity-table"><thead><tr><th>${this._t("diagnostic.entity")}</th><th>${this._t("diagnostic.id")}</th><th>${this._t("diagnostic.state")}</th><th>${this._t("diagnostic.role")}</th></tr></thead><tbody>
      ${rows.map(({entity,problem,value}) => `<tr class="${problem?"problem":""}" data-more-info="${esc(entity.entity_id)}"><td>${esc(entity.short_name || entity.name)}</td><td><code>${esc(entity.entity_id)}</code></td><td class="${problem?"bad":""}">${esc(value)}</td><td>${esc(entity.role || "—")}</td></tr>`).join("")}
      </tbody></table></div></details>`;
  }

  _weatherEditor() {
    const w=this._config.weather||{}, d=this._status.weather||{};
    const profileName=(id)=>(this._config.schedule_profiles||[]).find(p=>p.id===id)?.name||id||"—";
    const conditions=["sunny","partlycloudy","cloudy","fog","windy","windy-variant","rainy","pouring","lightning","lightning-rainy","hail","snowy","snowy-rainy","clear-night"];
    const profileOptions=(selected)=>`<option value="ignore" ${selected==="ignore"?"selected":""}>${this._t("weather.ignore")}</option>${(this._config.schedule_profiles||[]).map(p=>`<option value="${esc(p.id)}" ${selected===p.id?"selected":""}>${esc(p.name)}</option>`).join("")}`;
    return `<div class="card"><h2>${this._t("weather.title")}</h2><div class="weather-top-actions"><button id="refreshWeather">${this._t("weather.refresh_now")}</button><button id="save" class="primary">${this._t("buttons.save")}</button></div><div class="weather-grid">
      <fieldset class="weather-source"><legend>${this._t("weather.source")}</legend><div class="weather-source-pickers">
        <ha-entity-picker data-entity-path="_global.weather.entity_id" data-label="${this._t("weather.entity")}" data-domains="weather" value="${esc(w.entity_id||"")}"></ha-entity-picker>
        <ha-entity-picker data-entity-path="_global.weather.cloud_cover_entity" data-label="${this._t("weather.cloud_entity")}" data-domains="sensor" value="${esc(w.cloud_cover_entity||"")}"></ha-entity-picker>
        </div><p class="muted">${this._t("weather.source_help")}</p></fieldset>
      <fieldset class="weather-analysis"><legend>${this._t("weather.analysis")}</legend><div class="form-grid">
        <label>${this._t("weather.offset")}<input data-path="_global.weather.forecast_offset_h" type="number" min="0" max="24" value="${esc(w.forecast_offset_h??1)}"></label>
        <label>${this._t("weather.refresh")}<input data-path="_global.weather.refresh_minutes" type="number" min="5" max="120" value="${esc(w.refresh_minutes??15)}"></label>
        <label>${this._t("schedule.start")}<input data-path="_global.weather.analysis_start" type="time" value="${esc(w.analysis_start||"06:00")}"></label>
        <label>${this._t("schedule.end")}<input data-path="_global.weather.analysis_end" type="time" value="${esc(w.analysis_end||"22:00")}"></label>
        <label>${this._t("weather.sunny_max")}<input data-path="_global.weather.sunny_cloud_max" type="number" min="0" max="100" value="${esc(w.sunny_cloud_max??40)}"></label>
        <label>${this._t("weather.hysteresis")}<input data-path="_global.weather.cloud_hysteresis" type="number" min="0" max="30" value="${esc(w.cloud_hysteresis??10)}"></label>
        <label>${this._t("weather.rain_threshold")}<input data-path="_global.weather.rain_threshold_mm" type="number" min="0" max="50" step="0.1" value="${esc(w.rain_threshold_mm??0.5)}"></label>
      </div></fieldset>
      <fieldset class="weather-conditions"><legend>${this._t("weather.conditions")}</legend><div class="form-grid">${conditions.map(c=>`<label>${esc(c)}<select data-path="_global.weather.condition_map.${c}">${profileOptions(w.condition_map?.[c])}</select></label>`).join("")}</div></fieldset>
      <fieldset class="weather-diagnostic"><legend>${this._t("weather.diagnostic")}</legend>
        <div class="weather-diagnostic-grid">
          <div class="weather-diagnostic-item">${this._t("weather.available")} : <b>${d.available?this._t("weather.yes"):this._t("weather.no")}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.forecast_time")} : <b>${d.forecast_time?esc(new Date(d.forecast_time).toLocaleString()):"—"}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.condition")} : <b>${esc(d.condition?this._translatedValue("weather.condition_values",d.condition):"—")}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.cloud")} : <b>${d.cloud_coverage==null?"—":`${esc(d.cloud_coverage)} %`}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.cloud_source")} : <b>${esc(d.cloud_source?this._t(`weather.cloud_sources.${d.cloud_source}`):"—")}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.cloud_raw")} : <b>${d.cloud_entity_state==null?"—":esc(d.cloud_entity_state)}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.precipitation")} : <b>${d.precipitation_mm==null?"—":`${esc(d.precipitation_mm)} mm/h`}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.rain_threshold")} : <b>${d.rain_threshold_mm==null?"—":`${esc(d.rain_threshold_mm)} mm/h`}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.calculated_profile")} : <b>${esc(profileName(d.selected_profile))}</b></div>
          <div class="weather-diagnostic-item">${this._t("weather.reason")} : <b>${esc(d.reason?this._reason(d.reason):"—")}</b></div>
        </div>
      </fieldset></div></div>`;
  }

  _batteryEditor() {
    const batteries = this._config.batteries;
    if (!batteries.length) return `<div class="card"><p>${this._t("config.none")}</p><button id="addBattery" class="primary">${this._t("config.add_battery")}</button></div>`;
    const b = batteries[Math.min(this._selected, batteries.length - 1)];
    const e = b.entities, l = b.limits, m = b.mqtt, mv = b.mode_values;
    const field = (label, path, value, type = "text", attributes = "") => {
      const input = `<input aria-label="${esc(label)}" type="${type}" data-path="${path}" value="${esc(value)}" ${attributes}>`;
      return `<label>${label}${type === "number" ? `<span class="number-control"><button type="button" data-step="-1" aria-label="${esc(this._t("controls.decrease",{field:label}))}">−</button>${input}<button type="button" data-step="1" aria-label="${esc(this._t("controls.increase",{field:label}))}">+</button></span>` : input}</label>`;
    };
    const entityField = (label, path, value, domains = []) =>
      `<div class="entity-field"><div class="entity-label" id="entity-label-${esc(path)}">${label}</div><ha-entity-picker data-entity-path="${path}" data-label="${esc(label)}" aria-label="${esc(label)}" aria-labelledby="entity-label-${esc(path)}" data-domains="${domains.join(",")}" value="${esc(value)}" allow-custom-entity></ha-entity-picker></div>`;
    const optionField = (label, path, value, entityId, fallback = []) => {
      const live = this._hass?.states?.[entityId]?.attributes?.options;
      const options = [...new Set([...(Array.isArray(live) ? live : fallback), value].filter(Boolean))];
      if (!options.length) return field(label, path, value);
      return `<label>${label}<select data-path="${path}">${options.map((option) =>
        `<option value="${esc(option)}" ${option===value?"selected":""}>${esc(option)}</option>`).join("")}</select></label>`;
    };
    const marstekDevice = this._marstekDevices.find((item) => item.device_id === b.source_device_id);
    const marstekBox = b.adapter === "marstek_entities" ? `<fieldset><legend>${this._t("sections.marstek_detection")}</legend>
      <div class="form-grid marstek-detection-grid"><label>${this._t("fields.detected_battery")}<select id="marstekDeviceSelect"><option value="">${this._t("fields.choose_battery")}</option>
      ${this._marstekDevices.map((device) => `<option value="${esc(device.device_id)}" ${device.device_id===b.source_device_id?"selected":""}>${esc(device.name)}${device.model?` — ${esc(device.model)}`:""}</option>`).join("")}</select></label>
      <button id="applyMarstekDevice" class="primary">${this._t("buttons.retrieve_entities")}</button><p class="muted detection-status">${marstekDevice ? this._t("config.entities_found", {total:marstekDevice.entities.length, managed:Object.keys(marstekDevice.mapping).length}) : this._t("config.marstek_found", {total:this._marstekDevices.length})}</p></div>
      </fieldset>` : "";
    const marstekCommands = b.adapter === "marstek_entities" ? `<fieldset><legend>${this._t("sections.marstek_commands")}</legend><div class="form-grid">
        ${entityField("User Work Mode", "entities.work_mode", e.work_mode, ["select","input_select"])}${entityField("Force Mode", "entities.force_mode", e.force_mode, ["select","input_select"])}
        ${entityField("RS485 Control Mode", "entities.rs485_control_mode", e.rs485_control_mode, ["switch","input_boolean"])}
        ${entityField(this._t("fields.charge_setpoint"), "entities.charge_power", e.charge_power, ["number","input_number"])}
        ${entityField(this._t("fields.discharge_setpoint"), "entities.discharge_power", e.discharge_power, ["number","input_number"])}${entityField(this._t("fields.max_charge"), "entities.max_charge_power", e.max_charge_power, ["number","input_number"])}
        ${entityField(this._t("fields.max_discharge"), "entities.max_discharge_power", e.max_discharge_power, ["number","input_number"])}
        ${optionField(this._t("fields.manual_value"), "mode_values.manual", mv.manual, e.work_mode, ["Manual","Self Consumption","AI Optimization"])}
        ${optionField(this._t("fields.force_charge_value"), "mode_values.charge", mv.charge, e.force_mode, ["Standby","Charge","Discharge"])}
        ${optionField(this._t("fields.force_discharge_value"), "mode_values.discharge", mv.discharge, e.force_mode, ["Standby","Charge","Discharge"])}
        ${optionField(this._t("fields.force_standby_value"), "mode_values.standby", mv.standby, e.force_mode, ["Standby","Charge","Discharge"])}
        ${optionField(this._t("fields.native_self_consumption_value"), "mode_values.native_self_consumption", mv.native_self_consumption || mv.self_consumption, e.work_mode, ["Manual","Self Consumption","AI Optimization"])}
        ${optionField(this._t("fields.ai_optimization_value"), "mode_values.ai_optimization", mv.ai_optimization || "AI Optimization", e.work_mode, ["Manual","Self Consumption","AI Optimization"])}
      </div></fieldset>` : "";
    const hoymilesCommands = b.adapter === "hoymiles_msa2" ? `<fieldset><legend>${this._t("sections.hoymiles_commands")}</legend><div class="form-grid">
        ${field(this._t("fields.ems_topic"), "mqtt.mode_topic", m.mode_topic)}${field(this._t("fields.power_topic"), "mqtt.power_topic", m.power_topic)}
      </div></fieldset>` : "";
    return `<div class="toolbar config-toolbar"><label>${this._t("fields.battery")}<select id="batterySelect">${batteries.map((x,i)=>`<option value="${i}" ${i===this._selected?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <button id="addBattery">${this._t("buttons.add")}</button><button id="duplicateBattery">${this._t("buttons.duplicate")}</button><button id="deleteBattery" class="danger">${this._t("buttons.delete")}</button>
      <select id="languageSelect" class="language-select" aria-label="${esc(this._t("language.label"))}">${["auto", ...SUPPORTED_LANGUAGES].map((language) => `<option value="${language}" ${this._languageOverride===language?"selected":""}>${this._t(`language.${language}`)}</option>`).join("")}</select>
      <button id="save" class="primary save-right">${this._t("buttons.save")}</button></div>
      <div class="notice">${this._t("config.safety_notice")}</div>
      <section class="card configuration-theme" data-dark="${this._hass?.themes?.darkMode ? "true" : "false"}"><fieldset class="grid-settings"><legend>${this._t("sections.grid")}</legend>
        <div class="illustrated-layout"><div class="section-art">${this._meterGraphic()}</div><div class="section-content">
          <div class="network-picker">${entityField(this._t("fields.grid_power_entity"), "_global.grid_power_entity", this._config.grid_power_entity, ["sensor"])}</div>
          <div class="form-grid network-controls">
          ${field(this._t("fields.grid_zero_correction"), "_global.grid_zero_correction_w", this._config.grid_zero_correction_w ?? 0, "number", 'min="-200" max="200" step="1"')}
          ${field(this._t("fields.deadband"), "_global.deadband_w", this._config.deadband_w, "number", 'min="0" step="1"')}
          ${field(this._t("fields.command_hysteresis"), "_global.command_hysteresis_w", this._config.command_hysteresis_w ?? 30, "number", 'min="0" step="1"')}
          ${field(this._t("fields.control_interval"), "_global.control_interval_s", this._config.control_interval_s, "number", 'min="1" step="1"')}
          <label>${this._t("fields.invert_grid")}<input data-global="grid_power_inverted" type="checkbox" ${this._config.grid_power_inverted?"checked":""}></label>
          </div></div></div></fieldset>
      <fieldset class="general-settings"><legend>${this._t("sections.general")}</legend>
        <div class="illustrated-layout"><div class="section-art model-art">${this._modelGraphic(b)}</div><div class="section-content">
        <div class="form-grid identification-grid">
          <label>${this._t("fields.battery_type")}<select data-path="adapter"><option value="generic" ${b.adapter==="generic"?"selected":""}>${this._t("adapters.generic")}</option><option value="marstek_entities" ${b.adapter==="marstek_entities"?"selected":""}>Marstek</option><option value="hoymiles_msa2" ${b.adapter==="hoymiles_msa2"?"selected":""}>Hoymiles</option></select></label>
          ${field(this._t("fields.name"), "name", b.name)}
          <label>${this._t("fields.model")}<select data-path="model">${(BATTERY_MODELS[b.adapter] || BATTERY_MODELS.generic).map(model=>`<option value="${model.id}" ${(b.model || "generic")===model.id?"selected":""}>${esc(model.label || this._t("adapters.generic"))}</option>`).join("")}</select></label>
          ${["marstek_entities","hoymiles_msa2"].includes(b.adapter) ? `<label>${this._t("fields.disabled_return")}<select data-path="disabled_behavior">${this._fallbackOptions(b)}</select></label>` : ""}
        </div><div class="form-grid general-controls">
          ${field(this._t("fields.capacity"), "capacity_kwh", b.capacity_kwh, "number", 'min="0" step="0.01"')}
          ${field(this._t("fields.charge_compensation"), "charge_compensation_w", b.charge_compensation_w ?? 0, "number", 'min="-200" max="200" step="1"')}
          ${field(this._t("fields.discharge_compensation"), "discharge_compensation_w", b.discharge_compensation_w ?? 0, "number", 'min="-200" max="200" step="1"')}
          ${field(this._t("fields.command_refresh_s"), "command_refresh_s", b.command_refresh_s ?? 60, "number", 'min="0" step="1"')}
        </div>${b.model && b.model!=="generic" ? "" : `<p class="muted model-help">${this._t("config.generic_model_help")}</p>`}
        </div></div>${marstekBox}</fieldset>
      <fieldset><legend>${this._t("sections.info_entities")}</legend><div class="form-grid info-entities-grid">
        <div class="entity-with-option">${entityField(this._t("fields.power"), "entities.power", e.power, ["sensor"])}
          <label>${this._t("fields.invert_power")}<input data-path="power_inverted" type="checkbox" ${b.power_inverted?"checked":""}></label></div>${entityField(this._t("fields.soc"), "entities.soc", e.soc, ["sensor","input_number"])}
        ${entityField(this._t("fields.state"), "entities.state", e.state, ["sensor","select","input_select"])}${entityField(this._t("fields.temperature"), "entities.temperature", e.temperature, ["sensor"])}
        ${entityField(this._t("fields.grid_voltage"), "entities.grid_voltage", e.grid_voltage, ["sensor"])}
        ${b.adapter === "marstek_entities" ? entityField(this._t("fields.backup_function"), "entities.backup_function", e.backup_function, ["switch","input_boolean"]) : ""}
        ${entityField(this._t("fields.ac_current"), "entities.ac_current", e.ac_current, ["sensor"])}
        ${entityField(this._t("fields.dc_voltage"), "entities.dc_voltage", e.dc_voltage, ["sensor"])}
        ${entityField(this._t("fields.dc_current"), "entities.dc_current", e.dc_current, ["sensor"])}
        ${entityField(this._t("fields.dc_power"), "entities.dc_power", e.dc_power, ["sensor"])}
        ${entityField(this._t("fields.total_capacity"), "entities.total_capacity", e.total_capacity, ["sensor"])}
        ${entityField(this._t("fields.charged_today"), "entities.charged_today", e.charged_today, ["sensor"])}
        ${entityField(this._t("fields.discharged_today"), "entities.discharged_today", e.discharged_today, ["sensor"])}
        ${entityField(this._t("fields.cycle_count"), "entities.cycle_count", e.cycle_count, ["sensor"])}
        ${entityField(this._t("fields.cycle_count_calc"), "entities.cycle_count_calc", e.cycle_count_calc, ["sensor"])}
        ${entityField(this._t("fields.max_cell_voltage"), "entities.max_cell_voltage", e.max_cell_voltage, ["sensor"])}
        ${entityField(this._t("fields.min_cell_voltage"), "entities.min_cell_voltage", e.min_cell_voltage, ["sensor"])}
        <label class="grid-recovery-option">${this._t("fields.grid_loss_return_default")}<input data-path="grid_loss_return_default" type="checkbox" ${b.grid_loss_return_default?"checked":""}></label>
        <label class="grid-recovery-option">${this._t("fields.grid_return_resume")}<input data-path="grid_return_resume" type="checkbox" ${b.grid_return_resume?"checked":""} ${b.grid_loss_return_default?"":"disabled"}></label>
      </div></fieldset>
      <fieldset class="compact-section"><legend>${this._t("sections.protection")}</legend><div class="form-grid">
        ${field(this._t("fields.min_soc"), "limits.min_soc", l.min_soc, "number")}${field(this._t("fields.discharge_resume"), "limits.min_soc_resume", l.min_soc_resume, "number")}
        ${field(this._t("fields.max_soc"), "limits.max_soc", l.max_soc, "number")}${field(this._t("fields.charge_resume"), "limits.max_soc_resume", l.max_soc_resume, "number")}
        ${field(this._t("fields.max_charge_w"), "limits.max_charge_w", l.max_charge_w, "number")}${field(this._t("fields.max_discharge_w"), "limits.max_discharge_w", l.max_discharge_w, "number")}
      </div></fieldset>
      ${this._tierEditor(b)}
      ${marstekCommands}${hoymilesCommands}</section>`;
  }

  _alignNetworkPicker() {
    if(this._networkResizeObserver) this._networkResizeObserver.disconnect();
    const content=this.shadowRoot.querySelector(".grid-settings .section-content");
    const picker=content?.querySelector(".network-picker");
    const label=content?.querySelector(".network-controls>label:last-child");
    if(!picker || !label) return;
    const align=()=>{
      const contentBox=content.getBoundingClientRect(), labelBox=label.getBoundingClientRect();
      // On narrow layouts the controls wrap; keep the picker at full width.
      if(contentBox.width<=0) return;
      const columns=getComputedStyle(content.querySelector(".network-controls")).gridTemplateColumns.split(" ").length;
      const width=columns===5 ? Math.max(0,labelBox.right-contentBox.left) : contentBox.width;
      picker.style.width=`${width}px`;
    };
    this._networkResizeObserver=new ResizeObserver(align);
    this._networkResizeObserver.observe(content);
    requestAnimationFrame(align);
  }

  _modelGraphic(b) {
    const model = (BATTERY_MODELS[b.adapter] || BATTERY_MODELS.generic).find(m=>m.id===b.model);
    if (model?.image) return `<img class="battery-product" src="${ASSET_BASE}${model.image}?v=${PANEL_VERSION}" alt="${esc(this._adapter(b.adapter))} ${esc(model.label)}">`;
    return `<svg viewBox="0 0 200 240" role="img" aria-label="${esc(this._t("adapters.generic"))}"><defs><linearGradient id="questionGold" x2="0.4" y2="1"><stop stop-color="#fff3a3"/><stop offset=".45" stop-color="#ffc928"/><stop offset="1" stop-color="#c88d08"/></linearGradient></defs><text x="100" y="190" text-anchor="middle" font-family="Arial,sans-serif" font-size="220" font-weight="bold" fill="url(#questionGold)" stroke="#c49420" stroke-width="2">?</text></svg>`;
  }

  _meterGraphic() {
    const raw = Number(this._state(this._config.grid_power_entity).state);
    const watts = Number.isFinite(raw) ? Math.round(this._config.grid_power_inverted ? -raw : raw) : "—";
    return `<svg viewBox="0 0 220 240" role="img" aria-label="${esc(this._t("overview.network_power"))}"><defs><linearGradient id="meterGlass" x2="1" y2="1"><stop stop-color="#e7f6f8"/><stop offset=".5" stop-color="#a9ced5"/><stop offset="1" stop-color="#5e98a5"/></linearGradient><linearGradient id="meterScreen" x2="0" y2="1"><stop stop-color="#d5eff1"/><stop offset="1" stop-color="#94bbc6"/></linearGradient></defs>
      <rect x="24" y="12" width="146" height="212" rx="23" fill="url(#meterGlass)" stroke="#77a6b0" stroke-width="3"/>
      <rect x="39" y="30" width="116" height="51" rx="7" fill="url(#meterScreen)" stroke="#548794" stroke-width="3"/>
      <text x="97" y="58" fill="#285b69" text-anchor="middle" font-family="monospace" font-size="${String(watts).length>5?18:23}">${esc(watts)}</text><text x="97" y="74" fill="#285b69" text-anchor="middle" font-size="10">W</text>
      <circle cx="96" cy="138" r="41" fill="#d4ebed" stroke="#699eaa" stroke-width="6"/>
      ${Array.from({length:9},(_,i)=>{const a=(i*22.5-180)*Math.PI/180;return `<path d="M ${96+31*Math.cos(a)} ${138+31*Math.sin(a)} L ${96+24*Math.cos(a)} ${138+24*Math.sin(a)}" stroke="#548794" stroke-width="3"/>`;}).join("")}
      <path d="M 88 145 L 120 115 L 102 148 Z" fill="#397483"/><circle cx="96" cy="143" r="7" fill="#548794"/>
      <rect x="43" y="196" width="22" height="9" rx="4" fill="#548794"/><rect x="79" y="196" width="36" height="9" rx="4" fill="#548794"/>
      <rect x="141" y="143" width="65" height="76" rx="14" fill="url(#meterGlass)" stroke="#77a6b0" stroke-width="3"/><path d="M 178 155 L 156 186 H 174 L 164 208 L 191 177 H 175 Z" fill="#548794" stroke="#d4ebed" stroke-width="2"/>
    </svg>`;
  }

  _tierGraphic(b) {
    const colors=["#80afe4","#80c9d0","#54a8b7","#347888","#315c73","#7690a3","#537885","#325567"];
    const soc=Number(this._state(b.entities.soc).state), current=Number.isFinite(soc)?Math.max(0,Math.min(100,soc)):null;
    // Equal display bands keep small SOC ranges legible; the labels carry exact thresholds.
    const tiers=b.charge_tiers || [], h=224/Math.max(1,tiers.length);
    return `<svg class="tier-battery" viewBox="0 0 265 325" role="img" aria-label="${esc(this._t("sections.charge_tiers"))}"><defs><linearGradient id="batteryGlass" x2="1" y2="1"><stop stop-color="#edfafd" stop-opacity=".9"/><stop offset="1" stop-color="#84b9c5" stop-opacity=".45"/></linearGradient><clipPath id="batteryClip"><rect x="29" y="46" width="130" height="224" rx="12"/></clipPath></defs>
      <path d="M 76 29 V 12 Q 76 5 84 5 H 111 Q 119 5 119 12 V 29 H 145 Q 170 29 170 53 V 269 Q 170 286 151 286 H 37 Q 18 286 18 269 V 53 Q 18 29 42 29 Z" fill="url(#batteryGlass)" stroke="#83a9b5" stroke-width="2.5"/>
      <g clip-path="url(#batteryClip)">${tiers.map((t,i)=>`<rect x="29" y="${270-(i+1)*h}" width="130" height="${h}" fill="${colors[i%colors.length]}" opacity="${current!==null && current>=t.from_soc && current<t.to_soc?1:.7}"/>`).join("")}</g>
      <rect x="36" y="48" width="22" height="214" rx="10" fill="white" opacity=".24"/>
      ${tiers.map((t,i)=>`<path d="M 179 ${270-i*h} H 187 V ${270-(i+1)*h} H 179" fill="none" stroke="${colors[i%colors.length]}" stroke-width="4"/><text x="199" y="${270-(i+.5)*h+4}" fill="currentColor" font-size="12">${esc(t.from_soc)}–${esc(t.to_soc)}%</text>`).join("")}
      <text x="94" y="312" text-anchor="middle" fill="currentColor" font-size="16" font-weight="600">SOC ${current===null ? "—" : `${current}%`}</text>
    </svg>`;
  }

  _tierEditor(b) {
    return `<fieldset class="charge-tiers"><legend>${this._t("sections.charge_tiers")}</legend><div class="illustrated-layout"><div class="section-art tier-art">${this._tierGraphic(b)}</div><div class="section-content"><table class="tiers"><thead><tr><th>${this._t("tiers.from")}</th><th>${this._t("tiers.to")}</th><th>${this._t("tiers.maximum")}<br><span class="muted">${this._t("tiers.empty")}</span></th></tr></thead><tbody>
      ${b.charge_tiers.map((t,i)=>`<tr style="--tier-color:${["#80afe4","#80c9d0","#54a8b7","#347888"][i%4]}"><td><input aria-label="${esc(this._t("tiers.from"))} ${i+1}" type="number" min="0" max="100" step="0.1" data-tier="${i}.from_soc" value="${t.from_soc}" ${i>0?"readonly":""}></td><td><input aria-label="${esc(this._t("tiers.to"))} ${i+1}" type="number" min="${t.from_soc}" max="100" step="0.1" data-tier="${i}.to_soc" value="${t.to_soc}"></td><td><input aria-label="${esc(this._t("tiers.maximum"))} ${i+1}" type="number" min="0" data-tier="${i}.max_charge_w" value="${t.max_charge_w ?? ""}" placeholder="${esc(this._t("tiers.auto"))}"></td></tr>`).join("")}
      </tbody></table><div class="tier-save"><button data-save-config class="primary">${this._t("buttons.save")}</button></div></div></div></fieldset>`;
  }

  _scheduleEditor() {
    if (!this._config.batteries.length) return `<div class="card">${this._t("schedule.add_first")}</div>`;
    const selected = this._config.batteries[Math.min(this._selected, this._config.batteries.length - 1)];
    const defaults = this._powerDefaults(selected);
    const range = this._rangeEditor;
    const rangeCharge = range.charge_w ?? defaults.charge_w;
    const rangeDischarge = range.discharge_w ?? defaults.discharge_w;
    const rangeMinSoc = range.min_soc ?? selected.limits.min_soc;
    const rangeMaxSoc = range.max_soc ?? selected.limits.max_soc;
    const days=["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
    const ensure=(battery)=>{ battery.schedules ||= {}; battery.schedules[this._editingProfile] ||= emptyWeek(); return battery.schedules[this._editingProfile]; };
    const toolbar = `<div class="toolbar schedule-toolbar"><label>${this._t("fields.battery")}<select id="batterySelect">${this._config.batteries.map((x,i)=>`<option value="${i}" ${i===this._selected?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label>${this._t("schedule.start")}<input id="rangeStart" type="time" step="900" value="${range.start}"></label><label>${this._t("schedule.end")}<input id="rangeEnd" type="time" step="900" value="${range.end}"></label>
      <label>${this._t("overview.action")}<select id="rangeAction">${Object.keys(ACTIONS).filter((key)=>key!=="native_self_consumption" || selected.adapter==="marstek_entities").map((key)=>`<option value="${key}" ${range.action===key?"selected":""}>${this._action(key)}</option>`).join("")}</select></label>
      <label>${this._t("schedule.max_charge")}<input id="rangeCharge" type="number" value="${rangeCharge}"></label><label>${this._t("schedule.max_discharge")}<input id="rangeDischarge" type="number" value="${rangeDischarge}"></label>
      <label>${this._t("schedule.min_soc")}<input id="rangeMinSoc" type="number" min="0" max="100" step="0.1" value="${rangeMinSoc}"></label><label>${this._t("schedule.max_soc")}<input id="rangeMaxSoc" type="number" min="0" max="100" step="0.1" value="${rangeMaxSoc}"></label>
      <button id="applyRange" class="primary">${this._t("buttons.apply_range")}</button><details class="actions-menu"><summary>${this._t("buttons.actions")} ▾</summary><div class="actions-menu-content"><button data-schedule-action="export">${this._t("schedule.export")}</button><button data-schedule-action="import">${this._t("schedule.import")}</button><button data-schedule-action="duplicate">${this._t("schedule.duplicate_profile")}</button></div></details><input id="importPlanning" type="file" accept="application/json,.json" style="display:none"><button id="save">${this._t("buttons.save")}</button></div>`;
    return `${toolbar}
      <div class="profile-tabs">${(this._config.schedule_profiles||[]).map(p=>`<button data-profile-tab="${esc(p.id)}" class="${this._editingProfile===p.id?"active-edit":""} ${this._status.effective_profile===p.id?"active-run":""}">${esc(p.name)}</button>`).join("")}<button id="newProfile">+ ${this._t("profiles.new")}</button><button id="manageProfile">${this._t("profiles.manage")}</button></div>
      <div class="legend">${Object.entries(ACTIONS).map(([key,value])=>`<span style="--c:${value.color}">${this._action(key)}</span>`).join("")}</div>
      <div class="weekly-wrap">${this._config.batteries.map((battery,batteryIndex)=>{const week=ensure(battery);return `<section class="card weekly-card ${batteryIndex===this._selected?"selected":""}"><div class="schedule-title"><h2>${esc(battery.name)}</h2><span class="muted">${esc(this._adapter(battery.adapter))}</span></div><div class="week-grid">
        <button class="day-head" data-whole-week="${batteryIndex}">↘</button>${days.map((d,day)=>`<button class="day-head" data-day-head="${day}" data-battery-index="${batteryIndex}">${d}</button>`).join("")}
        ${Array.from({length:96},(_,slot)=>`<span class="time-label" data-time-axis="${slot}" data-battery-index="${batteryIndex}">${slot%4===0?String(slot/4).padStart(2,"0")+":00":""}</span>${days.map((_,day)=>{const s=week[day][slot];return `<button class="week-slot ${slot%4===0?"hour":""}" data-battery-index="${batteryIndex}" data-day="${day}" data-slot="${slot}" title="${days[day]} ${String(Math.floor(slot/4)).padStart(2,"0")}:${String(slot%4*15).padStart(2,"0")} — ${this._action(s.action)}" style="background:${ACTIONS[s.action]?.color||"#78909c"}"></button>`}).join("")}`).join("")}
      </div></section>`}).join("")}</div>
      <p class="muted schedule-help">${this._t("schedule.help")}</p>
      <dialog id="rangeDialog"><h3>${this._t("buttons.apply_range")}</h3><div class="form-grid">
        <label>${this._t("overview.action")}<select id="modalAction">${Object.keys(ACTIONS).filter(key=>key!=="native_self_consumption"||selected.adapter==="marstek_entities").map(key=>`<option value="${key}" ${range.action===key?"selected":""}>${this._action(key)}</option>`).join("")}</select></label>
        <label>${this._t("schedule.max_charge")}<input id="modalCharge" type="number" value="${rangeCharge}"></label><label>${this._t("schedule.max_discharge")}<input id="modalDischarge" type="number" value="${rangeDischarge}"></label>
        <label>${this._t("schedule.min_soc")}<input id="modalMinSoc" type="number" min="0" max="100" value="${rangeMinSoc}"></label><label>${this._t("schedule.max_soc")}<input id="modalMaxSoc" type="number" min="0" max="100" value="${rangeMaxSoc}"></label>
      </div><div class="actions"><button id="cancelRangeDialog">${this._t("buttons.cancel")}</button><button id="applyRangeDialog" class="primary">${this._t("buttons.apply_range")}</button></div></dialog>`;
  }

  _powerDefaults(battery) {
    return { charge_w:Number(battery?.limits?.max_charge_w||0), discharge_w:Number(battery?.limits?.max_discharge_w||0) };
  }

  _powerForAction(battery, action) {
    const defaults=this._powerDefaults(battery);
    if(action==="charge"||action==="solar_charge") return {charge_w:defaults.charge_w,discharge_w:0};
    if(action==="discharge") return {charge_w:0,discharge_w:defaults.discharge_w};
    if(action==="self_consumption") return defaults;
    return {charge_w:0,discharge_w:0};
  }

  _setPath(object, path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    let target = object;
    for (const key of parts) target = target[key];
    target[last] = value;
  }

  _bind() {
    const languageSelect = this.shadowRoot.querySelector("#languageSelect");
    if (languageSelect) languageSelect.onchange = async () => {
      this._languageOverride = languageSelect.value;
      try { localStorage.setItem("battery_manager_language", this._languageOverride); } catch (_) { /* Browser storage unavailable. */ }
      await this._loadTranslations();
      this._render();
    };
    this.shadowRoot.querySelectorAll("[data-active-profile]").forEach(button=>button.onclick=async()=>{const profileId=button.dataset.activeProfile;button.disabled=true;try{await this._hass.callWS({type:"battery_manager/set_active_profile",profile_id:profileId});this._config.active_profile=profileId;await this._load();}catch(err){alert(this._t("errors.profile",{details:err?.message||err}));}finally{button.disabled=false;}});
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.onclick = () => {
      this._tab = button.dataset.tab; this._render();
      if (this._tab === "journal") this._loadJournal();
    });
    this.shadowRoot.querySelectorAll("[data-profile-tab]").forEach(button=>button.onclick=()=>{this._captureRangeEditor();this._editingProfile=button.dataset.profileTab;this._render();});
    const newProfile=this.shadowRoot.querySelector("#newProfile");
    if(newProfile) newProfile.onclick=()=>{const name=prompt(this._t("profiles.name_prompt"));if(!name?.trim())return;const id=`custom_${Date.now()}`;this._config.schedule_profiles.push({id,name:name.trim()});for(const battery of this._config.batteries)battery.schedules[id]=structuredClone(battery.schedules[this._editingProfile]||emptyWeek());this._editingProfile=id;this._render();};
    const manageProfile=this.shadowRoot.querySelector("#manageProfile");
    if(manageProfile) manageProfile.onclick=()=>{const profile=this._config.schedule_profiles.find(p=>p.id===this._editingProfile);if(!profile)return;const choice=prompt(`1 - Renommer « ${profile.name} »\n2 - Supprimer ce profil`);if(choice==="1"){const name=prompt(this._t("profiles.name_prompt"),profile.name);if(name?.trim())profile.name=name.trim();}else if(choice==="2"){if(["sunny","cloudy","rainy"].includes(profile.id)){alert("Les trois profils météo de base ne peuvent pas être supprimés.");return;}if(this._config.active_profile===profile.id){alert("Sélectionnez un autre profil actif avant de le supprimer.");return;}if(confirm(`Supprimer le profil « ${profile.name} » ?`)){this._config.schedule_profiles=this._config.schedule_profiles.filter(p=>p.id!==profile.id);for(const battery of this._config.batteries)delete battery.schedules[profile.id];this._editingProfile=this._config.schedule_profiles[0].id;}}this._render();};
    const importInput=this.shadowRoot.querySelector("#importPlanning");
    const refreshWeather=this.shadowRoot.querySelector("#refreshWeather");
    if(refreshWeather) refreshWeather.onclick=async()=>{refreshWeather.disabled=true;try{const result=await this._hass.callWS({type:"battery_manager/refresh_weather"});this._status=result.status||this._status;this._render();}catch(err){alert(this._t("errors.weather_refresh",{details:err?.message||err}));}finally{refreshWeather.disabled=false;}};
    this.shadowRoot.querySelectorAll("[data-schedule-action]").forEach(button=>button.onclick=()=>{const action=button.dataset.scheduleAction;if(action==="export")this._exportPlanning();else if(action==="import")importInput?.click();else if(action==="duplicate")newProfile?.click();});
    if(importInput) importInput.onchange=async()=>{const file=importInput.files?.[0];if(!file)return;try{const data=JSON.parse(await file.text());if(data.schema!=="battery-manager-planning"||!Array.isArray(data.profiles)||!Array.isArray(data.batteries))throw new Error("Format de planification non reconnu");if(!confirm("Remplacer la planification actuelle par le fichier importé ?"))return;this._config.schedule_profiles=data.profiles;for(const imported of data.batteries){const target=this._config.batteries.find(b=>String(b.id)===String(imported.id))||this._config.batteries.find(b=>b.name===imported.name);if(target&&imported.schedules)target.schedules=imported.schedules;}this._editingProfile=this._config.schedule_profiles[0]?.id||"sunny";await this._save();}catch(err){alert(`Import impossible : ${err.message||err}`);}};
    this.shadowRoot.querySelectorAll("details.entities[data-device-id]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (details.open) this._openDiagnostics.add(details.dataset.deviceId);
        else this._openDiagnostics.delete(details.dataset.deviceId);
      });
    });
    this.shadowRoot.querySelectorAll("details.command-status[data-command-device]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (details.open) this._openCommandSections.add(details.dataset.commandDevice);
        else this._openCommandSections.delete(details.dataset.commandDevice);
        this._storeOverviewSections();
      });
    });
    this.shadowRoot.querySelectorAll("details.setpoint-box[data-setpoint-device]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (details.open) this._openSetpointSections.add(details.dataset.setpointDevice);
        else this._openSetpointSections.delete(details.dataset.setpointDevice);
        this._storeOverviewSections();
      });
    });
    this.shadowRoot.querySelectorAll("[data-more-info]").forEach((element) => {
      element.onclick = () => {
        const entityId = element.dataset.moreInfo;
        if (!entityId || !this._hass?.states?.[entityId]) return;
        this.dispatchEvent(new CustomEvent("hass-more-info", {
          bubbles: true, composed: true, detail: { entityId },
        }));
      };
    });
    const select = this.shadowRoot.querySelector("#batterySelect");
    if (select) select.onchange = () => { const action=this.shadowRoot.querySelector("#rangeAction")?.value||"standby";this._selected=Number(select.value);const values=this._powerForAction(this._config.batteries[this._selected],action);this._rangeEditor={...this._rangeEditor,action,...values,min_soc:this._config.batteries[this._selected].limits.min_soc,max_soc:this._config.batteries[this._selected].limits.max_soc};this._render(); };
    const rangeAction=this.shadowRoot.querySelector("#rangeAction");
    if(rangeAction) rangeAction.onchange=()=>{const values=this._powerForAction(this._config.batteries[this._selected],rangeAction.value);this.shadowRoot.querySelector("#rangeCharge").value=values.charge_w;this.shadowRoot.querySelector("#rangeDischarge").value=values.discharge_w;};
    const add = this.shadowRoot.querySelector("#addBattery");
    if (add) add.onclick = () => { const battery=defaultBattery(); battery.name=this._t("config.new_battery"); this._config.batteries.push(battery); this._selected = this._config.batteries.length-1; this._tab="batteries"; this._render(); };
    const duplicate = this.shadowRoot.querySelector("#duplicateBattery");
    if (duplicate) duplicate.onclick = () => { const copy=structuredClone(this._config.batteries[this._selected]); copy.id=crypto.randomUUID(); copy.name += ` ${this._t("config.copy_suffix")}`; copy.enabled=false; copy.operation_mode="disabled"; copy.control_mode="disabled"; this._config.batteries.push(copy); this._selected=this._config.batteries.length-1; this._render(); };
    this.shadowRoot.querySelectorAll("[data-path]").forEach((input) => input.onchange = () => {
      const b=input.dataset.path.startsWith("_global.") ? this._config : this._config.batteries[this._selected];
      let value=input.type==="checkbox" ? input.checked : input.value;
      if(input.type==="number") {
        if(input.value==="" || !input.checkValidity()) { input.reportValidity(); return; }
        value=Number(value);
      }
      this._setPath(b,input.dataset.path.replace("_global.",""),value);
      if(input.dataset.path === "adapter") b.model="generic";
      if(["adapter", "model", "grid_loss_return_default"].includes(input.dataset.path)) this._render();
    });
    this._alignNetworkPicker();
    this.shadowRoot.querySelectorAll("[data-step]").forEach(button=>button.onclick=()=>{
      const input=button.parentElement.querySelector("input");
      if(!input || input.disabled || input.readOnly) return;
      if(Number(button.dataset.step)>0) input.stepUp(); else input.stepDown();
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    this.shadowRoot.querySelectorAll("[data-save-config]").forEach(button=>button.onclick=()=>this._save());
    this.shadowRoot.querySelectorAll("[data-global]").forEach((input) => input.onchange = () => {
      this._config[input.dataset.global]=input.type==="checkbox"?input.checked:input.value;
      if(input.dataset.global==="grid_power_inverted") {
        const meter=this.shadowRoot.querySelector(".grid-settings .section-art");
        if(meter) meter.innerHTML=this._meterGraphic();
      }
    });
    this.shadowRoot.querySelectorAll("[data-quick-mode]").forEach((select) => select.onchange = async () => {
      select.disabled = true;
      try {
        await this._hass.callWS({type:"battery_manager/set_control_mode", battery_id:select.dataset.quickMode, mode:select.value});
        const battery = this._config.batteries.find((item) => String(item.id || item.name) === select.dataset.quickMode);
        if (battery && select.value!=="backup") { battery.control_mode=select.value; battery.enabled=select.value!=="disabled"; battery.operation_mode=battery.enabled?"schedule":"disabled"; }
        await this._refreshStatus();
      } catch(err) {
        alert(this._t("errors.control_mode", {details:err?.message || err}));
        await this._load();
      } finally { select.disabled = false; }
    });
    this.shadowRoot.querySelectorAll("ha-entity-picker[data-entity-path]").forEach((picker) => {
      picker.hass = this._hass;
      picker.label = picker.closest(".entity-field") ? "" : picker.dataset.label; // Configuration uses a centered external label.
      picker.value = picker.getAttribute("value") || "";
      picker.allowCustomEntity = true;
      picker.includeDomains = picker.dataset.domains ? picker.dataset.domains.split(",") : undefined;
      picker.addEventListener("value-changed", (event) => {
        const path = picker.dataset.entityPath;
        const target = path.startsWith("_global.") ? this._config : this._config.batteries[this._selected];
        this._setPath(target, path.replace("_global.", ""), event.detail?.value || "");
      });
    });
    this.shadowRoot.querySelectorAll("[data-tier]").forEach((input) => input.onchange = () => {
      const [index,key]=input.dataset.tier.split(".");
      const tiers=this._config.batteries[this._selected].charge_tiers, tierIndex=Number(index);
      if(key!=="max_charge_w" && input.value==="") {this._render();return;}
      let value=input.value===""?null:Number(input.value);
      if(key==="from_soc") value=Math.max(0,Math.min(tiers[tierIndex].to_soc,value));
      if(key==="max_charge_w" && value!==null) value=Math.max(0,value);
      if(key==="to_soc" && value!==null) value=Math.max(Number(tiers[tierIndex].from_soc||0),Math.min(100,value));
      tiers[tierIndex][key]=value;
      if(key==="to_soc") {
        for(let j=tierIndex+1;j<tiers.length;j++) {
          tiers[j].from_soc=tiers[j-1].to_soc;
          tiers[j].to_soc=Math.max(tiers[j].from_soc,tiers[j].to_soc);
        }
      }
      this._render();
    });
    const del=this.shadowRoot.querySelector("#deleteBattery");
    if(del) del.onclick=async()=>{if(confirm(this._t("confirm.delete"))){this._config.batteries.splice(this._selected,1);this._selected=Math.max(0,this._selected-1);await this._save();}};
    const marstekSelect=this.shadowRoot.querySelector("#marstekDeviceSelect");
    if(marstekSelect) marstekSelect.onchange=()=>this._applyMarstekDevice(marstekSelect.value);
    const marstekApply=this.shadowRoot.querySelector("#applyMarstekDevice");
    if(marstekApply) marstekApply.onclick=()=>this._applyMarstekDevice(this.shadowRoot.querySelector("#marstekDeviceSelect")?.value);
    this.shadowRoot.querySelectorAll("#save").forEach((b)=>b.onclick=()=>this._save());
    const apply=this.shadowRoot.querySelector("#applyRange");
    if(apply) apply.onclick=()=>this._applyRange();
    const dialog=this.shadowRoot.querySelector("#rangeDialog");
    const modalAction=this.shadowRoot.querySelector("#modalAction");if(modalAction)modalAction.onchange=()=>{const values=this._powerForAction(this._config.batteries[this._selected],modalAction.value);this.shadowRoot.querySelector("#modalCharge").value=values.charge_w;this.shadowRoot.querySelector("#modalDischarge").value=values.discharge_w;};
    const cancelDialog=this.shadowRoot.querySelector("#cancelRangeDialog"); if(cancelDialog)cancelDialog.onclick=()=>dialog.close();
    const applyDialog=this.shadowRoot.querySelector("#applyRangeDialog"); if(applyDialog)applyDialog.onclick=()=>{const values={action:this.shadowRoot.querySelector("#modalAction").value,charge_w:Number(this.shadowRoot.querySelector("#modalCharge").value||0),discharge_w:Number(this.shadowRoot.querySelector("#modalDischarge").value||0),min_soc:Number(this.shadowRoot.querySelector("#modalMinSoc").value),max_soc:Number(this.shadowRoot.querySelector("#modalMaxSoc").value)};this.shadowRoot.querySelector("#rangeAction").value=values.action;this.shadowRoot.querySelector("#rangeCharge").value=values.charge_w;this.shadowRoot.querySelector("#rangeDischarge").value=values.discharge_w;this.shadowRoot.querySelector("#rangeMinSoc").value=values.min_soc;this.shadowRoot.querySelector("#rangeMaxSoc").value=values.max_soc;dialog.close();this._applyRange();};
    this._bindWeekSelection();
  }

  _bindWeekSelection() {
    let start=null;
    const cells=[...this.shadowRoot.querySelectorAll(".week-slot")];
    const paint=(end)=>{if(!start||Number(end.dataset.batteryIndex)!==start.battery)return;const d1=Math.min(start.day,Number(end.dataset.day)),d2=Math.max(start.day,Number(end.dataset.day)),s1=Math.min(start.slot,Number(end.dataset.slot)),s2=Math.max(start.slot,Number(end.dataset.slot));cells.forEach(c=>c.classList.toggle("selected",Number(c.dataset.batteryIndex)===start.battery&&Number(c.dataset.day)>=d1&&Number(c.dataset.day)<=d2&&Number(c.dataset.slot)>=s1&&Number(c.dataset.slot)<=s2));};
    cells.forEach(cell=>{cell.onpointerdown=(event)=>{event.preventDefault();start={battery:Number(cell.dataset.batteryIndex),day:Number(cell.dataset.day),slot:Number(cell.dataset.slot)};this._selectScheduleBattery(start.battery);paint(cell);};cell.onpointerenter=()=>{if(start)paint(cell);};cell.onpointerup=()=>{if(!start)return;const selected=cells.filter(c=>c.classList.contains("selected"));this._selectedDays=[...new Set(selected.map(c=>Number(c.dataset.day)))];const slots=selected.map(c=>Number(c.dataset.slot));this._rangeEditor.start=this._slotTime(Math.min(...slots));this._rangeEditor.end=this._slotTime(Math.min(96,Math.max(...slots)+1));start=null;this._render();setTimeout(()=>this.shadowRoot.querySelector("#rangeDialog")?.showModal(),0);};});
    this.shadowRoot.querySelectorAll("[data-day-head]").forEach(h=>h.onclick=()=>{this._selectScheduleBattery(Number(h.dataset.batteryIndex));this._selectedDays=[Number(h.dataset.dayHead)];this._rangeEditor.start="00:00";this._rangeEditor.end="23:59";this._render();});
    this.shadowRoot.querySelectorAll("[data-whole-week]").forEach(h=>h.onclick=()=>{this._selectScheduleBattery(Number(h.dataset.wholeWeek));this._selectedDays=[0,1,2,3,4,5,6];this._rangeEditor.start="00:00";this._rangeEditor.end="23:59";this._render();});
    let axisStart=null;
    this.shadowRoot.querySelectorAll("[data-time-axis]").forEach(h=>{h.onpointerdown=(event)=>{event.preventDefault();axisStart={battery:Number(h.dataset.batteryIndex),slot:Number(h.dataset.timeAxis)};};h.onpointerup=()=>{const finish=Number(h.dataset.timeAxis);this._selectScheduleBattery(Number(h.dataset.batteryIndex));this._selectedDays=[0,1,2,3,4,5,6];this._rangeEditor.start=this._slotTime(Math.min(axisStart?.slot??finish,finish));this._rangeEditor.end=this._slotTime(Math.min(96,Math.max(axisStart?.slot??finish,finish)+4));axisStart=null;this._render();};});
  }

  _selectScheduleBattery(index){if(this._selected===index)return;this._selected=index;const action=this._rangeEditor.action||"standby";this._rangeEditor={...this._rangeEditor,...this._powerForAction(this._config.batteries[index],action),min_soc:this._config.batteries[index].limits.min_soc,max_soc:this._config.batteries[index].limits.max_soc};}

  _slotTime(slot){if(slot>=96)return "24:00";return `${String(Math.floor(slot/4)).padStart(2,"0")}:${String((slot%4)*15).padStart(2,"0")}`;}

  _exportPlanning(){const payload={schema:"battery-manager-planning",version:1,exported_at:new Date().toISOString(),profiles:this._config.schedule_profiles,batteries:this._config.batteries.map(b=>({id:b.id,name:b.name,schedules:b.schedules}))};const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`battery-manager-planning-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);}

  _timeSlot(value) {
    if(value==="24:00"||value==="23:59") return 96; const [h,m]=value.split(":").map(Number); return h*4+Math.floor(m/15);
  }

  _applyMarstekDevice(deviceId) {
    if (!deviceId) return;
    const device = this._marstekDevices.find((item) => item.device_id === deviceId);
    if (!device) return;
    const battery = this._config.batteries[this._selected];
    battery.source_device_id = device.device_id;
    battery.entities = { ...battery.entities, ...device.mapping };
    if (!battery.name || battery.name === "Nouvelle batterie" || battery.name === this._t("config.new_battery")) battery.name = device.name;
    this._render();
  }

  _currentRangeSlot() {
    this._captureRangeEditor();
    return { action:this.shadowRoot.querySelector("#rangeAction").value,
      charge_w:Number(this.shadowRoot.querySelector("#rangeCharge").value||0),
      discharge_w:Number(this.shadowRoot.querySelector("#rangeDischarge").value||0),
      min_soc:Number(this.shadowRoot.querySelector("#rangeMinSoc").value),
      max_soc:Number(this.shadowRoot.querySelector("#rangeMaxSoc").value) };
  }

  _captureRangeEditor() {
    const get = (id) => this.shadowRoot.querySelector(id);
    if (!get("#rangeStart")) return;
    this._rangeEditor = {
      start:get("#rangeStart").value || "00:00",
      end:get("#rangeEnd").value || "00:00",
      action:get("#rangeAction").value,
      charge_w:Number(get("#rangeCharge").value || 0),
      discharge_w:Number(get("#rangeDischarge").value || 0),
      min_soc:Number(get("#rangeMinSoc").value),
      max_soc:Number(get("#rangeMaxSoc").value),
    };
  }

  _cycleSlot(batteryIndex, index) {
    const battery = this._config.batteries[batteryIndex];
    battery.schedules ||= {}; battery.schedules[this._editingProfile] ||= emptyWeek();
    const day=this._selectedDays[0]||0, schedule=battery.schedules[this._editingProfile][day];
    const current = schedule[index]?.action || "standby";
    const order = battery.adapter === "marstek_entities"
      ? ["standby", "charge", "discharge", "self_consumption", "solar_charge", "native_self_consumption", "default_mode"]
      : ["standby", "charge", "discharge", "self_consumption", "solar_charge", "default_mode"];
    const action = order[(order.indexOf(current) + 1) % order.length];
    const defaults = this._powerDefaults(battery);
    schedule[index] = {
      action,
      charge_w: ["charge", "self_consumption", "solar_charge"].includes(action) ? defaults.charge_w : 0,
      discharge_w: action === "discharge" || action === "self_consumption" ? defaults.discharge_w : 0,
      min_soc: battery.limits.min_soc,
      max_soc: battery.limits.max_soc,
    };
    this._render();
  }

  _applyRange() {
    const start=this._timeSlot(this.shadowRoot.querySelector("#rangeStart").value);
    const end=this._timeSlot(this.shadowRoot.querySelector("#rangeEnd").value);
    const slot=this._currentRangeSlot(), battery=this._config.batteries[this._selected];
    battery.schedules ||= {}; battery.schedules[this._editingProfile] ||= emptyWeek();
    const finalEnd=end<=start?96:end;
    for(const day of this._selectedDays){for(let i=start;i<finalEnd;i++)battery.schedules[this._editingProfile][day][i]=structuredClone(slot);}
    this._render();
  }

  async _save() {
    try {
      if(this._config.notifications) this._config.notifications.language=this._locale();
      await this._hass.callWS({type:"battery_manager/save",config:this._config});
      this._hass.callService("persistent_notification","create",{title:this._t("notification.title"),message:this._t("notification.saved"),notification_id:"battery_manager_saved"});
      await this._load();
      return true;
    } catch(err) {
      const details = err?.message || err?.code || (typeof err === "string" ? err : JSON.stringify(err));
      alert(this._t("errors.save", {details:details || this._t("errors.unknown")}));
      return false;
    }
  }
}

customElements.define("battery-manager-panel", BatteryManagerPanel);
