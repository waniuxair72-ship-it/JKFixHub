// ==========================================
// #PLATFORM_CONFIG_SERVICE
// ==========================================
// Canonical source of truth for JKFixHub platform controls, services, districts,
// maintenance notices, and audience-filtered announcements.
//
// Security Principles:
// 1. Reads ONLY minimal public operational fields from /platformConfig/public.
// 2. Announcements are filtered strictly by published status, schedule window, and audience.
// 3. Client-side checks improve UX; authoritative enforcement lives in Firestore Rules & Cloud Functions.
// 4. Gracefully falls back to safe defaults if Firestore is unavailable or config not yet seeded.
// ==========================================

import {
  initializeFirestoreClient,
  getFirestoreMethods
} from "./firebase-config.js";
import { setTextContent, normalizeService, SERVICE_SYNONYMS } from "./security.js";

export const NO_EXPIRY_MS = 8640000000000000;

/**
 * Expands disabled service names to include all lowercase canonical synonyms
 * so Firestore Security Rules block both canonical names and legacy aliases (e.g. "Plumbing" + "Plumber").
 */
export function expandDisabledServiceNames(services) {
  const disabledSet = new Set();
  for (const s of services || []) {
    if (!s || s.enabled !== false || typeof s.name !== "string") continue;
    const rawLower = s.name.trim().toLowerCase();
    const normLower = normalizeService(s.name).toLowerCase();
    if (rawLower) disabledSet.add(rawLower);
    if (normLower) disabledSet.add(normLower);
    for (const [alias, canonical] of Object.entries(SERVICE_SYNONYMS)) {
      if (canonical.toLowerCase() === rawLower || canonical.toLowerCase() === normLower) {
        disabledSet.add(alias.toLowerCase());
      }
    }
  }
  return [...disabledSet];
}

export const DEFAULT_JK_DISTRICTS = Object.freeze([
  "Anantnag",
  "Bandipora",
  "Baramulla",
  "Budgam",
  "Doda",
  "Ganderbal",
  "Jammu",
  "Kathua",
  "Kishtwar",
  "Kulgam",
  "Kupwara",
  "Poonch",
  "Pulwama",
  "Rajouri",
  "Ramban",
  "Reasi",
  "Samba",
  "Shopian",
  "Srinagar",
  "Udhampur"
]);

export const DEFAULT_SERVICES = Object.freeze([
  { id: "electrician", name: "Electrician", description: "Wiring, inverters, switches & electrical repairs", enabled: true },
  { id: "plumbing", name: "Plumbing", description: "Pipes, leaks, taps & sanitary fittings", enabled: true },
  { id: "carpentry", name: "Carpentry", description: "Doors, furniture & custom woodwork", enabled: true },
  { id: "appliance-repair", name: "Appliance repair", description: "General home appliance diagnostics & servicing", enabled: true },
  { id: "washing-machine-repair", name: "Washing Machine Repair", description: "Motors, drainage & spin repairs", enabled: true },
  { id: "refrigerator-repair", name: "Refrigerator Repair", description: "Cooling, compressors & gas refills", enabled: true },
  { id: "heater-repair", name: "Heater Repair", description: "Geysers, room heaters & heating elements", enabled: true },
  { id: "tv-electronics-repair", name: "TV / Electronics Repair", description: "LED panels, audio & circuit boards", enabled: true }
]);

