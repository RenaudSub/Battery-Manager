const ACTIONS = {
  charge: { color: "#1976d2" }, discharge: { color: "#ef6c00" },
  self_consumption: { color: "#2e7d32" }, solar_charge: { color: "#f9a825" },
  native_self_consumption: { color: "#8e24aa" },
  default_mode: { color: "#ffffff" },
  standby: { color: "#78909c" },
};
const PANEL_VERSION = "0.3.4";
const SUPPORTED_LANGUAGES = ["fr", "en", "es"];

const emptySlot = () => ({ action: "standby", charge_w: 0, discharge_w: 0, min_soc: null, max_soc: null });
const defaultBattery = () => ({
  id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
  name: "Nouvelle batterie",
  adapter: "generic",
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
    power: "", soc: "", state: "", temperature: "", grid_voltage: "", ac_current: "",
    dc_voltage: "", dc_current: "", dc_power: "", total_capacity: "",
    charged_today: "", discharged_today: "", work_mode: "",
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
    this._languageOverride = this._storedLanguage();
    this._translations = {};
    this._fallbackTranslations = {};
    this._loadedLocale = null;
    this._rangeEditor = { start:"00:00", end:"00:00", action:"charge", charge_w:null, discharge_w:null, min_soc:null, max_soc:null };
  }

  set hass(value) {
    this._hass = value;
    if (!this._loaded) this._load();
    else if (this._languageOverride === "auto" && this._loadedLocale !== this._locale()) {
      this._loadTranslations().then(() => this._render());
    } else if (this._tab === "overview" && !this._overviewControlHasFocus()) this._render();
  }

  set panel(value) { this._panel = value; }

  connectedCallback() {
    this._refreshTimer = setInterval(() => this._refreshStatus(), 10000);
  }

  disconnectedCallback() {
    clearInterval(this._refreshTimer);
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
    return Boolean(active?.matches?.("[data-quick-mode]"));
  }

  async _load() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      const result = await this._hass.callWS({ type: "battery_manager/config" });
      this._config = result.config;
      this._status = result.status || {};
      this._marstekDevices = result.marstek_devices || [];
      for (const battery of this._config.batteries || []) {
        if (battery.adapter !== "marstek_entities" || !battery.source_device_id) continue;
        const device = this._marstekDevices.find((item) => item.device_id === battery.source_device_id);
        if (!device) continue;
        for (const [role, entityId] of Object.entries(device.mapping || {})) {
          if (!battery.entities[role]) battery.entities[role] = entityId;
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
      header { position:sticky; top:0; z-index:3; display:flex; align-items:center; gap:18px; padding:14px 22px;
        background:var(--app-header-background-color, var(--card-background-color)); box-shadow:0 2px 8px #0002; }
      header h1 { font-size:20px; margin:0 auto 0 0; }
      .language-select { min-width:105px; padding:7px; }
      nav button, button { border:0; border-radius:10px; padding:10px 14px; cursor:pointer; color:var(--primary-text-color);
        background:var(--secondary-background-color); font-weight:600; }
      nav button.active, button.primary { color:#fff; background:var(--primary-color); }
      main { max-width:1400px; margin:auto; padding:22px; }
      .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:14px; }
      .card { background:var(--card-background-color); border-radius:16px; padding:18px; box-shadow:var(--ha-card-box-shadow,0 2px 8px #0002); }
      .battery-head { display:flex; align-items:center; gap:12px; }
      .battery-head ha-icon { color:var(--primary-color); width:34px; height:34px; }
      .battery-head h2 { font-size:18px; margin:0; }
      .battery-head { justify-content:space-between; }
      .battery-title { display:flex; align-items:center; gap:10px; min-width:0; }
      .battery-online { font-weight:700; font-size:12px; }
      .online { color:#2e7d32; } .offline,.error { color:#c62828; }
      .quick-control { min-width:155px; padding:7px; font-weight:700; }
      .battery-summary { display:grid; grid-template-columns:94px 1fr; align-items:center; gap:14px; margin:14px 0 4px; }
      .soc-ring { --soc:0; --soc-color:#c62828; width:88px; height:88px; border-radius:50%; display:grid; place-items:center;
        background:
          repeating-conic-gradient(from -0.8deg, #111 0 1.6deg, transparent 1.6deg 36deg),
          conic-gradient(var(--soc-color) calc(var(--soc)*1%), var(--divider-color) 0); }
      .soc-ring::before { content:""; width:66px; height:66px; border-radius:50%; background:var(--card-background-color); grid-area:1/1; }
      .soc-ring strong { grid-area:1/1; z-index:1; font-size:20px; }
      .live-power { font-size:22px; font-weight:800; line-height:1.2; }
      .charging { color:#2e7d32; } .discharging { color:#c62828; } .waiting-power { color:var(--primary-text-color); }
      .section-divider { border-top:1px solid var(--divider-color); margin-top:12px; padding-top:10px; }
      .setpoint-box { font-size:13px; line-height:1.45; }
      .monitor-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px 12px; }
      .monitor-item { display:flex; align-items:center; gap:7px; min-width:0; }
      .monitor-item ha-icon { color:var(--primary-color); width:20px; flex:0 0 20px; }
      .monitor-item span { color:var(--secondary-text-color); font-size:12px; }
      .monitor-item strong { margin-left:auto; text-align:right; }
      .conversion { display:flex; justify-content:space-between; margin-top:9px; font-weight:700; }
      .temperature-line,.capacity-line { display:flex; justify-content:space-between; gap:8px; margin-top:7px; font-size:13px; }
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
      .command-status h3 { font-size:14px; margin:0 0 8px; }
      .command-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:5px 8px; border-radius:8px; }
      .command-row:nth-child(even) { background:var(--secondary-background-color); }
      .command-row span { color:var(--secondary-text-color); font-size:13px; }
      .command-row strong { text-align:right; overflow-wrap:anywhere; }
      .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:end; margin-bottom:16px; }
      .toolbar .save-right { margin-left:auto; }
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
      .entity-with-option { display:grid; gap:8px; }
      .entity-with-option > label { display:flex; flex-direction:row; align-items:center; gap:10px; }
      .legend { display:flex; flex-wrap:wrap; gap:14px; margin:15px 0; }
      .legend span::before { content:""; display:inline-block; width:12px; height:12px; border-radius:3px; margin-right:5px; background:var(--c); }
      .tiers { width:100%; border-collapse:collapse; }
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
      @media(max-width:700px){ header{flex-wrap:wrap} nav{width:100%;display:flex;overflow:auto} main{padding:12px} .grid{grid-template-columns:1fr}.grid-power-card{grid-template-columns:1fr 1.1fr 1fr;padding-left:8px;padding-right:8px}.grid-power-block strong{font-size:15px}.grid-power-now strong{font-size:21px}.grid-power-block:not(.grid-power-now) .muted{display:none} }
    </style>`;
  }

  _render() {
    if (!this._config) return;
    const body = this._tab === "overview" ? this._overview()
      : this._tab === "batteries" ? this._batteryEditor()
      : this._scheduleEditor();
    this.shadowRoot.innerHTML = `${this._styles()}
      <header><ha-icon icon="mdi:battery-charging"></ha-icon><h1>${this._t("title")} v${PANEL_VERSION}</h1>
      <select id="languageSelect" class="language-select" aria-label="${esc(this._t("language.label"))}">
        ${["auto", ...SUPPORTED_LANGUAGES].map((language) => `<option value="${language}" ${this._languageOverride===language?"selected":""}>${this._t(`language.${language}`)}</option>`).join("")}
      </select>
      <nav>
        <button data-tab="overview" class="${this._tab === "overview" ? "active" : ""}">${this._t("tabs.overview")}</button>
        <button data-tab="batteries" class="${this._tab === "batteries" ? "active" : ""}">${this._t("tabs.configuration")}</button>
        <button data-tab="schedule" class="${this._tab === "schedule" ? "active" : ""}">${this._t("tabs.schedule")}</button>
      </nav></header><main>${body}</main>`;
    this._bind();
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
      const decision = this._status.decisions?.[decisionKey] || {};
      const device = this._marstekDevices.find((item) => item.device_id === b.source_device_id);
      const connectivity = this._batteryConnectivity(b);
      const socNumber = Math.max(0, Math.min(100, Number(soc.state) || 0));
      const socColor = socNumber < 30 ? "#c62828" : socNumber < 50 ? "#ef6c00" : "#43a047";
      const powerClass = normalizedPower > 10 ? "charging" : normalizedPower < -10 ? "discharging" : "waiting-power";
      const powerText = !Number.isFinite(normalizedPower) ? "—"
        : normalizedPower > 10 ? `${Math.round(Math.abs(normalizedPower))} W ${this._t("overview.in_charge")}`
        : normalizedPower < -10 ? `${Math.round(Math.abs(normalizedPower))} W ${this._t("overview.in_discharge")}`
        : this._t("control_modes.standby");
      return `<section class="card battery-card"><div class="battery-head"><div class="battery-title"><ha-icon icon="mdi:battery-medium"></ha-icon>
        <div><h2>${esc(b.name)}</h2><div class="battery-online ${connectivity.className}">${this._t("overview.status")} : ${this._t(`overview.${connectivity.label}`)}</div></div></div>
        <label>${this._t("overview.management")}<select class="quick-control" data-quick-mode="${esc(decisionKey)}">${this._controlOptions(b.control_mode || (b.enabled ? "schedule" : "disabled"))}</select></label></div>
        <div class="battery-summary"><div class="soc-ring" style="--soc:${socNumber};--soc-color:${socColor}"><strong>${Number.isFinite(Number(soc.state)) ? `${Math.round(Number(soc.state))}%` : "—"}</strong></div>
        <div class="live-power ${powerClass}">${esc(powerText)}</div></div>
        ${b.adapter === "marstek_entities" ? this._marstekCommandStatus(b) : ""}
        ${b.adapter === "hoymiles_msa2" ? this._msa2CommandStatus(b, decision) : ""}
        <div class="section-divider setpoint-box"><b>${this._t("overview.current_setpoint")}</b><br>
          ${this._t("overview.current_mode")} : ${esc(this._currentModeLabel(b))}<br>
          ${this._t("overview.transmitted_command")} : ${this._commandText(decision, b)}
          ${decision.calculated_command_w !== undefined ? `<br>${this._t("overview.calculated_command")} : ${esc(decision.calculated_command_w)} W · ${this._t("overview.compensation")} : ${decision.compensation_w > 0 ? "+" : ""}${esc(decision.compensation_w)} W` : ""}
          ${decision.command_sent_at ? `<br><span class="muted">${this._t("overview.sent_at")} ${esc(new Date(decision.command_sent_at).toLocaleTimeString())}</span>` : ""}</div>
        ${this._batteryMonitoring(b, normalizedPower, temp, decisionKey)}
        ${device ? this._entityDiagnostic(device) : ""}</section>`;
    }).join("")}</div>`;
  }

  _controlOptions(selected) {
    const modes = ["schedule", "charge", "self_consumption", "native_self_consumption", "solar_charge", "standby", "disabled"];
    return modes.map((mode) => `<option value="${mode}" ${mode===selected?"selected":""}>${this._t(`control_modes.${mode}`)}</option>`).join("");
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

  _currentModeLabel(battery) {
    let mode = battery.control_mode || (battery.enabled ? "schedule" : "disabled");
    if (mode === "schedule") {
      const now = new Date();
      const index = now.getHours() * 4 + Math.floor(now.getMinutes() / 15);
      mode = battery.schedule?.[index]?.action || "standby";
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
    const item = (icon, label, entityId) => { const value=this._state(entityId); return `<div class="monitor-item"><ha-icon icon="${icon}"></ha-icon><span>${label}</span><strong>${esc(value.state)} ${esc(value.unit)}</strong></div>`; };
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
    const detailedMonitoring = battery.adapter === "hoymiles_msa2" ? "" : `<div class="monitor-grid">
      ${item("mdi:sine-wave", "AC V", e.grid_voltage)}${item("mdi:battery-charging", "DC V", e.dc_voltage)}
      ${item("mdi:current-ac", "AC A", e.ac_current)}${item("mdi:current-dc", "DC A", e.dc_current)}
      ${item("mdi:flash", "AC W", e.power)}${item("mdi:flash", "DC W", e.dc_power)}
      </div><div class="conversion"><span>${this._t("overview.conversion")}</span><strong>${conversion}</strong></div>
      <div class="temperature-line"><span>${this._t("fields.temperature")}</span><strong class="${tempClass}">${esc(temperature.state)} ${esc(temperature.unit)}</strong><span class="temp-good">↓ ${daily.min ?? "—"}°C</span><span class="temp-hot">↑ ${daily.max ?? "—"}°C</span></div>`;
    const capacityMonitoring = battery.adapter === "hoymiles_msa2"
      ? `<div class="capacity-line"><span>${this._t("overview.charged_today")} <b>${esc(charged.state)} ${esc(charged.unit)}</b></span><span>${this._t("overview.discharged_today")} <b>${esc(discharged.state)} ${esc(discharged.unit)}</b></span></div>`
      : `<div class="capacity-line"><span>${this._t("overview.total_capacity")} <b>${esc(capacity.state)} ${esc(capacity.unit)}</b></span><span>${this._t("overview.charged_today")} <b>${esc(charged.state)} ${esc(charged.unit)}</b></span><span>${this._t("overview.discharged_today")} <b>${esc(discharged.state)} ${esc(discharged.unit)}</b></span></div>`;
    return `<div class="section-divider ${battery.adapter === "hoymiles_msa2" ? "hoymiles-monitoring" : ""}">${detailedMonitoring}
      <div class="temperature-line inverter-state"><span>${this._t("overview.inverter_status")}</span><strong>${esc(inverter.state)}</strong></div>
      ${capacityMonitoring}</div>`;
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
    return `<div class="command-status"><h3>${this._t("overview.msa2_live_commands")}</h3>
      <div class="command-row"><span>${this._t("fields.state")}</span><strong>${esc(state.state)}</strong></div>
      <div class="command-row"><span>${this._t("fields.ems_topic")}</span><strong class="mqtt-topic">${esc(battery.mqtt?.mode_topic || "—")}</strong></div>
      <div class="command-row"><span>${this._t("fields.power_topic")}</span><strong class="mqtt-topic">${esc(battery.mqtt?.power_topic || "—")}</strong></div>
      <div class="command-row"><span>${this._t("overview.last_mqtt_mode")}</span><strong>${decision.command_transport === "mqtt" ? esc(decision.command_mqtt_mode || "mqtt_ctrl") : "—"}</strong></div>
      <div class="command-row"><span>${this._t("overview.last_mqtt_power")}</span><strong>${decision.command_transport === "mqtt" && decision.command_power_w !== undefined ? `${esc(decision.command_power_w)} W` : "—"}</strong></div>
    </div>`;
  }

  _marstekCommandStatus(battery) {
    const entities = battery.entities || {};
    const row = (label, entityId) => {
      const value = this._state(entityId);
      return `<div class="command-row"><span>${this._t(label)}</span><strong>${esc(value.state)} ${esc(value.unit)}</strong></div>`;
    };
    return `<div class="command-status"><h3>${this._t("overview.marstek_live_commands")}</h3>
      ${row("fields.force_mode", entities.force_mode)}
      ${row("fields.rs485_control_mode", entities.rs485_control_mode)}
      ${row("fields.charge_setpoint", entities.charge_power)}
      ${row("fields.discharge_setpoint", entities.discharge_power)}
      ${row("fields.max_charge", entities.max_charge_power)}
      ${row("fields.max_discharge", entities.max_discharge_power)}
      ${row("fields.user_work_mode", entities.work_mode)}
    </div>`;
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
      ${rows.map(({entity,problem,value}) => `<tr class="${problem?"problem":""}"><td>${esc(entity.short_name || entity.name)}</td><td><code>${esc(entity.entity_id)}</code></td><td class="${problem?"bad":""}">${esc(value)}</td><td>${esc(entity.role || "—")}</td></tr>`).join("")}
      </tbody></table></div></details>`;
  }

  _batteryEditor() {
    const batteries = this._config.batteries;
    if (!batteries.length) return `<div class="card"><p>${this._t("config.none")}</p><button id="addBattery" class="primary">${this._t("config.add_battery")}</button></div>`;
    const b = batteries[Math.min(this._selected, batteries.length - 1)];
    const e = b.entities, l = b.limits, m = b.mqtt, mv = b.mode_values;
    const field = (label, path, value, type = "text", attributes = "") => `<label>${label}<input type="${type}" data-path="${path}" value="${esc(value)}" ${attributes}></label>`;
    const entityField = (label, path, value, domains = []) =>
      `<ha-entity-picker data-entity-path="${path}" data-label="${esc(label)}" data-domains="${domains.join(",")}" value="${esc(value)}" allow-custom-entity></ha-entity-picker>`;
    const optionField = (label, path, value, entityId, fallback = []) => {
      const live = this._hass?.states?.[entityId]?.attributes?.options;
      const options = [...new Set([...(Array.isArray(live) ? live : fallback), value].filter(Boolean))];
      if (!options.length) return field(label, path, value);
      return `<label>${label}<select data-path="${path}">${options.map((option) =>
        `<option value="${esc(option)}" ${option===value?"selected":""}>${esc(option)}</option>`).join("")}</select></label>`;
    };
    const marstekDevice = this._marstekDevices.find((item) => item.device_id === b.source_device_id);
    const marstekBox = b.adapter === "marstek_entities" ? `<fieldset><legend>${this._t("sections.marstek_detection")}</legend>
      <div class="form-grid"><label>${this._t("fields.detected_battery")}<select id="marstekDeviceSelect"><option value="">${this._t("fields.choose_battery")}</option>
      ${this._marstekDevices.map((device) => `<option value="${esc(device.device_id)}" ${device.device_id===b.source_device_id?"selected":""}>${esc(device.name)}${device.model?` — ${esc(device.model)}`:""}</option>`).join("")}</select></label>
      <div><button id="applyMarstekDevice" class="primary">${this._t("buttons.retrieve_entities")}</button><p class="muted">${marstekDevice ? this._t("config.entities_found", {total:marstekDevice.entities.length, managed:Object.keys(marstekDevice.mapping).length}) : this._t("config.marstek_found", {total:this._marstekDevices.length})}</p></div></div>
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
    return `<div class="toolbar"><label>${this._t("fields.battery")}<select id="batterySelect">${batteries.map((x,i)=>`<option value="${i}" ${i===this._selected?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <button id="addBattery">${this._t("buttons.add")}</button><button id="duplicateBattery">${this._t("buttons.duplicate")}</button><button id="deleteBattery" class="danger">${this._t("buttons.delete")}</button><button id="save" class="primary save-right">${this._t("buttons.save")}</button></div>
      <div class="notice">${this._t("config.safety_notice")}</div>
      <section class="card"><fieldset><legend>${this._t("sections.grid")}</legend><div class="form-grid">
        ${entityField(this._t("fields.grid_power_entity"), "_global.grid_power_entity", this._config.grid_power_entity, ["sensor"])}
        ${field(this._t("fields.grid_zero_correction"), "_global.grid_zero_correction_w", this._config.grid_zero_correction_w ?? 0, "number", 'min="-200" max="200" step="1"')}
        ${field(this._t("fields.deadband"), "_global.deadband_w", this._config.deadband_w, "number")}
        ${field(this._t("fields.command_hysteresis"), "_global.command_hysteresis_w", this._config.command_hysteresis_w ?? 30, "number")}
        ${field(this._t("fields.control_interval"), "_global.control_interval_s", this._config.control_interval_s, "number")}
        <label>${this._t("fields.invert_grid")}<input data-global="grid_power_inverted" type="checkbox" ${this._config.grid_power_inverted?"checked":""}></label>
      </div></fieldset><fieldset><legend>${this._t("sections.general")}</legend><div class="form-grid">
        ${field(this._t("fields.name"), "name", b.name)}${field(this._t("fields.capacity"), "capacity_kwh", b.capacity_kwh, "number")}
        ${field(this._t("fields.charge_compensation"), "charge_compensation_w", b.charge_compensation_w ?? 0, "number", 'min="-200" max="200" step="1"')}
        ${field(this._t("fields.discharge_compensation"), "discharge_compensation_w", b.discharge_compensation_w ?? 0, "number", 'min="-200" max="200" step="1"')}
        <label>${this._t("fields.battery_type")}<select data-path="adapter"><option value="generic" ${b.adapter==="generic"?"selected":""}>${this._t("adapters.generic")}</option><option value="marstek_entities" ${b.adapter==="marstek_entities"?"selected":""}>Marstek</option><option value="hoymiles_msa2" ${b.adapter==="hoymiles_msa2"?"selected":""}>Hoymiles</option></select></label>
        ${field(this._t("fields.command_refresh_s"), "command_refresh_s", b.command_refresh_s ?? 60, "number")}
        ${["marstek_entities","hoymiles_msa2"].includes(b.adapter) ? `<label>${this._t("fields.disabled_return")}<select data-path="disabled_behavior">${this._fallbackOptions(b)}</select></label>` : ""}
      </div></fieldset>${marstekBox}
      <fieldset><legend>${this._t("sections.info_entities")}</legend><div class="form-grid">
        <div class="entity-with-option">${entityField(this._t("fields.power"), "entities.power", e.power, ["sensor"])}
          <label>${this._t("fields.invert_power")}<input data-path="power_inverted" type="checkbox" ${b.power_inverted?"checked":""}></label></div>${entityField(this._t("fields.soc"), "entities.soc", e.soc, ["sensor","input_number"])}
        ${entityField(this._t("fields.state"), "entities.state", e.state, ["sensor","select","input_select"])}${entityField(this._t("fields.temperature"), "entities.temperature", e.temperature, ["sensor"])}
        ${entityField(this._t("fields.grid_voltage"), "entities.grid_voltage", e.grid_voltage, ["sensor"])}
        ${entityField(this._t("fields.ac_current"), "entities.ac_current", e.ac_current, ["sensor"])}
        ${entityField(this._t("fields.dc_voltage"), "entities.dc_voltage", e.dc_voltage, ["sensor"])}
        ${entityField(this._t("fields.dc_current"), "entities.dc_current", e.dc_current, ["sensor"])}
        ${entityField(this._t("fields.dc_power"), "entities.dc_power", e.dc_power, ["sensor"])}
        ${entityField(this._t("fields.total_capacity"), "entities.total_capacity", e.total_capacity, ["sensor"])}
        ${entityField(this._t("fields.charged_today"), "entities.charged_today", e.charged_today, ["sensor"])}
        ${entityField(this._t("fields.discharged_today"), "entities.discharged_today", e.discharged_today, ["sensor"])}
        <label>${this._t("fields.grid_loss_return_default")}<input data-path="grid_loss_return_default" type="checkbox" ${b.grid_loss_return_default?"checked":""}></label>
        <label>${this._t("fields.grid_return_resume")}<input data-path="grid_return_resume" type="checkbox" ${b.grid_return_resume?"checked":""} ${b.grid_loss_return_default?"":"disabled"}></label>
      </div></fieldset>
      <fieldset><legend>${this._t("sections.protection")}</legend><div class="form-grid">
        ${field(this._t("fields.min_soc"), "limits.min_soc", l.min_soc, "number")}${field(this._t("fields.discharge_resume"), "limits.min_soc_resume", l.min_soc_resume, "number")}
        ${field(this._t("fields.max_soc"), "limits.max_soc", l.max_soc, "number")}${field(this._t("fields.charge_resume"), "limits.max_soc_resume", l.max_soc_resume, "number")}
        ${field(this._t("fields.max_charge_w"), "limits.max_charge_w", l.max_charge_w, "number")}${field(this._t("fields.max_discharge_w"), "limits.max_discharge_w", l.max_discharge_w, "number")}
      </div></fieldset>
      ${this._tierEditor(b)}
      ${marstekCommands}${hoymilesCommands}</section>`;
  }

  _tierEditor(b) {
    return `<fieldset><legend>${this._t("sections.charge_tiers")}</legend><table class="tiers"><thead><tr><th>${this._t("tiers.from")}</th><th>${this._t("tiers.to")}</th><th>${this._t("tiers.maximum")}<br><span class="muted">${this._t("tiers.empty")}</span></th></tr></thead><tbody>
      ${b.charge_tiers.map((t,i)=>`<tr><td><input type="number" data-tier="${i}.from_soc" value="${t.from_soc}" ${i>0?"readonly":""}></td><td><input type="number" data-tier="${i}.to_soc" value="${t.to_soc}"></td><td><input type="number" data-tier="${i}.max_charge_w" value="${t.max_charge_w ?? ""}"></td></tr>`).join("")}
      </tbody></table></fieldset>`;
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
    const toTime = (slot) => `${String(Math.floor(slot/4)).padStart(2,"0")}:${String((slot%4)*15).padStart(2,"0")}`;
    return `<div class="toolbar"><label>${this._t("fields.battery")}<select id="batterySelect">${this._config.batteries.map((x,i)=>`<option value="${i}" ${i===this._selected?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label>${this._t("schedule.start")}<input id="rangeStart" type="time" step="900" value="${range.start}"></label><label>${this._t("schedule.end")}<input id="rangeEnd" type="time" step="900" value="${range.end}"></label>
      <label>${this._t("overview.action")}<select id="rangeAction">${Object.keys(ACTIONS).filter((key)=>key!=="native_self_consumption" || selected.adapter==="marstek_entities").map((key)=>`<option value="${key}" ${range.action===key?"selected":""}>${this._action(key)}</option>`).join("")}</select></label>
      <label>${this._t("schedule.max_charge")}<input id="rangeCharge" type="number" value="${rangeCharge}"></label><label>${this._t("schedule.max_discharge")}<input id="rangeDischarge" type="number" value="${rangeDischarge}"></label>
      <label>${this._t("schedule.min_soc")}<input id="rangeMinSoc" type="number" min="0" max="100" step="0.1" value="${rangeMinSoc}"></label><label>${this._t("schedule.max_soc")}<input id="rangeMaxSoc" type="number" min="0" max="100" step="0.1" value="${rangeMaxSoc}"></label>
      <button id="applyRange" class="primary">${this._t("buttons.apply_range")}</button><button id="save">${this._t("buttons.save")}</button></div>
      <div class="legend">${Object.entries(ACTIONS).map(([key,value])=>`<span style="--c:${value.color}">${this._action(key)}</span>`).join("")}</div>
      <div class="schedule-stack">${this._config.batteries.map((battery,batteryIndex)=>`<section class="card schedule-card ${batteryIndex===this._selected?"selected":""}">
        <div class="schedule-title"><h2>${esc(battery.name)} — ${this._t("schedule.daily")}</h2><span class="muted">${esc(this._adapter(battery.adapter))}</span></div>
        <div class="schedule-scroll"><div class="hours">${Array.from({length:24},(_,i)=>`<span>${String(i).padStart(2,"0")}h</span>`).join("")}</div>
        <div class="schedule">${battery.schedule.map((slot,i)=>`<button class="slot ${i%4===0?"hour":""}" data-battery-index="${batteryIndex}" data-slot="${i}" title="${toTime(i)} — ${this._action(slot.action)} — ${this._t("actions.charge")} ${slot.charge_w} W / ${this._t("actions.discharge")} ${slot.discharge_w} W — SOC ${slot.min_soc ?? battery.limits.min_soc}%–${slot.max_soc ?? battery.limits.max_soc}%" style="background:${ACTIONS[slot.action]?.color || "#78909c"}"></button>`).join("")}</div></div>
      </section>`).join("")}</div>
      <p class="muted">${this._t("schedule.help")}</p>`;
  }

  _powerDefaults(battery) {
    if (battery?.adapter === "marstek_entities") return { charge_w:2500, discharge_w:800 };
    if (battery?.adapter === "hoymiles_msa2") return { charge_w:1000, discharge_w:800 };
    return { charge_w:0, discharge_w:0 };
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
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.onclick = () => {
      this._tab = button.dataset.tab; this._render();
    });
    this.shadowRoot.querySelectorAll("details.entities[data-device-id]").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (details.open) this._openDiagnostics.add(details.dataset.deviceId);
        else this._openDiagnostics.delete(details.dataset.deviceId);
      });
    });
    const select = this.shadowRoot.querySelector("#batterySelect");
    if (select) select.onchange = () => { this._captureRangeEditor(); this._selected = Number(select.value); this._render(); };
    const add = this.shadowRoot.querySelector("#addBattery");
    if (add) add.onclick = () => { const battery=defaultBattery(); battery.name=this._t("config.new_battery"); this._config.batteries.push(battery); this._selected = this._config.batteries.length-1; this._tab="batteries"; this._render(); };
    const duplicate = this.shadowRoot.querySelector("#duplicateBattery");
    if (duplicate) duplicate.onclick = () => { const copy=structuredClone(this._config.batteries[this._selected]); copy.id=crypto.randomUUID(); copy.name += ` ${this._t("config.copy_suffix")}`; copy.enabled=false; copy.operation_mode="disabled"; copy.control_mode="disabled"; this._config.batteries.push(copy); this._selected=this._config.batteries.length-1; this._render(); };
    this.shadowRoot.querySelectorAll("[data-path]").forEach((input) => input.onchange = () => {
      const b=input.dataset.path.startsWith("_global.") ? this._config : this._config.batteries[this._selected];
      let value=input.type==="checkbox" ? input.checked : input.value;
      if(input.type==="number") value=Number(value);
      this._setPath(b,input.dataset.path.replace("_global.",""),value);
      if(["adapter", "grid_loss_return_default"].includes(input.dataset.path)) this._render();
    });
    this.shadowRoot.querySelectorAll("[data-global]").forEach((input) => input.onchange = () => {
      this._config[input.dataset.global]=input.type==="checkbox"?input.checked:input.value;
    });
    this.shadowRoot.querySelectorAll("[data-quick-mode]").forEach((select) => select.onchange = async () => {
      select.disabled = true;
      try {
        await this._hass.callWS({type:"battery_manager/set_control_mode", battery_id:select.dataset.quickMode, mode:select.value});
        const battery = this._config.batteries.find((item) => String(item.id || item.name) === select.dataset.quickMode);
        if (battery) { battery.control_mode=select.value; battery.enabled=select.value!=="disabled"; battery.operation_mode=battery.enabled?"schedule":"disabled"; }
        await this._refreshStatus();
      } catch(err) {
        alert(this._t("errors.control_mode", {details:err?.message || err}));
        await this._load();
      } finally { select.disabled = false; }
    });
    this.shadowRoot.querySelectorAll("ha-entity-picker[data-entity-path]").forEach((picker) => {
      picker.hass = this._hass;
      picker.label = picker.dataset.label;
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
      let value=input.value===""?null:Number(input.value);
      if(key==="to_soc" && value!==null) value=Math.max(Number(tiers[tierIndex].from_soc||0),Math.min(100,value));
      tiers[tierIndex][key]=value;
      if(key==="to_soc" && tiers[tierIndex+1]) {
        tiers[tierIndex+1].from_soc=value;
        this._render();
      }
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
    this.shadowRoot.querySelectorAll("[data-slot][data-battery-index]").forEach((button)=>button.onclick=()=>this._cycleSlot(Number(button.dataset.batteryIndex),Number(button.dataset.slot)));
  }

  _timeSlot(value) {
    const [h,m]=value.split(":").map(Number); return h*4+Math.floor(m/15);
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
    const current = battery.schedule[index]?.action || "standby";
    const order = battery.adapter === "marstek_entities"
      ? ["standby", "charge", "discharge", "self_consumption", "solar_charge", "native_self_consumption", "default_mode"]
      : ["standby", "charge", "discharge", "self_consumption", "solar_charge", "default_mode"];
    const action = order[(order.indexOf(current) + 1) % order.length];
    const defaults = this._powerDefaults(battery);
    battery.schedule[index] = {
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
    const slot=this._currentRangeSlot(), schedule=this._config.batteries[this._selected].schedule;
    let i=start;
    do { schedule[i]=structuredClone(slot); i=(i+1)%96; } while(i!==end && i!==start);
    this._render();
  }

  async _save() {
    try {
      await this._hass.callWS({type:"battery_manager/save",config:this._config});
      this._hass.callService("persistent_notification","create",{title:this._t("notification.title"),message:this._t("notification.saved"),notification_id:"battery_manager_saved"});
      await this._load();
    } catch(err) {
      const details = err?.message || err?.code || (typeof err === "string" ? err : JSON.stringify(err));
      alert(this._t("errors.save", {details:details || this._t("errors.unknown")}));
    }
  }
}

customElements.define("battery-manager-panel", BatteryManagerPanel);
