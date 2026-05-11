/**
 * PLK Rail Card
 * Lovelace custom card for PLK OpenData railway departures.
 *
 * Data source: https://pdp-api.plk-sa.pl/api/v1
 */

const PLK_API_BASE = "https://pdp-api.plk-sa.pl/api/v1";
const CARD_VERSION = "2.0.0";
const LOCAL_CACHE_PREFIX = "plk-rail-card:";
const STATION_CACHE_TTL = 24 * 60 * 60 * 1000;
const CARRIER_CACHE_TTL = 24 * 60 * 60 * 1000;
const STATION_CARRIER_CACHE_TTL = 6 * 60 * 60 * 1000;
const LAST_GOOD_CACHE_TTL = 30 * 60 * 1000;
const QUICK_STATIONS = [
  { id: "38851", name: "Gdańsk Wrzeszcz" },
  { id: "38844", name: "Gdańsk Główny" },
  { id: "33607", name: "Sopot" },
  { id: "33506", name: "Gdynia Główna" },
  { id: "33615", name: "Gdańsk Oliwa" },
];
const API_LIMIT_PROFILES = {
  basic: { label: "Basic", hourly: 100, daily: 1000 },
  standard: { label: "Standard", hourly: 500, daily: 5000 },
  premium: { label: "Premium", hourly: 2000, daily: 20000 },
  custom: { label: "Custom", hourly: 100, daily: 1000 },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function clampNumber(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalNumber(value, min, max, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  return clampNumber(value, min, max, fallback);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function normalizeDisplayPreset(config) {
  const preset = String(config.display_preset || "").toLowerCase();
  if (["standard", "compact", "e_ink", "next"].includes(preset)) return preset;
  if (config.e_ink_mode === true) return "e_ink";
  if (config.compact_mode === true) return "compact";
  return "standard";
}

function presetDefaults(preset) {
  const value = String(preset || "custom").toLowerCase();
  const presets = {
    custom: {},
    skm_city: {
      brand_preset: "skm",
      board_mode: "departures",
      train_scope: "regional",
      cancelled_mode: "bottom",
      max_departures: 8,
      show_carrier_name: true,
      show_disruptions: true,
    },
    long_distance: {
      brand_preset: "ic",
      train_scope: "long_distance",
      max_departures: 6,
      cancelled_mode: "bottom",
      show_carrier_name: true,
      show_disruptions: true,
    },
    e_ink_station_board: {
      display_preset: "e_ink",
      brand_preset: "neutral",
      max_departures: 8,
      e_ink_refresh_interval: 900,
      show_footer: true,
      show_disruptions: false,
    },
    next_train: {
      display_preset: "next",
      brand_preset: "skm",
      max_departures: 1,
      show_footer: false,
      cancelled_mode: "hide",
    },
  };
  return presets[value] || presets.custom;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || "").toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeApiLimitMode(value) {
  const mode = String(value || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(API_LIMIT_PROFILES, mode) ? mode : "basic";
}

function limitProfileForConfig(config) {
  const mode = normalizeApiLimitMode(config.api_limit_mode);
  const defaults = API_LIMIT_PROFILES[mode];
  return {
    mode,
    label: defaults.label,
    hourly: mode === "custom" ? clampNumber(config.api_limit_hourly, 1, 100000, defaults.hourly) : defaults.hourly,
    daily: mode === "custom" ? clampNumber(config.api_limit_daily, 1, 1000000, defaults.daily) : defaults.daily,
  };
}

function minRefreshIntervalForLimits(config) {
  const profile = limitProfileForConfig(config);
  const keyClients = clampNumber(config.api_key_clients, 1, 50, 1);
  const safety = clampNumber(config.api_limit_safety, 50, 100, 85) / 100;
  const hourlyBudget = Math.max(1, Math.floor(profile.hourly * safety));
  const dailyBudget = Math.max(1, Math.floor(profile.daily * safety));
  const requestsPerRefresh = 2 + (config.show_disruptions ? 1 : 0);
  const callsPerRefreshAcrossKey = requestsPerRefresh * keyClients;
  const hourlyInterval = Math.ceil((3600 * callsPerRefreshAcrossKey) / hourlyBudget);
  const dailyInterval = Math.ceil((86400 * callsPerRefreshAcrossKey) / dailyBudget);
  return Math.max(60, hourlyInterval, dailyInterval);
}

function effectiveRefreshInterval(config, eInk = false) {
  const requested = eInk ? config.e_ink_refresh_interval : config.refresh_interval;
  return Math.max(requested, minRefreshIntervalForLimits(config));
}

function normalizeConfig(config = {}) {
  config = { ...presetDefaults(config.preset), ...config };
  const displayPreset = normalizeDisplayPreset(config);
  const limitProfile = limitProfileForConfig(config);
  const normalized = {
    ...config,
    api_key: String(config.api_key || "").trim(),
    proxy_url: String(config.proxy_url || "/api/plk_rail_card").trim(),
    direct_api: config.direct_api === true,
    mock_data: config.mock_data === true,
    preset: normalizeEnum(config.preset, ["custom", "skm_city", "long_distance", "e_ink_station_board", "next_train"], "custom"),
    brand_preset: normalizeEnum(config.brand_preset, ["plk", "skm", "regio", "ic", "neutral"], "plk"),
    board_mode: normalizeEnum(config.board_mode, ["departures", "arrivals", "both"], "departures"),
    train_scope: normalizeEnum(config.train_scope, ["all", "regional", "long_distance"], "all"),
    cancelled_mode: config.show_cancelled === false
      ? "hide"
      : normalizeEnum(config.cancelled_mode, ["show", "hide", "bottom"], "show"),
    station_id: config.station_id === undefined || config.station_id === null ? "" : String(config.station_id).trim(),
    station_name: String(config.station_name || "").trim(),
    display_preset: displayPreset,
    max_departures: clampNumber(config.max_departures, 3, 30, 8),
    refresh_interval: clampNumber(config.refresh_interval, 60, 1800, 240),
    e_ink_refresh_interval: clampNumber(config.e_ink_refresh_interval, 300, 7200, 600),
    api_limit_mode: limitProfile.mode,
    api_limit_hourly: limitProfile.hourly,
    api_limit_daily: limitProfile.daily,
    api_key_clients: clampNumber(config.api_key_clients, 1, 50, 1),
    api_limit_safety: clampNumber(config.api_limit_safety, 50, 100, 85),
    max_minutes_ahead: optionalNumber(config.max_minutes_ahead, 0, 1440, 0),
    show_delays: config.show_delays !== false,
    show_platform: config.show_platform !== false,
    show_carrier_name: config.show_carrier_name === true,
    show_disruptions: config.show_disruptions === true,
    show_cancelled: config.show_cancelled !== false,
    show_footer: config.show_footer !== false,
    realtime_only: config.realtime_only === true,
    carriers_include: normalizeList(config.carriers_include),
    carriers_exclude: normalizeList(config.carriers_exclude),
    destination_filter: normalizeList(config.destination_filter),
  };

  normalized.e_ink_mode = displayPreset === "e_ink";
  normalized.compact_mode = displayPreset === "compact";
  normalized.next_mode = displayPreset === "next";
  if (normalized.next_mode) normalized.max_departures = 1;

  return normalized;
}

function serializeConfig(config) {
  const output = { ...config };
  delete output.e_ink_mode;
  delete output.compact_mode;
  delete output.next_mode;
  delete output.show_cancelled;
  if (!output.carriers_include?.length) delete output.carriers_include;
  if (!output.carriers_exclude?.length) delete output.carriers_exclude;
  if (!output.destination_filter?.length) delete output.destination_filter;
  if (!output.station_name) delete output.station_name;
  return output;
}

function todayString(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseRailDateTime(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date;
  return null;
}

function parseDurationToMinutes(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();

  const iso = text.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) {
    return (Number.parseInt(iso[1] || "0", 10) * 60) + Number.parseInt(iso[2] || "0", 10);
  }

  const dayTime = text.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dayTime) {
    const days = Number.parseInt(dayTime[1] || "0", 10);
    const hours = Number.parseInt(dayTime[2], 10);
    const minutes = Number.parseInt(dayTime[3], 10);
    return (days * 24 * 60) + (hours * 60) + minutes;
  }

  return null;
}

function combineDateAndDuration(dateString, duration, dayOffset = 0) {
  const minutes = parseDurationToMinutes(duration);
  if (minutes === null) return null;

  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + Number.parseInt(dayOffset || 0, 10));
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

function formatHHMM(date) {
  if (!date) return "--:--";
  return date.toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMinutesUntil(date) {
  if (!date) return "";
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (minutes <= 0) return "teraz";
  if (minutes < 60) return `za ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `za ${h}h ${m}min` : `za ${h}h`;
}

function readLocalCache(key, ttl) {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(`${LOCAL_CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.timestamp || Date.now() - parsed.timestamp > ttl) return null;
    return parsed.value;
  } catch (_) {
    return null;
  }
}

function writeLocalCache(key, value) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${LOCAL_CACHE_PREFIX}${key}`, JSON.stringify({
      timestamp: Date.now(),
      value,
    }));
  } catch (_) {
    // Cache is an optimization only.
  }
}

function hashString(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function scopedCacheKey(config, key) {
  const keyHash = config?.api_key ? hashString(config.api_key) : "nokey";
  return `${keyHash}:${key}`;
}

function lastGoodCacheKey(config) {
  return scopedCacheKey(config, `last-good:${config.station_id || "none"}`);
}

function serializeDeparturesForCache(departures) {
  return departures.map(dep => ({
    ...dep,
    time: dep.time instanceof Date ? dep.time.toISOString() : dep.time,
    plannedTime: dep.plannedTime instanceof Date ? dep.plannedTime.toISOString() : dep.plannedTime,
  }));
}

function restoreDeparturesFromCache(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(dep => ({
    ...dep,
    time: parseRailDateTime(dep.time),
    plannedTime: parseRailDateTime(dep.plannedTime),
  })).filter(dep => dep.time);
}

function readRecentStations() {
  const recent = readLocalCache("recent-stations", 365 * 24 * 60 * 60 * 1000);
  return Array.isArray(recent) ? recent.slice(0, 6) : [];
}

function rememberStation(station) {
  if (!station?.id || !station?.name) return;
  const recent = readRecentStations().filter(item => String(item.id) !== String(station.id));
  recent.unshift({ id: String(station.id), name: String(station.name) });
  writeLocalCache("recent-stations", recent.slice(0, 6));
}

function trainKey(scheduleId, orderId, operatingDate) {
  return `${scheduleId ?? ""}|${orderId ?? ""}|${operatingDate ?? ""}`;
}

function statusLabel(status) {
  const labels = {
    S: "Nie ruszył",
    P: "W trasie",
    C: "Zakończony",
    X: "Odwołany",
    Q: "Częściowo odwołany",
  };
  return labels[status] || status || "";
}

function getHomeAssistantAuthHeader() {
  try {
    const tokens = JSON.parse(localStorage.getItem("hassTokens") || "{}");
    return tokens.access_token ? `Bearer ${tokens.access_token}` : "";
  } catch (_) {
    return "";
  }
}

function categoryClass(category, carrier) {
  const value = `${category || ""} ${carrier || ""}`.toUpperCase();
  if (value.includes("SKM")) return "skm";
  if (value.includes("PKM") || value.includes("REG") || value.includes("POLREGIO") || value.includes("PR")) return "pkm";
  if (value.includes("IC") || value.includes("TLK") || value.includes("EIC")) return "ic";
  return "rail";
}

function trainScope(category, carrier) {
  const value = `${category || ""} ${carrier || ""}`.toUpperCase();
  if (/IC|EIC|EIP|TLK|INT|EC|EN|EX/.test(value)) return "long_distance";
  return "regional";
}

function matchesDestinationFilter(departure, filters) {
  if (!filters?.length) return true;
  const haystack = `${departure.destination || ""} ${departure.origin || ""}`.toLocaleLowerCase("pl-PL");
  return filters.some(filter => haystack.includes(String(filter).toLocaleLowerCase("pl-PL")));
}

function passesDepartureFilters(departure, config) {
  if (config.realtime_only && !departure.isRealtime) return false;
  if (config.cancelled_mode === "hide" && departure.isCancelled) return false;
  if (config.train_scope !== "all" && departure.scope !== config.train_scope) return false;
  if (!matchesDestinationFilter(departure, config.destination_filter)) return false;
  return true;
}

async function plkFetch(path, config, params = {}) {
  if (config.direct_api && !config.api_key) throw new Error("Brak klucza API PLK w konfiguracji.");

  const base = config.direct_api
    ? PLK_API_BASE
    : (config.proxy_url || "/api/plk_rail_card").replace(/\/$/, "");
  const url = new URL(`${base}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const headers = { "Content-Type": "application/json" };
  if (config.api_key) headers[config.direct_api ? "X-API-Key" : "X-PLK-API-Key"] = config.api_key;
  const authHeader = config.direct_api ? "" : getHomeAssistantAuthHeader();
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(url.toString(), { headers });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = text;
  }

  if (!response.ok) {
    const message = body?.message || body?.messageEn || body?.error || `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new Error("Klucz API jest nieprawidłowy albo nie został jeszcze aktywowany.");
    }
    if (response.status === 429) {
      throw new Error("Przekroczono limit zapytań PLK API. Zwolnij odświeżanie karty.");
    }
    throw new Error(message);
  }

  return body;
}

function stationNameFromDictionaries(dictionaries, stationId) {
  const stations = dictionaries?.stations || {};
  const entry = stations[String(stationId)] || stations[stationId];
  if (!entry) return "";
  return typeof entry === "string" ? entry : entry.name || "";
}

function routeStopTime(stop, operatingDate, eventType) {
  if (eventType === "arrival") {
    return stop.arrivalTime
      ? combineDateAndDuration(operatingDate, stop.arrivalTime, stop.arrivalDay || 0)
      : null;
  }
  return stop.departureTime
    ? combineDateAndDuration(operatingDate, stop.departureTime, stop.departureDay || 0)
    : null;
}

function routeDestination(route, selectedIndex, dictionaries) {
  const stations = Array.isArray(route.stations) ? route.stations : [];
  const after = stations.slice(selectedIndex + 1).filter(stop => stop.stationId);
  const candidate = after.length ? after[after.length - 1] : stations[stations.length - 1];
  return stationNameFromDictionaries(dictionaries, candidate?.stationId) || "Kierunek nieznany";
}

function routeOrigin(route, dictionaries) {
  const stations = Array.isArray(route.stations) ? route.stations : [];
  return stationNameFromDictionaries(dictionaries, stations[0]?.stationId) || "";
}

function buildOperationMap(operations, stationId) {
  const map = new Map();
  for (const train of operations?.trains || []) {
    const opStation = (train.stations || []).find(station => String(station.stationId) === String(stationId));
    if (!opStation) continue;

    const operation = {
      trainStatus: train.trainStatus,
      isCancelled: opStation.isCancelled || train.trainStatus === "X" || train.trainStatus === "Q",
      isConfirmed: opStation.isConfirmed,
      plannedDeparture: parseRailDateTime(opStation.plannedDeparture),
      actualDeparture: parseRailDateTime(opStation.actualDeparture),
      departureDelayMinutes: opStation.departureDelayMinutes ?? null,
      plannedArrival: parseRailDateTime(opStation.plannedArrival),
      actualArrival: parseRailDateTime(opStation.actualArrival),
      arrivalDelayMinutes: opStation.arrivalDelayMinutes ?? null,
    };

    const operatingDate = train.operatingDate;
    map.set(trainKey(train.scheduleId, train.orderId, operatingDate), operation);
    if (train.trainOrderId !== undefined && train.trainOrderId !== null) {
      map.set(trainKey(train.scheduleId, train.trainOrderId, operatingDate), operation);
    }
  }
  return map;
}

function operationForEvent(operation, eventType, plannedTime) {
  if (!operation) return null;
  const planned = eventType === "arrival"
    ? operation.plannedArrival || plannedTime
    : operation.plannedDeparture || plannedTime;
  const actual = eventType === "arrival"
    ? operation.actualArrival
    : operation.actualDeparture;
  const explicitDelay = eventType === "arrival"
    ? operation.arrivalDelayMinutes
    : operation.departureDelayMinutes;
  const delayMinutes = explicitDelay ?? (actual && planned ? Math.round((actual.getTime() - planned.getTime()) / 60000) : null);

  return {
    trainStatus: operation.trainStatus,
    isCancelled: operation.isCancelled,
    isConfirmed: operation.isConfirmed,
    plannedTime: planned,
    actualTime: actual,
    delayMinutes,
  };
}

function eventTypesForStop(stop, boardMode) {
  if (boardMode === "arrivals") return stop.arrivalTime ? ["arrival"] : [];
  if (boardMode === "both") {
    return [
      stop.departureTime ? "departure" : "",
      stop.arrivalTime ? "arrival" : "",
    ].filter(Boolean);
  }
  return stop.departureTime ? ["departure"] : [];
}

function buildDepartures(scheduleData, operationsData, config) {
  const operationMap = buildOperationMap(operationsData, config.station_id);
  const dictionaries = scheduleData?.dictionaries || {};
  const carrierDict = dictionaries.carriers || {};
  const categoryDict = dictionaries.commercialCategories || {};
  const now = Date.now();
  const maxMs = config.max_minutes_ahead > 0 ? config.max_minutes_ahead * 60000 : null;
  const departures = [];

  for (const route of scheduleData?.routes || []) {
    const stations = Array.isArray(route.stations) ? route.stations : [];
    const selectedIndex = stations.findIndex(stop => String(stop.stationId) === String(config.station_id));
    if (selectedIndex < 0) continue;

    const stop = stations[selectedIndex];
    const eventTypes = eventTypesForStop(stop, config.board_mode);
    if (!eventTypes.length) continue;

    for (const operatingDate of route.operatingDates || [todayString()]) {
      const operation =
        operationMap.get(trainKey(route.scheduleId, route.orderId, operatingDate)) ||
        operationMap.get(trainKey(route.scheduleId, route.trainOrderId, operatingDate));

      for (const eventType of eventTypes) {
        const plannedTime = routeStopTime(stop, operatingDate, eventType);
        if (!plannedTime) continue;

        const eventOperation = operationForEvent(operation, eventType, plannedTime);
        const displayTime = eventOperation?.actualTime || eventOperation?.plannedTime || plannedTime;
        const minutesFromNow = displayTime.getTime() - now;

        if (minutesFromNow < -2 * 60000) continue;
        if (maxMs !== null && minutesFromNow > maxMs) continue;

        const carrierCode = route.carrierCode || "";
        const category = eventType === "arrival"
          ? stop.arrivalCommercialCategory || route.commercialCategorySymbol || carrierCode || "TRAIN"
          : stop.departureCommercialCategory || route.commercialCategorySymbol || carrierCode || "TRAIN";
        const trainNumber =
          (eventType === "arrival" ? stop.arrivalTrainNumber : stop.departureTrainNumber) ||
          route.nationalNumber ||
          route.internationalDepartureNumber ||
          route.internationalArrivalNumber ||
          "";
        const departure = {
          key: `${route.scheduleId}-${route.orderId}-${operatingDate}-${selectedIndex}-${eventType}`,
          eventType,
          time: displayTime,
          plannedTime,
          destination: eventType === "arrival" ? stationNameFromDictionaries(dictionaries, stop.stationId) || "Przyjazd" : routeDestination(route, selectedIndex, dictionaries),
          origin: routeOrigin(route, dictionaries),
          carrierCode,
          carrierName: carrierDict[carrierCode] || carrierCode,
          category,
          categoryName: categoryDict[category] || category,
          trainName: route.name || "",
          trainNumber,
          platform: eventType === "arrival" ? stop.arrivalPlatform || stop.departurePlatform || "" : stop.departurePlatform || stop.arrivalPlatform || "",
          track: eventType === "arrival" ? stop.arrivalTrack || stop.departureTrack || "" : stop.departureTrack || stop.arrivalTrack || "",
          delayMinutes: eventOperation?.delayMinutes ?? null,
          isRealtime: Boolean(eventOperation),
          isCancelled: Boolean(eventOperation?.isCancelled),
          isConfirmed: Boolean(eventOperation?.isConfirmed),
          trainStatus: eventOperation?.trainStatus || "",
          scope: trainScope(category, carrierCode),
        };
        if (passesDepartureFilters(departure, config)) departures.push(departure);
      }
    }
  }

  return departures
    .sort((a, b) => {
      if (config.cancelled_mode === "bottom" && a.isCancelled !== b.isCancelled) return a.isCancelled ? 1 : -1;
      return a.time.getTime() - b.time.getTime();
    })
    .slice(0, config.max_departures);
}

function buildOperationOnlyDepartures(operationsData, config) {
  const now = Date.now();
  const maxMs = config.max_minutes_ahead > 0 ? config.max_minutes_ahead * 60000 : null;
  const stationNames = operationsData?.stations || {};
  const departures = [];

  for (const train of operationsData?.trains || []) {
    const stations = Array.isArray(train.stations) ? train.stations : [];
    const selectedIndex = stations.findIndex(stop => String(stop.stationId) === String(config.station_id));
    if (selectedIndex < 0) continue;

    const stop = stations[selectedIndex];
    const eventTypes = [
      config.board_mode !== "arrivals" && (stop.actualDeparture || stop.plannedDeparture) ? "departure" : "",
      config.board_mode !== "departures" && (stop.actualArrival || stop.plannedArrival) ? "arrival" : "",
    ].filter(Boolean);

    for (const eventType of eventTypes) {
      const plannedTime = parseRailDateTime(eventType === "arrival" ? stop.plannedArrival : stop.plannedDeparture);
      const actualTime = parseRailDateTime(eventType === "arrival" ? stop.actualArrival : stop.actualDeparture);
      const displayTime = actualTime || plannedTime;
      if (!displayTime) continue;

      const minutesFromNow = displayTime.getTime() - now;
      if (minutesFromNow < -2 * 60000) continue;
      if (maxMs !== null && minutesFromNow > maxMs) continue;

      const directionStation = eventType === "arrival" ? stations[0] : stations[stations.length - 1];
      const category = train.carrierCode || "TRAIN";
      const carrierCode = train.carrierCode || "";
      const departure = {
        key: `operation-${train.scheduleId}-${train.orderId}-${train.operatingDate}-${eventType}`,
        eventType,
        time: displayTime,
        plannedTime,
        destination: eventType === "arrival"
          ? stationNames[String(stop.stationId)] || "Przyjazd"
          : stationNames[String(directionStation?.stationId)] || "Kierunek nieznany",
        origin: stationNames[String(stations[0]?.stationId)] || "",
        carrierCode,
        carrierName: carrierCode,
        category,
        categoryName: category,
        trainName: "",
        trainNumber: String(train.trainOrderId || train.orderId || ""),
        platform: "",
        track: "",
        delayMinutes: eventType === "arrival" ? stop.arrivalDelayMinutes ?? null : stop.departureDelayMinutes ?? null,
        isRealtime: true,
        isCancelled: stop.isCancelled || train.trainStatus === "X" || train.trainStatus === "Q",
        isConfirmed: stop.isConfirmed,
        trainStatus: train.trainStatus || "",
        scope: trainScope(category, carrierCode),
      };
      if (passesDepartureFilters(departure, config)) departures.push(departure);
    }
  }

  return departures
    .sort((a, b) => {
      if (config.cancelled_mode === "bottom" && a.isCancelled !== b.isCancelled) return a.isCancelled ? 1 : -1;
      return a.time.getTime() - b.time.getTime();
    })
    .slice(0, config.max_departures);
}

function textFromDisruption(item) {
  if (!item || typeof item !== "object") return "";
  const fields = [
    item.title,
    item.name,
    item.message,
    item.description,
    item.reason,
    item.typeName,
    item.category,
  ].filter(Boolean);
  if (fields.length) return fields.join(" - ");
  return JSON.stringify(item).slice(0, 220);
}

function buildDisruptions(disruptionsData, config) {
  const source = disruptionsData?.disruptions || disruptionsData?.items || disruptionsData?.data || disruptionsData?.affectedRoutes || [];
  const rows = Array.isArray(source) ? source : [];
  const stationId = String(config.station_id || "");
  return rows
    .filter(item => {
      const text = JSON.stringify(item);
      return !stationId || text.includes(stationId) || rows.length <= 5;
    })
    .slice(0, 3)
    .map(item => textFromDisruption(item))
    .filter(Boolean);
}

function buildMockDisruptions(config) {
  if (!config.show_disruptions) return [];
  return [
    "Utrudnienia testowe: możliwe zmiany torów dla części pociągów regionalnych.",
  ];
}

function buildMockDepartures(config) {
  const base = Date.now();
  const minutes = value => new Date(base + value * 60000);
  const rows = [
    {
      category: "SKM",
      carrierCode: "SKM",
      carrierName: "PKP SKM w Trójmieście",
      destination: "Gdynia Główna",
      origin: "Gdańsk Śródmieście",
      trainNumber: "95782",
      platform: "2",
      track: "501",
      delayMinutes: 1,
      isRealtime: true,
      trainStatus: "P",
      eventType: "departure",
      scope: "regional",
      time: minutes(4),
      plannedTime: minutes(3),
    },
    {
      category: "SKM",
      carrierCode: "SKM",
      carrierName: "PKP SKM w Trójmieście",
      destination: "Gdańsk Śródmieście",
      origin: "Wejherowo",
      trainNumber: "95731",
      platform: "1",
      track: "502",
      delayMinutes: 0,
      isRealtime: true,
      trainStatus: "P",
      eventType: "departure",
      scope: "regional",
      time: minutes(9),
      plannedTime: minutes(9),
    },
    {
      category: "REG",
      carrierCode: "PR",
      carrierName: "POLREGIO",
      destination: "Kościerzyna",
      origin: "Gdynia Główna",
      trainNumber: "90345",
      platform: "3",
      track: "503",
      delayMinutes: 4,
      isRealtime: true,
      trainStatus: "P",
      eventType: "departure",
      scope: "regional",
      time: minutes(17),
      plannedTime: minutes(13),
    },
    {
      category: "REG",
      carrierCode: "PR",
      carrierName: "POLREGIO",
      destination: "Kartuzy",
      origin: "Gdańsk Wrzeszcz",
      trainNumber: "90321",
      platform: "4",
      track: "504",
      delayMinutes: null,
      isRealtime: false,
      trainStatus: "S",
      eventType: "departure",
      scope: "regional",
      time: minutes(28),
      plannedTime: minutes(28),
    },
    {
      category: "SKM",
      carrierCode: "SKM",
      carrierName: "PKP SKM w Trójmieście",
      destination: "Gdańsk Wrzeszcz",
      origin: "Rumia",
      trainNumber: "95799",
      platform: "1",
      track: "502",
      delayMinutes: 8,
      isRealtime: true,
      isCancelled: true,
      trainStatus: "X",
      eventType: "departure",
      scope: "regional",
      time: minutes(35),
      plannedTime: minutes(27),
    },
    {
      category: "IC",
      carrierCode: "IC",
      carrierName: "PKP Intercity",
      destination: "Warszawa Centralna",
      origin: "Gdynia Główna",
      trainNumber: "5310",
      platform: "2",
      track: "505",
      delayMinutes: -2,
      isRealtime: true,
      trainStatus: "P",
      eventType: "departure",
      scope: "long_distance",
      time: minutes(41),
      plannedTime: minutes(43),
    },
  ];

  return rows
    .filter(row => config.board_mode !== "arrivals" || row.eventType === "arrival")
    .filter(row => config.board_mode !== "departures" || row.eventType === "departure")
    .filter(row => passesDepartureFilters(row, config))
    .sort((a, b) => {
      if (config.cancelled_mode === "bottom" && a.isCancelled !== b.isCancelled) return a.isCancelled ? 1 : -1;
      return a.time.getTime() - b.time.getTime();
    })
    .slice(0, config.max_departures)
    .map((row, index) => ({ ...row, key: `mock-${index}` }));
}

class PlkRailCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("plk-rail-card-editor");
  }

  static getStubConfig() {
    return {
      api_key: "",
      station_id: "",
      display_preset: "standard",
      max_departures: 8,
      refresh_interval: 240,
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = normalizeConfig({});
    this._departures = [];
    this._disruptions = [];
    this._error = "";
    this._warning = "";
    this._loading = true;
    this._updatedAt = null;
    this._refreshTimer = null;
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    if (this._config.mock_data) {
      this._carrierError = "";
      this._stationCarrierError = "";
      this._stationCarrierLoading = false;
      this._stationCarriers = [];
    }
    this._render();
    if (this.isConnected) this._load();
  }

  connectedCallback() {
    this._load();
  }

  disconnectedCallback() {
    this._clearTimer();
  }

  getCardSize() {
    return this._config.compact_mode ? 3 : 4;
  }

  _clearTimer() {
    if (this._refreshTimer) {
      window.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  _scheduleRefresh() {
    this._clearTimer();
    const seconds = effectiveRefreshInterval(this._config, this._config.e_ink_mode);
    this._refreshTimer = window.setTimeout(() => this._load(), seconds * 1000);
  }

  async _load() {
    if (this._config.mock_data) {
      this._clearTimer();
      this._loading = false;
      this._error = "";
      this._warning = "Dane testowe - podgląd bez aktywnego klucza API.";
      this._departures = buildMockDepartures(this._config);
      this._disruptions = buildMockDisruptions(this._config);
      this._updatedAt = new Date();
      if (!this._config.station_id) this._config.station_id = "mock";
      if (!this._config.station_name) this._config.station_name = "Gdańsk Wrzeszcz";
      this._render();
      return;
    }

    if ((this._config.direct_api && !this._config.api_key) || !this._config.station_id) {
      this._loading = false;
      this._error = "";
      this._departures = [];
      this._disruptions = [];
      this._render();
      return;
    }

    const firstLoad = !this._updatedAt;
    this._loading = firstLoad;
    this._warning = "";
    this._error = "";
    this._render();

    const params = {
      stations: this._config.station_id,
      carriersInclude: this._config.carriers_include.join(","),
      carriersExclude: this._config.carriers_exclude.join(","),
    };

    try {
      let operationsData = null;
      try {
        operationsData = await plkFetch("/operations", this._config, {
          ...params,
          withPlanned: true,
          fullRoutes: true,
          pageSize: 1000,
        });
      } catch (error) {
        this._warning = `Nie udało się pobrać realtime: ${error.message}`;
      }

      try {
        const scheduleData = await plkFetch("/schedules", this._config, {
          ...params,
          dateFrom: todayString(),
          dateTo: todayString(1),
          dictionaries: true,
          fullRoute: true,
        });
        this._departures = buildDepartures(scheduleData, operationsData, this._config);
        if (!this._config.station_name) {
          this._config.station_name = stationNameFromDictionaries(scheduleData.dictionaries, this._config.station_id);
        }
      } catch (scheduleError) {
        if (!operationsData) throw scheduleError;
        this._warning = `Pokazuję uproszczone realtime bez rozkładu planowego. ${scheduleError.message}`;
        this._departures = buildOperationOnlyDepartures(operationsData, this._config);
        if (!this._config.station_name) {
          this._config.station_name = operationsData.stations?.[String(this._config.station_id)] || "";
        }
      }

      if (this._config.show_disruptions) {
        try {
          const disruptionsData = await plkFetch("/disruptions", this._config, {
            stations: this._config.station_id,
            carriersInclude: this._config.carriers_include.join(","),
            carriersExclude: this._config.carriers_exclude.join(","),
            dateFrom: todayString(),
            dateTo: todayString(1),
          });
          this._disruptions = buildDisruptions(disruptionsData, this._config);
        } catch (disruptionError) {
          this._warning = `${this._warning ? `${this._warning} ` : ""}Nie udało się pobrać utrudnień: ${disruptionError.message}`;
          this._disruptions = [];
        }
      } else {
        this._disruptions = [];
      }

      this._updatedAt = new Date();
      this._loading = false;
      this._error = "";
      writeLocalCache(lastGoodCacheKey(this._config), {
        stationName: this._config.station_name,
        departures: serializeDeparturesForCache(this._departures),
        disruptions: this._disruptions,
      });
    } catch (error) {
      this._loading = false;
      if (this._departures.length) {
        this._warning = `Pokazuję ostatnie dane. ${error.message}`;
      } else {
        const cached = readLocalCache(lastGoodCacheKey(this._config), LAST_GOOD_CACHE_TTL);
        const cachedDepartures = restoreDeparturesFromCache(cached?.departures);
        if (cachedDepartures.length) {
          this._departures = cachedDepartures;
          this._disruptions = Array.isArray(cached.disruptions) ? cached.disruptions : [];
          if (!this._config.station_name && cached.stationName) this._config.station_name = cached.stationName;
          this._warning = `Pokazuję ostatnie zapisane dane. ${error.message}`;
        } else {
          this._error = error.message;
        }
      }
    }

    this._render();
    this._scheduleRefresh();
  }

  _renderRows() {
    if (this._loading && !this._departures.length) return this._renderSkeleton();

    if (this._config.direct_api && !this._config.api_key && !this._config.mock_data) {
      return this._renderEmpty("Podaj klucz API PLK", "W konfiguracji karty wklej klucz z pdp-api.plk-sa.pl.");
    }

    if (!this._config.station_id && !this._config.mock_data) {
      return this._renderEmpty("Wybierz stację", "Użyj edytora konfiguracji i wyszukaj stację kolejową.");
    }

    if (this._error) return this._renderEmpty("Nie można pobrać danych", this._error);

    if (!this._departures.length) {
      return this._renderEmpty("Brak najbliższych odjazdów", "Zmień filtry przewoźników albo limit czasu.");
    }

    return this._departures.map(dep => {
      const delay = Number.isFinite(dep.delayMinutes) && Math.abs(dep.delayMinutes) >= 1
        ? `<span class="delay ${dep.delayMinutes > 0 ? "late" : "early"}">${dep.delayMinutes > 0 ? "+" : ""}${dep.delayMinutes} min</span>`
        : "";
      const planned = this._config.show_delays && delay && dep.plannedTime
        ? `<span class="planned">planowo ${escapeHtml(formatHHMM(dep.plannedTime))}</span>`
        : "";
      const platform = this._config.show_platform && (dep.platform || dep.track)
        ? `<span>Peron ${escapeHtml(dep.platform || "-")}${dep.track ? ` / tor ${escapeHtml(dep.track)}` : ""}</span>`
        : "";
      const eventLabel = dep.eventType === "arrival" ? "Przyjazd" : "Odjazd";
      const carrierLabel = this._config.show_carrier_name && dep.carrierName
        ? dep.carrierName
        : dep.carrierCode;
      const meta = [
        eventLabel,
        dep.trainNumber ? `nr ${escapeHtml(dep.trainNumber)}` : "",
        carrierLabel ? escapeHtml(carrierLabel) : "",
        platform,
        dep.trainStatus && !dep.isCancelled ? escapeHtml(statusLabel(dep.trainStatus)) : "",
      ].filter(Boolean).join("<span class=\"dotsep\">-</span>");
      const cancelled = dep.isCancelled ? " cancelled" : "";
      const cancelledBadge = dep.isCancelled ? `<span class="cancelled-badge">Odwołany</span>` : "";
      const subTime = !this._config.e_ink_mode && dep.isRealtime
        ? `<div class="time-sub"><span class="live-dot" aria-hidden="true"></span>${escapeHtml(formatMinutesUntil(dep.time))}</div>`
        : "";

      return `
        <div class="departure${cancelled}">
          <div class="badge ${categoryClass(dep.category, dep.carrierCode)}">${escapeHtml(dep.category)}</div>
          <div class="main">
            <div class="destination">${escapeHtml(dep.destination)}</div>
            <div class="meta">${meta}</div>
            ${cancelledBadge}
          </div>
          <div class="time">
            <div class="clock">${escapeHtml(formatHHMM(dep.time))}</div>
            ${planned}
            ${subTime}
            ${this._config.show_delays ? delay : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  _renderDisruptions() {
    if (!this._disruptions?.length) return "";
    return `
      <div class="disruptions">
        ${this._disruptions.map(item => `<div class="disruption">${escapeHtml(item)}</div>`).join("")}
      </div>
    `;
  }

  _renderSkeleton() {
    return Array.from({ length: Math.min(this._config.max_departures, 8) }, () => `
      <div class="departure skeleton-row">
        <div class="badge skeleton"></div>
        <div class="main">
          <div class="skeleton line"></div>
          <div class="skeleton small-line"></div>
        </div>
        <div class="skeleton time-skeleton"></div>
      </div>
    `).join("");
  }

  _renderEmpty(title, message) {
    return `
      <div class="empty">
        <div class="empty-title">${escapeHtml(title)}</div>
        <div class="empty-message">${escapeHtml(message)}</div>
      </div>
    `;
  }

  _render() {
    const title = this._config.title || this._config.station_name || (this._config.station_id ? "Wybrana stacja" : "Pociągi");
    const subtitle = this._config.station_id
      ? `${this._config.station_name || "Stacja"} - PLK OpenData`
      : "Stacja niewybrana - PLK OpenData";
    const classes = [
      this._config.compact_mode ? "compact" : "",
      this._config.e_ink_mode ? "e-ink" : "",
      this._config.next_mode ? "next" : "",
      `brand-${this._config.brand_preset}`,
    ].filter(Boolean).join(" ");
    const footer = this._config.show_footer
      ? `<div class="footer">
          <span>${this._updatedAt && !this._config.e_ink_mode ? `Odświeżono: ${escapeHtml(this._updatedAt.toLocaleTimeString("pl-PL"))}` : "PLK OpenData"}</span>
          <span>v${CARD_VERSION}</span>
        </div>`
      : "";

    this.shadowRoot.innerHTML = `
      <style>${CARD_STYLES}</style>
      <ha-card class="${classes}">
        <div class="header">
          <div class="icon" aria-hidden="true">${TRAIN_ICON}</div>
          <div>
            <div class="title">${escapeHtml(title)}</div>
            <div class="subtitle">${escapeHtml(subtitle)}</div>
          </div>
        </div>
        <div class="content">
          ${this._warning ? `<div class="warning">${escapeHtml(this._warning)}</div>` : ""}
          ${this._renderDisruptions()}
          ${this._renderRows()}
        </div>
        ${footer}
      </ha-card>
    `;
  }
}

class PlkRailCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = normalizeConfig({});
    this._stationResults = [];
    this._stationSearch = "";
    this._stationLoading = false;
    this._stationError = "";
    this._carriers = [];
    this._carrierError = "";
    this._stationCarriers = [];
    this._stationCarrierStation = "";
    this._stationCarrierLoading = false;
    this._stationCarrierError = "";
    this._apiTest = null;
    this._apiTesting = false;
    this._searchTimer = null;
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._render();
    if (!this._config.mock_data && (this._config.api_key || (!this._config.direct_api && this._config.station_id))) this._loadCarriers();
    if (!this._config.mock_data && this._config.station_id) this._loadStationCarriers();
  }

  _emit(patch, render = true) {
    this._config = normalizeConfig({ ...this._config, ...patch });
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: serializeConfig(this._config) },
      bubbles: true,
      composed: true,
    }));
    if (render) this._render();
  }

  async _searchStations(query) {
    this._stationSearch = query;
    this._stationError = "";
    if (query.trim().length < 2) {
      this._stationResults = [];
      this._render();
      return;
    }
    if (this._config.direct_api && !this._config.api_key) {
      this._stationError = "Najpierw podaj klucz API albo wyłącz tryb bezpośredni.";
      this._stationResults = [];
      this._render();
      return;
    }

    const cacheKey = scopedCacheKey(this._config, `stations:${query.toLocaleLowerCase("pl-PL")}`);
    const cached = readLocalCache(cacheKey, STATION_CACHE_TTL);
    if (cached) {
      this._stationResults = cached;
      this._render();
      return;
    }

    this._stationLoading = true;
    this._render();
    try {
      const data = await plkFetch("/dictionaries/stations", this._config, {
        search: query.trim(),
        page: 1,
        pageSize: 12,
      });
      this._stationResults = data.stations || [];
      writeLocalCache(cacheKey, this._stationResults);
    } catch (error) {
      this._stationError = error.message;
      this._stationResults = [];
    } finally {
      this._stationLoading = false;
      this._render();
    }
  }

  async _loadCarriers() {
    if (this._config.mock_data || (this._config.direct_api && !this._config.api_key)) return;
    const carrierCacheKey = scopedCacheKey(this._config, "carriers");
    const cached = readLocalCache(carrierCacheKey, CARRIER_CACHE_TTL);
    if (cached) {
      this._carriers = cached;
      this._render();
      return;
    }

    try {
      const data = await plkFetch("/dictionaries/carriers", this._config);
      this._carriers = data.carriers || [];
      writeLocalCache(carrierCacheKey, this._carriers);
      this._carrierError = "";
    } catch (error) {
      this._carrierError = error.message;
    }
    this._render();
  }

  async _loadStationCarriers(force = false) {
    if (!this._config.station_id) {
      this._stationCarriers = [];
      this._stationCarrierStation = "";
      return;
    }
    if (this._config.mock_data || (this._config.direct_api && !this._config.api_key)) return;
    if (!force && this._stationCarrierStation === this._config.station_id && this._stationCarriers.length) return;
    if (this._stationCarrierLoading) return;

    const stationId = this._config.station_id;
    const cacheKey = scopedCacheKey(this._config, `station-carriers:${stationId}`);
    const cached = readLocalCache(cacheKey, STATION_CARRIER_CACHE_TTL);
    if (cached) {
      this._stationCarrierStation = stationId;
      this._stationCarriers = cached;
      this._render();
      return;
    }

    this._stationCarrierStation = stationId;
    this._stationCarrierLoading = true;
    this._stationCarrierError = "";
    this._render();

    try {
      const data = await plkFetch("/schedules", this._config, {
        stations: stationId,
        dateFrom: todayString(),
        dateTo: todayString(1),
        dictionaries: true,
        fullRoute: false,
      });
      const carrierDict = data?.dictionaries?.carriers || {};
      const carriers = Array.from(new Set((data?.routes || []).map(route => route.carrierCode).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b, "pl"))
        .map(code => ({ code, name: carrierDict[code] || code }));
      this._stationCarriers = carriers;
      writeLocalCache(cacheKey, carriers);
    } catch (error) {
      this._stationCarrierError = error.message;
      this._stationCarriers = [];
    } finally {
      this._stationCarrierLoading = false;
      this._render();
    }
  }

  _toggleCarrier(code) {
    const current = new Set(this._config.carriers_include);
    if (current.has(code)) current.delete(code);
    else current.add(code);
    this._emit({ carriers_include: Array.from(current) });
  }

  async _testApi() {
    this._apiTesting = true;
    this._apiTest = null;
    this._render();

    const checks = [];
    const run = async (label, path, params = {}) => {
      const started = performance.now();
      try {
        const data = await plkFetch(path, this._config, params);
        checks.push({
          label,
          ok: true,
          detail: `${Math.round(performance.now() - started)} ms`,
          count: Array.isArray(data?.stations)
            ? data.stations.length
            : Array.isArray(data?.carriers)
              ? data.carriers.length
              : Array.isArray(data?.routes)
                ? data.routes.length
                : Array.isArray(data?.trains)
                  ? data.trains.length
                  : "",
        });
      } catch (error) {
        checks.push({ label, ok: false, detail: error.message, count: "" });
      }
    };

    await run("Proxy / słownik stacji", "/dictionaries/stations", { search: "Gdańsk", pageSize: 3 });
    if (this._config.station_id) {
      await run("Rozkład planowy", "/schedules", {
        stations: this._config.station_id,
        dateFrom: todayString(),
        dateTo: todayString(1),
        dictionaries: true,
        fullRoute: true,
      });
      await run("Realtime", "/operations", {
        stations: this._config.station_id,
        withPlanned: true,
        fullRoutes: true,
        pageSize: 100,
      });
      if (this._config.show_disruptions) {
        await run("Utrudnienia", "/disruptions", {
          stations: this._config.station_id,
          dateFrom: todayString(),
          dateTo: todayString(1),
        });
      }
    }

    this._apiTesting = false;
    this._apiTest = checks;
    this._render();
  }

  _renderCarrierChips() {
    const selected = new Set(this._config.carriers_include);
    const relevant = this._carriers
      .filter(carrier => {
        const text = `${carrier.code || ""} ${carrier.name || ""}`.toUpperCase();
        return selected.has(carrier.code) || /SKM|POLREGIO|REGIO|POMORSK|INTERCITY|IC\b/.test(text);
      })
      .slice(0, 24);

    if (this._config.mock_data) return "";
    if (this._config.direct_api && !this._config.api_key) return `<div class="hint">W trybie bezpośrednim słownik przewoźników wymaga klucza API w karcie.</div>`;
    if (this._carrierError) return `<div class="field-error">${escapeHtml(this._carrierError)}</div>`;
    if (!relevant.length) return `<div class="hint">Brak załadowanych przewoźników. Możesz wpisać kody ręcznie.</div>`;

    return `
      <div class="chips">
        ${relevant.map(carrier => `
          <button
            class="chip ${selected.has(carrier.code) ? "selected" : ""}"
            data-action="carrier"
            data-code="${escapeHtml(carrier.code)}"
            type="button"
            title="${escapeHtml(carrier.name || "")}"
          >${escapeHtml(carrier.code)}</button>
        `).join("")}
      </div>
    `;
  }

  _renderStationChips(title, stations) {
    if (!stations.length) return "";
    return `
      <div class="station-chip-group">
        <div class="chip-title">${escapeHtml(title)}</div>
        <div class="chips">
          ${stations.map(station => `
            <button class="chip station-chip" data-action="station" data-id="${escapeHtml(station.id)}" data-name="${escapeHtml(station.name)}" type="button">
              ${escapeHtml(station.name)}
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  _renderStationCarrierChips() {
    if (this._config.mock_data) return `<div class="hint">Mock danych nie pobiera przewoźników z API.</div>`;
    if (!this._config.station_id) return `<div class="hint">Po wyborze stacji pokażę przewoźników wykrytych w jej rozkładzie.</div>`;
    if (this._stationCarrierLoading) return `<div class="hint">Sprawdzam przewoźników dla wybranej stacji...</div>`;
    if (this._stationCarrierError) return `<div class="field-error">${escapeHtml(this._stationCarrierError)}</div>`;
    if (!this._stationCarriers.length) return `<div class="hint">Nie znalazłem przewoźników dla tej stacji. Możesz wpisać kody ręcznie.</div>`;
    const selected = new Set(this._config.carriers_include);
    return `
      <div class="station-chip-group">
        <div class="chip-title">Wykryci na tej stacji</div>
        <div class="chips">
          ${this._stationCarriers.slice(0, 18).map(carrier => `
            <button
              class="chip ${selected.has(carrier.code) ? "selected" : ""}"
              data-action="carrier"
              data-code="${escapeHtml(carrier.code)}"
              type="button"
              title="${escapeHtml(carrier.name || "")}"
            >${escapeHtml(carrier.code)}</button>
          `).join("")}
        </div>
      </div>
    `;
  }

  _renderStationPicker() {
    const recent = readRecentStations();
    const selected = this._config.station_id
      ? `<div class="selected-station">
          <div>
            <div class="selected-name">${escapeHtml(this._config.station_name || "Wybrana stacja")}</div>
            <div class="selected-id">ID ${escapeHtml(this._config.station_id)}</div>
          </div>
          <button data-action="clear-station" type="button">Zmień</button>
        </div>`
      : "";

    return `
      ${selected}
      <label>
        <span>Wyszukaj stację</span>
        <input class="station-search" type="search" value="${escapeHtml(this._stationSearch)}" placeholder="np. Gdańsk Wrzeszcz" autocomplete="off">
      </label>
      ${this._renderStationChips("Szybki wybór", QUICK_STATIONS)}
      ${this._renderStationChips("Ostatnie", recent)}
      ${this._stationLoading ? `<div class="hint">Szukam stacji...</div>` : ""}
      ${this._stationError ? `<div class="field-error">${escapeHtml(this._stationError)}</div>` : ""}
      ${this._stationResults.length ? `
        <div class="results">
          ${this._stationResults.map(station => `
            <button class="result" data-action="station" data-id="${escapeHtml(station.id)}" data-name="${escapeHtml(station.name)}" type="button">
              <span>${escapeHtml(station.name)}</span>
              <small>ID ${escapeHtml(station.id)}</small>
            </button>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  _renderLimitSummary() {
    const requested = this._config.e_ink_mode ? this._config.e_ink_refresh_interval : this._config.refresh_interval;
    const effective = effectiveRefreshInterval(this._config, this._config.e_ink_mode);
    const minimum = minRefreshIntervalForLimits(this._config);
    const profile = limitProfileForConfig(this._config);
    const clamped = effective > requested;
    return `
      <div class="hint">
        Tryb ${escapeHtml(profile.label)}: ${escapeHtml(profile.hourly)} zapytań/h, ${escapeHtml(profile.daily)} zapytań/dzień.
        Minimum dla ${escapeHtml(this._config.api_key_clients)} kart na tym kluczu: ${escapeHtml(minimum)}s.
        ${clamped ? `Karta automatycznie podniesie odświeżanie do ${escapeHtml(effective)}s.` : "Aktualne odświeżanie mieści się w limicie."}
      </div>
    `;
  }

  _renderLimitModeOption(value, label) {
    return `<option value="${escapeHtml(value)}" ${this._config.api_limit_mode === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  _renderOption(field, value, label) {
    return `<option value="${escapeHtml(value)}" ${this._config[field] === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }

  _renderApiTest() {
    if (this._apiTesting) return `<div class="diagnostics">Testuję API...</div>`;
    if (!this._apiTest) return "";
    return `
      <div class="diagnostics">
        ${this._apiTest.map(check => `
          <div class="diag-row ${check.ok ? "ok" : "bad"}">
            <span>${check.ok ? "OK" : "Błąd"}</span>
            <strong>${escapeHtml(check.label)}</strong>
            <small>${escapeHtml([check.count, check.detail].filter(Boolean).join(" - "))}</small>
          </div>
        `).join("")}
      </div>
    `;
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${EDITOR_STYLES}</style>
      <div class="editor">
        <section>
          <h3>Podstawowe</h3>
          <label>
            <span>Klucz API PLK</span>
            <input data-field="api_key" type="password" value="${escapeHtml(this._config.api_key)}" placeholder="sk_live_...">
          </label>
          <div class="hint">Opcjonalne. Najlepiej wpisz klucz przy dodawaniu integracji PLK Rail Card i zostaw to pole puste.</div>
          <div class="hint">Klucz wpisany tutaj trafia do konfiguracji Lovelace i może być widoczny dla osób z dostępem do dashboardu.</div>
          <button data-action="test-api" type="button">Test API</button>
          ${this._renderApiTest()}
          <label>
            <span>Preset konfiguracji</span>
            <select data-field="preset">
              ${this._renderOption("preset", "custom", "Własna konfiguracja")}
              ${this._renderOption("preset", "skm_city", "SKM / miejska tablica")}
              ${this._renderOption("preset", "long_distance", "Dalekobieżne")}
              ${this._renderOption("preset", "e_ink_station_board", "E-ink tablica stacyjna")}
              ${this._renderOption("preset", "next_train", "Najbliższy pociąg")}
            </select>
          </label>
          <label>
            <span>Tryb limitów API</span>
            <select data-field="api_limit_mode">
              ${this._renderLimitModeOption("basic", "Basic - 100/h, 1000/dzień")}
              ${this._renderLimitModeOption("standard", "Standard - 500/h, 5000/dzień")}
              ${this._renderLimitModeOption("premium", "Premium - 2000/h, 20000/dzień")}
              ${this._renderLimitModeOption("custom", "Własny limit")}
            </select>
          </label>
          <div class="grid">
            <label>
              <span>Kart na tym kluczu</span>
              <input data-field="api_key_clients" type="number" min="1" max="50" value="${escapeHtml(this._config.api_key_clients)}">
            </label>
            <label>
              <span>Bufor bezpieczeństwa (%)</span>
              <input data-field="api_limit_safety" type="number" min="50" max="100" value="${escapeHtml(this._config.api_limit_safety)}">
            </label>
          </div>
          ${this._config.api_limit_mode === "custom" ? `
            <div class="grid">
              <label>
                <span>Limit godzinowy</span>
                <input data-field="api_limit_hourly" type="number" min="1" max="100000" value="${escapeHtml(this._config.api_limit_hourly)}">
              </label>
              <label>
                <span>Limit dzienny</span>
                <input data-field="api_limit_daily" type="number" min="1" max="1000000" value="${escapeHtml(this._config.api_limit_daily)}">
              </label>
            </div>
          ` : ""}
          ${this._renderLimitSummary()}
          <label>
            <span>Tytuł karty</span>
            <input data-field="title" type="text" value="${escapeHtml(this._config.title || "")}" placeholder="Domyślnie nazwa stacji">
          </label>
          ${this._renderStationPicker()}
        </section>

        <section>
          <h3>Przewoźnicy</h3>
          <label>
            <span>Uwzględnij tylko kody</span>
            <input data-field="carriers_include" type="text" value="${escapeHtml(this._config.carriers_include.join(", "))}" placeholder="np. SKM, PR">
          </label>
          ${this._renderStationCarrierChips()}
          ${this._renderCarrierChips()}
          <label>
            <span>Wyklucz kody</span>
            <input data-field="carriers_exclude" type="text" value="${escapeHtml(this._config.carriers_exclude.join(", "))}" placeholder="np. IC">
          </label>
        </section>

        <section>
          <h3>Odjazdy</h3>
          <div class="grid">
            <label>
              <span>Tryb tablicy</span>
              <select data-field="board_mode">
                ${this._renderOption("board_mode", "departures", "Odjazdy")}
                ${this._renderOption("board_mode", "arrivals", "Przyjazdy")}
                ${this._renderOption("board_mode", "both", "Odjazdy i przyjazdy")}
              </select>
            </label>
            <label>
              <span>Zakres pociągów</span>
              <select data-field="train_scope">
                ${this._renderOption("train_scope", "all", "Wszystkie")}
                ${this._renderOption("train_scope", "regional", "Regionalne")}
                ${this._renderOption("train_scope", "long_distance", "Dalekobieżne")}
              </select>
            </label>
            <label>
              <span>Liczba odjazdów</span>
              <input data-field="max_departures" type="number" min="${this._config.next_mode ? "1" : "3"}" max="30" value="${escapeHtml(this._config.max_departures)}">
            </label>
            <label>
              <span>Odświeżanie (s)</span>
              <input data-field="refresh_interval" type="number" min="60" max="1800" value="${escapeHtml(this._config.refresh_interval)}">
            </label>
            <label>
              <span>Limit minut</span>
              <input data-field="max_minutes_ahead" type="number" min="0" max="1440" value="${escapeHtml(this._config.max_minutes_ahead)}">
            </label>
            <label>
              <span>E-ink odświeżanie (s)</span>
              <input data-field="e_ink_refresh_interval" type="number" min="300" max="7200" value="${escapeHtml(this._config.e_ink_refresh_interval)}">
            </label>
          </div>
          <label>
            <span>Filtr kierunku / relacji</span>
            <input data-field="destination_filter" type="text" value="${escapeHtml(this._config.destination_filter.join(", "))}" placeholder="np. Gdynia, Warszawa">
          </label>
          <label>
            <span>Odwołane pociągi</span>
            <select data-field="cancelled_mode">
              ${this._renderOption("cancelled_mode", "show", "Pokaż w miejscu")}
              ${this._renderOption("cancelled_mode", "hide", "Ukryj")}
              ${this._renderOption("cancelled_mode", "bottom", "Przenieś na dół")}
            </select>
          </label>
          ${this._renderSwitch("show_delays", "Pokaż opóźnienia")}
          ${this._renderSwitch("show_platform", "Pokaż peron i tor")}
          ${this._renderSwitch("show_carrier_name", "Pokaż pełną nazwę przewoźnika")}
          ${this._renderSwitch("show_disruptions", "Pokaż utrudnienia")}
          ${this._renderSwitch("realtime_only", "Tylko pociągi z danymi realtime")}
          ${this._renderSwitch("show_footer", "Pokaż stopkę")}
        </section>

        <section>
          <h3>Wygląd</h3>
          <label>
            <span>Motyw marki</span>
            <select data-field="brand_preset">
              ${this._renderOption("brand_preset", "plk", "PLK / domyślny")}
              ${this._renderOption("brand_preset", "skm", "SKM")}
              ${this._renderOption("brand_preset", "regio", "REGIO / regionalny")}
              ${this._renderOption("brand_preset", "ic", "Intercity")}
              ${this._renderOption("brand_preset", "neutral", "Neutralny")}
            </select>
          </label>
          <div class="segmented">
            ${this._renderPreset("standard", "Standard")}
            ${this._renderPreset("compact", "Kompakt")}
            ${this._renderPreset("e_ink", "E-ink")}
            ${this._renderPreset("next", "Następny")}
          </div>
        </section>

        <section>
          <h3>Zaawansowane</h3>
          <label>
            <span>Proxy URL</span>
            <input data-field="proxy_url" type="text" value="${escapeHtml(this._config.proxy_url)}" placeholder="/api/plk_rail_card">
          </label>
          ${this._renderSwitch("direct_api", "Pomiń proxy i wołaj PLK bezpośrednio")}
          <div class="hint">Bezpośredni tryb zwykle nie działa w przeglądarce przez CORS. Zostaw proxy dla Home Assistant.</div>
        </section>
      </div>
    `;

    this.shadowRoot.querySelectorAll("[data-field]").forEach(input => {
      input.addEventListener("change", () => {
        const field = input.dataset.field;
        const value = input.type === "checkbox" ? input.checked : input.value;
        const patch = field === "preset"
          ? { ...presetDefaults(value), preset: value }
          : {};
        if (field !== "preset") {
          patch[field] = field.includes("carriers") || field === "destination_filter" ? normalizeList(value) : value;
        }
        this._emit(patch, field !== "api_key");
        if (field === "api_key" || field === "direct_api" || field === "proxy_url") this._loadCarriers();
      });
    });

    this.shadowRoot.querySelector(".station-search")?.addEventListener("input", event => {
      window.clearTimeout(this._searchTimer);
      const query = event.target.value;
      this._stationSearch = query;
      this._searchTimer = window.setTimeout(() => this._searchStations(query), 250);
    });

    this.shadowRoot.querySelectorAll("[data-action]").forEach(button => {
      button.addEventListener("click", () => {
        const action = button.dataset.action;
        if (action === "station") {
          this._stationResults = [];
          this._stationSearch = "";
          rememberStation({ id: button.dataset.id, name: button.dataset.name });
          this._emit({ station_id: button.dataset.id, station_name: button.dataset.name });
          this._loadStationCarriers(true);
        }
        if (action === "clear-station") {
          this._stationCarriers = [];
          this._stationCarrierStation = "";
          this._emit({ station_id: "", station_name: "" });
        }
        if (action === "carrier") {
          this._toggleCarrier(button.dataset.code);
        }
        if (action === "preset") {
          this._emit({ display_preset: button.dataset.value });
        }
        if (action === "test-api") {
          this._testApi();
        }
      });
    });
  }

  _renderSwitch(field, label) {
    return `
      <label class="switch-row">
        <span>${escapeHtml(label)}</span>
        <input data-field="${escapeHtml(field)}" type="checkbox" ${this._config[field] ? "checked" : ""}>
      </label>
    `;
  }

  _renderPreset(value, label) {
    return `
      <button
        class="${this._config.display_preset === value ? "active" : ""}"
        data-action="preset"
        data-value="${escapeHtml(value)}"
        type="button"
      >${escapeHtml(label)}</button>
    `;
  }
}

const TRAIN_ICON = `
  <svg viewBox="0 0 256 256" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <path fill="currentColor" d="M188,24H68A32.03667,32.03667,0,0,0,36,56V184a32.03667,32.03667,0,0,0,32,32H79.99976L65.59961,235.2002a8.00019,8.00019,0,0,0,12.80078,9.5996L100.00024,216h55.99952l21.59985,28.7998a8.00019,8.00019,0,0,0,12.80078-9.5996L176.00024,216H188a32.03667,32.03667,0,0,0,32-32V56A32.03667,32.03667,0,0,0,188,24ZM84,184a12,12,0,1,1,12-12A12,12,0,0,1,84,184Zm36-64H52V80h68Zm52,64a12,12,0,1,1,12-12A12,12,0,0,1,172,184Zm32-64H136V80h68Z"/>
  </svg>
`;

const CARD_STYLES = `
  :host {
    display: block;
    --rail-skm-blue: #005aa9;
    --rail-skm-yellow: #ffd200;
    --rail-pkm-green: #00843d;
    --rail-pkm-orange: #f58220;
    --rail-accent: var(--accent-color, var(--rail-skm-blue));
    --rail-text: var(--primary-text-color, #111827);
    --rail-muted: var(--secondary-text-color, #64748b);
    --rail-border: var(--divider-color, #e2e8f0);
    --rail-card: var(--card-background-color, #fff);
  }

  ha-card {
    display: block;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--rail-text);
    background: var(--rail-card);
    border: 0;
    border-radius: var(--ha-card-border-radius, 8px);
    box-shadow: 0 6px 18px rgba(0,0,0,0.08);
  }

  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    background: var(--rail-skm-blue);
    color: #fff;
    user-select: none;
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    color: #fff;
  }

  .icon svg {
    width: 22px;
    height: 22px;
  }

  .title {
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtitle {
    color: rgba(255,255,255,0.72);
    margin-top: 3px;
    font-size: 11px;
  }

  .content {
    padding: 0;
  }

  .departure {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 11px 14px;
    border-bottom: 1px solid var(--divider-color, #f0f0f0);
    transition: all .2s;
  }

  .departure:last-child {
    border-bottom: 0;
  }

  .departure.cancelled {
    opacity: .58;
  }

  .cancelled-badge {
    display: inline-flex;
    width: fit-content;
    margin-top: 4px;
    border: 1px solid #b91c1c;
    border-radius: 4px;
    padding: 1px 5px;
    color: #b91c1c;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 40px;
    border-radius: 6px;
    padding: 3px 7px;
    color: #fff;
    background: #334155;
    font-size: 13px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: opacity .2s;
    white-space: nowrap;
  }

  .badge.skm {
    background: var(--rail-skm-blue);
  }

  .badge.pkm {
    background: var(--rail-pkm-green);
  }

  .badge.ic { background: #b91c1c; }

  .main {
    flex: 1;
    min-width: 0;
  }

  .destination {
    color: var(--primary-text-color, #111);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 3px;
    color: var(--rail-muted);
    font-size: 11px;
    line-height: 1.35;
  }

  .dotsep {
    color: #94a3b8;
  }

  .time {
    flex-shrink: 0;
    min-width: 58px;
    text-align: right;
  }

  .clock {
    color: var(--primary-text-color, #111);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .time-sub {
    margin-top: 3px;
    color: var(--secondary-text-color, #888);
    font-size: 12px;
    font-weight: 400;
    white-space: nowrap;
  }

  .live-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 4px;
    border-radius: 50%;
    background: #10b981;
    vertical-align: 1px;
  }

  .planned {
    display: block;
    margin-top: 2px;
    color: var(--secondary-text-color, #888);
    font-size: 10px;
    text-decoration: line-through;
    white-space: nowrap;
  }

  .delay {
    display: block;
    margin-top: 2px;
    background: transparent;
    border-radius: 0;
    padding: 0;
    font-size: 12px;
    font-weight: 600;
  }

  .delay.late {
    color: var(--rail-pkm-orange);
  }

  .delay.early {
    color: var(--rail-skm-blue);
  }

  .brand-skm .header { background: var(--rail-skm-blue); }
  .brand-regio .header { background: var(--rail-pkm-green); }
  .brand-ic .header { background: #b91c1c; }
  .brand-neutral .header { background: #334155; }
  .brand-plk .header { background: #005aa9; }

  .brand-ic .badge.ic { background: #b91c1c; }
  .brand-neutral .badge,
  .brand-neutral .badge.skm,
  .brand-neutral .badge.pkm,
  .brand-neutral .badge.ic {
    background: #475569;
  }

  .next .header {
    padding: 15px 16px;
  }

  .next .departure {
    min-height: 78px;
    align-items: flex-start;
    padding: 14px 16px;
  }

  .next .badge {
    min-width: 46px;
    padding: 5px 8px;
    font-size: 15px;
  }

  .next .destination {
    font-size: 17px;
    font-weight: 750;
  }

  .next .meta {
    margin-top: 6px;
    font-size: 12px;
  }

  .next .clock {
    font-size: 24px;
    font-weight: 800;
  }

  .next .time-sub {
    font-size: 13px;
    font-weight: 650;
  }

  .warning {
    margin: 2px 0 8px;
    border: 1px solid #fde68a;
    border-radius: 6px;
    background: #fffbeb;
    color: #92400e;
    padding: 8px 10px;
    font-size: 12px;
  }

  .disruptions {
    display: grid;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--divider-color, #f0f0f0);
    background: #fffbeb;
  }

  .disruption {
    color: #92400e;
    font-size: 11px;
    line-height: 1.35;
  }

  .empty {
    padding: 28px 10px;
    text-align: center;
  }

  .empty-title {
    font-size: 15px;
    font-weight: 800;
  }

  .empty-message {
    margin-top: 6px;
    color: var(--rail-muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-top: 1px solid var(--divider-color, #f0f0f0);
    padding: 7px 14px;
    color: var(--secondary-text-color, #aaa);
    font-size: 10px;
  }

  .skeleton {
    min-height: 14px;
    border-radius: 999px;
    background: linear-gradient(90deg, #e5e7eb 0%, #f8fafc 50%, #e5e7eb 100%);
    background-size: 220% 100%;
    animation: shimmer 1.4s infinite;
  }

  .skeleton-row .badge {
    height: 28px;
    background: #e5e7eb;
  }

  .line { width: 100%; }
  .small-line { width: 52%; margin-top: 8px; }
  .time-skeleton { width: 58px; height: 18px; }

  .compact .header {
    padding: 9px 12px;
    gap: 8px;
  }

  .compact .icon {
    width: 24px;
    height: 24px;
  }

  .compact .icon svg {
    width: 19px;
    height: 19px;
  }

  .compact .content {
    padding: 0;
  }

  .compact .departure {
    min-height: 38px;
    padding: 7px 12px;
    gap: 10px;
  }

  .compact .badge {
    min-width: 34px;
    padding: 2px 6px;
    font-size: 12px;
  }

  .compact .subtitle,
  .compact .meta,
  .compact .time-sub,
  .compact .planned,
  .compact .cancelled-badge {
    display: none;
  }

  .compact .clock {
    font-size: 13px;
  }

  .e-ink {
    --rail-accent: #000;
    --rail-text: #000;
    --rail-muted: #333;
    --rail-border: #000;
    box-shadow: none;
    border: 1px solid #000;
    border-radius: 0;
    filter: grayscale(1);
    overflow: visible;
  }

  .e-ink .header {
    color: #000;
    background: #fff;
    border-bottom: 2px solid #000;
    padding: 12px 14px;
  }

  .e-ink .title,
  .e-ink .subtitle,
  .e-ink .icon,
  .e-ink .destination,
  .e-ink .clock,
  .e-ink .time-sub,
  .e-ink .planned,
  .e-ink .cancelled-badge,
  .e-ink .footer,
  .e-ink .empty {
    color: #000;
  }

  .e-ink .cancelled-badge {
    border-color: #000;
  }

  .e-ink .live-dot {
    display: none;
  }

  .e-ink .badge,
  .e-ink .badge.skm,
  .e-ink .badge.pkm,
  .e-ink .badge.ic {
    color: #000;
    background: #fff;
    border: 1px solid #000;
    box-shadow: none;
  }

  .e-ink .skeleton {
    animation: none;
    background: #eee;
  }

  .e-ink .disruptions {
    background: #fff;
    border-bottom-color: #000;
  }

  .e-ink .disruption {
    color: #000;
  }

  @keyframes shimmer {
    to { background-position-x: -220%; }
  }
`;

const EDITOR_STYLES = `
  :host {
    display: block;
    --editor-skm-blue: #005aa9;
    --editor-skm-yellow: #ffd200;
    --editor-pkm-green: #00843d;
    --editor-pkm-orange: #f58220;
    --editor-text: var(--primary-text-color, #111827);
    --editor-muted: var(--secondary-text-color, #64748b);
    --editor-border: var(--divider-color, #e2e8f0);
    --editor-accent: var(--accent-color, var(--editor-skm-blue));
    --editor-surface: var(--card-background-color, #fff);
    --editor-field: var(--input-fill-color, var(--secondary-background-color, #f8fafc));
    --editor-field-hover: color-mix(in srgb, var(--editor-field) 82%, var(--editor-text) 18%);
    --editor-selected: color-mix(in srgb, var(--editor-accent) 14%, transparent);
    color: var(--editor-text);
  }

  * {
    box-sizing: border-box;
  }

  .editor {
    display: grid;
    gap: 18px;
    min-width: 0;
  }

  section {
    display: grid;
    gap: 12px;
    border-top: 1px solid var(--editor-border);
    padding-top: 14px;
  }

  section:first-child {
    border-top: 0;
    padding-top: 0;
  }

  h3 {
    margin: 0;
    color: var(--editor-accent);
    font-size: 12px;
    font-weight: 850;
    letter-spacing: .04em;
    text-transform: uppercase;
  }

  label {
    display: grid;
    gap: 6px;
    font-size: 13px;
    font-weight: 700;
    min-width: 0;
  }

  input,
  select {
    appearance: none;
    box-sizing: border-box;
    width: 100%;
    min-height: 38px;
    border: 1px solid var(--editor-border);
    border-radius: 6px;
    background: var(--editor-field);
    color: var(--editor-text);
    font: inherit;
    font-weight: 500;
    padding: 8px 10px;
    min-width: 0;
  }

  input:focus,
  select:focus {
    border-color: var(--editor-accent);
    outline: 2px solid color-mix(in srgb, var(--editor-accent) 24%, transparent);
    outline-offset: 1px;
  }

  input::placeholder {
    color: var(--editor-muted);
    opacity: .78;
  }

  select {
    background-image:
      linear-gradient(45deg, transparent 50%, var(--editor-muted) 50%),
      linear-gradient(135deg, var(--editor-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 16px) 50%,
      calc(100% - 11px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    padding-right: 30px;
  }

  code {
    color: var(--editor-text);
    background: color-mix(in srgb, var(--editor-field) 82%, var(--editor-text) 18%);
    border-radius: 4px;
    padding: 1px 4px;
  }

  .hint,
  .field-error {
    color: var(--editor-muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .field-error {
    color: #b91c1c;
  }

  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
    min-width: 0;
  }

  .selected-station {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid color-mix(in srgb, var(--editor-accent) 34%, var(--editor-border));
    border-radius: 8px;
    background: var(--editor-selected);
    padding: 10px;
    min-width: 0;
  }

  .selected-name {
    font-size: 14px;
    font-weight: 850;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-id {
    margin-top: 2px;
    color: var(--editor-muted);
    font-size: 12px;
  }

  button {
    min-height: 32px;
    border: 1px solid var(--editor-border);
    border-radius: 6px;
    background: var(--editor-field);
    color: var(--editor-text);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 9px;
    min-width: 0;
  }

  button:hover {
    border-color: var(--editor-accent);
    color: var(--editor-accent);
    background: color-mix(in srgb, var(--editor-accent) 10%, var(--editor-field));
  }

  button:disabled {
    cursor: default;
    opacity: .55;
  }

  .results {
    display: grid;
    gap: 6px;
  }

  .result {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 40px;
    text-align: left;
  }

  .result span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result small {
    color: var(--editor-muted);
    font-weight: 700;
    flex-shrink: 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    min-height: 30px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip.selected {
    color: #fff;
    background: var(--editor-accent);
    border-color: var(--editor-accent);
    box-shadow: none;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 34px;
    border-top: 1px solid color-mix(in srgb, var(--editor-border) 72%, transparent);
    padding-top: 8px;
  }

  .switch-row input {
    width: 18px;
    min-height: 18px;
    flex-shrink: 0;
    accent-color: var(--editor-accent);
  }

  .segmented {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }

  .segmented button {
    min-height: 38px;
  }

  .segmented .active {
    color: #fff;
    background: var(--editor-accent);
    border-color: var(--editor-accent);
  }

  .diagnostics {
    display: grid;
    gap: 6px;
    border: 1px solid var(--editor-border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--editor-field) 74%, transparent);
    padding: 8px;
    color: var(--editor-muted);
    font-size: 12px;
  }

  .diag-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .diag-row span {
    color: #fff;
    border-radius: 999px;
    background: #64748b;
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .diag-row.ok span {
    background: #047857;
  }

  .diag-row.bad span {
    background: #b91c1c;
  }

  .diag-row strong {
    color: var(--editor-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diag-row small {
    color: var(--editor-muted);
  }

  @media (max-width: 520px) {
    .grid,
    .segmented {
      grid-template-columns: 1fr;
    }
  }
`;

if (!customElements.get("plk-rail-card")) {
  customElements.define("plk-rail-card", PlkRailCard);
}

if (!customElements.get("plk-rail-card-editor")) {
  customElements.define("plk-rail-card-editor", PlkRailCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "plk-rail-card",
  name: "PLK Rail Card",
  description: "PLK OpenData railway departures for Home Assistant",
});