export function slugifyId(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export function buildDefaultPlatformConfig() {
  return {
    maintenanceMode: false,
    maintenanceMessage: "JK FixHub is currently undergoing scheduled maintenance. Essential account and support access remain available.",
    maintenanceStart: null,
    maintenanceEnd: null,
    customerRegistrationEnabled: true,
    workerRegistrationEnabled: true,
    newRequestsEnabled: true,
    newRequestsPauseMessage: "New service requests are temporarily paused while we update operations. Your existing requests remain accessible.",
    services: DEFAULT_SERVICES.map((s) => ({ ...s })),
    disabledServices: [],
    districts: DEFAULT_JK_DISTRICTS.map((name) => ({
      id: slugifyId(name),
      name,
      enabled: true
    })),
    disabledDistricts: [],
    updatedAt: null
  };
}

let cachedPlatformConfig = buildDefaultPlatformConfig();
let configLoadedAt = 0;
let configInflight = null;
const CONFIG_CACHE_TTL_MS = 20000;
const configListeners = new Set();

/**
 * Normalizes a raw Firestore platformConfig/public payload safely against defaults.
 */
export function normalizePlatformConfig(raw) {
  const defaults = buildDefaultPlatformConfig();
  if (!raw || typeof raw !== "object") return defaults;

  const services = Array.isArray(raw.services) && raw.services.length > 0
    ? raw.services
        .filter((s) => s && typeof s.name === "string" && s.name.trim())
        .map((s) => ({
          id: s.id || slugifyId(s.name),
          name: s.name.trim(),
          description: typeof s.description === "string" ? s.description.trim() : "",
          enabled: s.enabled !== false,
          updatedAt: s.updatedAt || null
        }))
    : defaults.services;

  const districts = Array.isArray(raw.districts) && raw.districts.length > 0
    ? raw.districts
        .filter((d) => d && typeof d.name === "string" && d.name.trim())
        .map((d) => ({
          id: d.id || slugifyId(d.name),
          name: d.name.trim(),
          enabled: d.enabled !== false,
          updatedAt: d.updatedAt || null
        }))
    : defaults.districts;

  const disabledServices = expandDisabledServiceNames(services);

  const disabledDistricts = districts
    .filter((d) => d.enabled === false)
    .map((d) => d.name.toLowerCase());

  return {
    maintenanceMode: Boolean(raw.maintenanceMode),
    maintenanceMessage:
      typeof raw.maintenanceMessage === "string" && raw.maintenanceMessage.trim()
        ? raw.maintenanceMessage.trim()
        : defaults.maintenanceMessage,
    maintenanceStart: raw.maintenanceStart || null,
    maintenanceEnd: raw.maintenanceEnd || null,
    customerRegistrationEnabled: raw.customerRegistrationEnabled !== false,
    workerRegistrationEnabled: raw.workerRegistrationEnabled !== false,
    newRequestsEnabled: raw.newRequestsEnabled !== false,
    newRequestsPauseMessage:
      typeof raw.newRequestsPauseMessage === "string" && raw.newRequestsPauseMessage.trim()
        ? raw.newRequestsPauseMessage.trim()
        : defaults.newRequestsPauseMessage,
    services,
    disabledServices,
    districts,
    disabledDistricts,
    updatedAt: raw.updatedAt || null
  };
}

/**
 * Returns the currently cached platform config synchronously (always valid).
 */
export function getCachedPlatformConfig() {
  return cachedPlatformConfig;
}

/**
 * Allows tests or real-time updates to set the in-memory config cache directly.
 */
export function setCachedPlatformConfig(rawConfig) {
  cachedPlatformConfig = normalizePlatformConfig(rawConfig);
  configLoadedAt = Date.now();
  notifyConfigListeners(cachedPlatformConfig);
  return cachedPlatformConfig;
}

export function invalidatePlatformConfigCache() {
  configLoadedAt = 0;
}

export function subscribePlatformConfig(listener) {
  if (typeof listener !== "function") return () => {};
  configListeners.add(listener);
  return () => configListeners.delete(listener);
}

function notifyConfigListeners(config) {
  for (const fn of configListeners) {
    try {
      fn(config);
    } catch (err) {
      console.warn("[JKFixHub PlatformConfig] Listener error:", err);
    }
  }
}

/**
 * Loads /platformConfig/public from Firestore with short cache and safe fallback.
 */
export async function loadPlatformConfig({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && configLoadedAt > 0 && now - configLoadedAt < CONFIG_CACHE_TTL_MS) {
    return cachedPlatformConfig;
  }

  if (configInflight && !forceRefresh) {
    return configInflight;
  }

  configInflight = (async () => {
    try {
      const { db } = await initializeFirestoreClient();
      const methods = await getFirestoreMethods();
      if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function") {
        return cachedPlatformConfig;
      }

      const ref = methods.doc(db, "platformConfig", "public");
      const snap = await methods.getDoc(ref);
      const exists = snap && (typeof snap.exists === "function" ? snap.exists() : Boolean(snap.exists));
      if (exists) {
        const data = typeof snap.data === "function" ? snap.data() : snap.data;
        cachedPlatformConfig = normalizePlatformConfig(data);
        configLoadedAt = Date.now();
        notifyConfigListeners(cachedPlatformConfig);
      } else {
        configLoadedAt = Date.now();
      }
      return cachedPlatformConfig;
    } catch (err) {
      console.warn("[JKFixHub PlatformConfig] Fallback to default config:", err?.message || err);
      return cachedPlatformConfig;
    } finally {
      configInflight = null;
    }
  })();

  return configInflight;
}

/**
 * Evaluates whether Maintenance Mode is currently active, respecting optional schedule window.
 */
export function isMaintenanceCurrentlyActive(config = cachedPlatformConfig, nowMs = Date.now()) {
  if (!config || !config.maintenanceMode) return false;

  if (config.maintenanceStart) {
    const startMs = Date.parse(config.maintenanceStart);
    if (!Number.isNaN(startMs) && nowMs < startMs) {
      return false;
    }
  }
  if (config.maintenanceEnd) {
    const endMs = Date.parse(config.maintenanceEnd);
    if (!Number.isNaN(endMs) && nowMs > endMs) {
      return false;
    }
  }
  return true;
}

export function getEnabledServices(config = cachedPlatformConfig) {
  return (config?.services || DEFAULT_SERVICES).filter((s) => s.enabled !== false);
}

export function getAllConfiguredServices(config = cachedPlatformConfig) {
  return config?.services || DEFAULT_SERVICES;
}

export function getEnabledDistricts(config = cachedPlatformConfig) {
  return (config?.districts || []).filter((d) => d.enabled !== false);
}

export function getAllConfiguredDistricts(config = cachedPlatformConfig) {
  return config?.districts || DEFAULT_JK_DISTRICTS.map((name) => ({ id: slugifyId(name), name, enabled: true }));
}

export function isServiceCurrentlyEnabled(serviceName, config = cachedPlatformConfig) {
  if (!serviceName || typeof serviceName !== "string") return false;
  const rawLower = serviceName.trim().toLowerCase();
  const normLower = normalizeService(serviceName).toLowerCase();
  const services = config?.services || DEFAULT_SERVICES;

  const match = services.find((s) => {
    const sLower = s.name.trim().toLowerCase();
    const sNorm = normalizeService(s.name).toLowerCase();
    return sLower === rawLower || sNorm === normLower;
  });

  if (!match) {
    // Unknown custom service: check disabled list defensively
    const disabled = config?.disabledServices || [];
    return !disabled.includes(rawLower) && !disabled.includes(normLower);
  }
  return match.enabled !== false;
}

export function isDistrictCurrentlyEnabled(districtName, config = cachedPlatformConfig) {
  if (!districtName || typeof districtName !== "string") return false;
  const lower = districtName.trim().toLowerCase();
  const districts = config?.districts || [];
  const match = districts.find((d) => d.name.trim().toLowerCase() === lower);
  if (!match) {
    const disabled = config?.disabledDistricts || [];
    return !disabled.includes(lower);
  }
  return match.enabled !== false;
}

/**
 * Pure filter function determining if an announcement is visible to a given audience at nowMs.
 * Strictly blocks draft, paused, archived, expired, future-scheduled, and wrong-audience entries.
 */
export function isAnnouncementVisibleToAudience(announcement, audience, nowMs = Date.now()) {
  if (!announcement || typeof announcement !== "object") return false;
  if (announcement.status !== "published") return false;

  const target = String(announcement.audience || "everyone").toLowerCase();
  const userAud = String(audience || "").toLowerCase();
  if (target !== "everyone" && target !== userAud) {
    return false;
  }

  // Publish date check
  if (announcement.publishAtMs && typeof announcement.publishAtMs === "number") {
    if (nowMs < announcement.publishAtMs) return false;
  } else if (announcement.publishAt) {
    const pMs = Date.parse(announcement.publishAt);
    if (!Number.isNaN(pMs) && nowMs < pMs) return false;
  }

  // Expiry date check
  if (announcement.expiresAtMs && typeof announcement.expiresAtMs === "number") {
    if (nowMs >= announcement.expiresAtMs) return false;
  } else if (announcement.expiresAt) {
    const eMs = Date.parse(announcement.expiresAt);
    if (!Number.isNaN(eMs) && nowMs >= eMs) return false;
  }

  return true;
}

/**
 * Loads active published announcements for a specific audience ('customers' | 'workers').
 */
export async function fetchActiveAnnouncementsForAudience(audience) {
  if (!audience || (audience !== "customers" && audience !== "workers")) return [];

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.collection !== "function" || typeof methods.getDocs !== "function") {
      return [];
    }

    const colRef = methods.collection(db, "announcements");
    let queryRef = colRef;
    if (typeof methods.query === "function" && typeof methods.where === "function") {
      queryRef = methods.query(
        colRef,
        methods.where("status", "==", "published"),
        methods.where("audience", "in", ["everyone", audience])
      );
    }

    const snap = await methods.getDocs(queryRef);
    const items = [];
    const nowMs = Date.now();
    if (snap && typeof snap.forEach === "function") {
      snap.forEach((doc) => {
        const data = typeof doc.data === "function" ? doc.data() : doc;
        const entry = { id: doc.id, ...data };
        if (isAnnouncementVisibleToAudience(entry, audience, nowMs)) {
          items.push(entry);
        }
      });
    }

    const priorityRank = { urgent: 0, important: 1, normal: 2 };
    items.sort((a, b) => {
      const rankDiff = (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2);
      if (rankDiff !== 0) return rankDiff;
      const aTime = Date.parse(a.publishAt || a.createdAt || 0) || 0;
      const bTime = Date.parse(b.publishAt || b.createdAt || 0) || 0;
      return bTime - aTime;
    });

    return items;
  } catch (err) {
    console.warn("[JKFixHub Announcements] Could not fetch announcements:", err?.message || err);
    return [];
  }
}

/**
 * Formats an ISO or timestamp date cleanly for announcement badges.
 */
function formatAnnouncementDate(raw) {
  if (!raw) return "";
  try {
    const d = typeof raw?.toDate === "function" ? raw.toDate() : new Date(raw);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Renders inline announcements inside a dashboard container without popups.
 */
export function renderAnnouncementsIntoContainer(container, announcements) {
  if (!container) return;
  container.replaceChildren();

  if (!Array.isArray(announcements) || announcements.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  const heading = document.createElement("div");
  heading.className = "dashboard-announcements-header";
  const h3 = document.createElement("h3");
  h3.className = "dashboard-announcements-title";
  setTextContent(h3, "Platform Announcements");
  const countBadge = document.createElement("span");
  countBadge.className = "dashboard-announcements-count";
  setTextContent(countBadge, `${announcements.length}`);
  heading.append(h3, countBadge);
  container.appendChild(heading);

  const list = document.createElement("div");
  list.className = "dashboard-announcements-list";

  for (const item of announcements) {
    const priority = ["urgent", "important", "normal"].includes(item.priority) ? item.priority : "normal";
    const card = document.createElement("article");
    card.className = `dashboard-announcement-card priority-${priority}`;
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", item.title || "Platform announcement");

    const topRow = document.createElement("div");
    topRow.className = "dashboard-announcement-top";

    const badge = document.createElement("span");
    badge.className = `announcement-priority-badge priority-${priority}`;
    setTextContent(badge, priority === "urgent" ? "Urgent" : priority === "important" ? "Important" : "Update");

    const titleEl = document.createElement("strong");
    titleEl.className = "dashboard-announcement-heading";
    setTextContent(titleEl, item.title || "Announcement");

    topRow.append(badge, titleEl);

    const msgEl = document.createElement("p");
    msgEl.className = "dashboard-announcement-message";
    setTextContent(msgEl, item.message || "");

    const metaRow = document.createElement("div");
    metaRow.className = "dashboard-announcement-meta";
    const pubDate = formatAnnouncementDate(item.publishAt || item.createdAt);
    if (pubDate) {
      const pubSpan = document.createElement("span");
      setTextContent(pubSpan, `Published ${pubDate}`);
      metaRow.appendChild(pubSpan);
    }
    const expDate = formatAnnouncementDate(item.expiresAt);
    if (expDate) {
      const expSpan = document.createElement("span");
      setTextContent(expSpan, `Valid until ${expDate}`);
      metaRow.appendChild(expSpan);
    }

    card.append(topRow, msgEl, metaRow);
    list.appendChild(card);
  }

  container.appendChild(list);
}

/**
 * Renders or hides the top platform maintenance banner on index.html.
 * Keeps essential account and support access accessible.
 */
export function renderPlatformMaintenanceBanner(config = cachedPlatformConfig) {
  if (typeof document === "undefined") return;
  let banner = document.getElementById("platformMaintenanceBanner");
  const active = isMaintenanceCurrentlyActive(config);

  if (!active) {
    if (banner) banner.hidden = true;
    return;
  }

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "platformMaintenanceBanner";
    banner.className = "platform-maintenance-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    const header = document.querySelector("header.site-header, header.topbar") || document.body.firstChild;
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
      document.body.prepend(banner);
    }
  }

  banner.hidden = false;
  banner.replaceChildren();

  const inner = document.createElement("div");
  inner.className = "platform-maintenance-inner";

  const icon = document.createElement("span");
  icon.className = "platform-maintenance-icon";
  icon.setAttribute("aria-hidden", "true");
  setTextContent(icon, "🛠️");

  const textWrap = document.createElement("div");
  textWrap.className = "platform-maintenance-text";

  const strong = document.createElement("strong");
  setTextContent(strong, "Scheduled Platform Maintenance");

  const desc = document.createElement("span");
  let msg = config.maintenanceMessage || "JK FixHub is undergoing scheduled updates.";
  if (config.maintenanceEnd) {
    try {
      const endD = new Date(config.maintenanceEnd);
      if (!Number.isNaN(endD.getTime())) {
        msg += ` Expected completion: ${endD.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
      }
    } catch (_) {}
  }
  setTextContent(desc, msg);

  textWrap.append(strong, desc);
  inner.append(icon, textWrap);
  banner.appendChild(inner);
}

/**
 * Synchronizes <select> dropdowns for services and districts with active platform config.
 */
export function syncPlatformDropdowns(config = cachedPlatformConfig) {
  if (typeof document === "undefined") return;

  const enabledServices = getEnabledServices(config);
  const allServices = getAllConfiguredServices(config);
  const enabledDistricts = getEnabledDistricts(config);

  // 1. District selects for registration & search
  const districtSelectIds = [
    { id: "authCustomerDistrict", includeAll: false, placeholder: "Select your district" },
    { id: "authWorkerDistrict", includeAll: false, placeholder: "Select your primary district" },
    { id: "districtFilter", includeAll: true, placeholder: "All districts" }
  ];

  for (const cfg of districtSelectIds) {
    const sel = document.getElementById(cfg.id);
    if (!sel) continue;
    const prevVal = sel.value;
    sel.replaceChildren();

    const firstOpt = document.createElement("option");
    firstOpt.value = "";
    setTextContent(firstOpt, cfg.placeholder);
    sel.appendChild(firstOpt);

    for (const dist of enabledDistricts) {
      const opt = document.createElement("option");
      opt.value = dist.name;
      setTextContent(opt, dist.name);
      sel.appendChild(opt);
    }

    if (prevVal && enabledDistricts.some((d) => d.name === prevVal)) {
      sel.value = prevVal;
    }
  }

  // 2. Worker Registration & Request service selects (enabled services only for new creation)
  const serviceSelectIds = [
    { id: "authWorkerService", includeAll: false, placeholder: "Select primary service", showDisabled: false },
    { id: "requestService", includeAll: false, placeholder: null, showDisabled: true },
    { id: "serviceFilter", includeAll: true, placeholder: "All services", showDisabled: true }
  ];

  for (const cfg of serviceSelectIds) {
    const sel = document.getElementById(cfg.id);
    if (!sel) continue;
    const prevVal = sel.value;
    sel.replaceChildren();

    if (cfg.placeholder) {
      const firstOpt = document.createElement("option");
      firstOpt.value = "";
      setTextContent(firstOpt, cfg.placeholder);
      sel.appendChild(firstOpt);
    }

    const list = cfg.showDisabled ? allServices : enabledServices;
    for (const svc of list) {
      const opt = document.createElement("option");
      opt.value = svc.name;
      if (svc.enabled === false) {
        opt.disabled = true;
        setTextContent(opt, `${svc.name} (Currently Unavailable)`);
      } else {
        setTextContent(opt, svc.name);
      }
      sel.appendChild(opt);
    }

    if (prevVal && list.some((s) => s.name === prevVal && s.enabled !== false)) {
      sel.value = prevVal;
    }
  }

  // 3. Annotate smart home category cards if a category is disabled
  document.querySelectorAll(".smart-category-card[data-service]").forEach((card) => {
    const svcName = card.getAttribute("data-service");
    const available = isServiceCurrentlyEnabled(svcName, config);
    card.classList.toggle("service-unavailable", !available);
    card.setAttribute("aria-disabled", available ? "false" : "true");
    let badge = card.querySelector(".service-unavailable-pill");
    if (!available) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "service-unavailable-pill";
        setTextContent(badge, "Unavailable");
        card.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  });
}
