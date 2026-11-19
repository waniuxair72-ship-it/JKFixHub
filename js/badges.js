// ==========================================
// #VERIFICATION_BADGES
// ==========================================
// Two distinct, original verification badge designs for JKFixHub:
//   1. JKFixHub Verified Customer     (Royal-Blue Octagonal Identity Emblem)
//   2. JKFixHub Verified Professional (Emerald-Teal Pointed Craftsman Shield)
//
// Security Principles:
// - Never render badges for unverified, pending, rejected, or revoked accounts.
// - Authoritative public badge lookup reads ONLY minimal /verifiedBadges/{uid}
//   (contains zero private PII; admin-write-only; instantly cleared on revoke).
// - Uses safe SVG DOM creation (createElementNS) — zero innerHTML injection.
// ==========================================

import { initializeFirestoreClient, getFirestoreMethods } from "./firebase-config.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const BADGE_META = Object.freeze({
  customer: {
    id: "verified_customer",
    name: "JKFixHub Verified Customer",
    shortLabel: "Verified Customer",
    tooltip: "JKFixHub Verified Customer — Identity manually verified by JKFixHub administration."
  },
  worker: {
    id: "verified_professional",
    name: "JKFixHub Verified Professional",
    shortLabel: "Verified Professional",
    tooltip: "JKFixHub Verified Professional — Professional details manually verified by JKFixHub administration."
  }
});

// Lightweight in-memory cache of public /verifiedBadges/{uid} lookups (cleared on revoke/logout)
const badgeCache = new Map();
const BADGE_CACHE_TTL_MS = 5000;

export function setCachedBadgeStatus(uid, badgeRecord) {
  if (!uid) return;
  badgeCache.set(String(uid), {
    data: badgeRecord || null,
    loadedAt: Date.now()
  });
}

export function clearCachedBadgeStatus(uid) {
  if (!uid) {
    badgeCache.clear();
  } else {
    badgeCache.delete(String(uid));
  }
}

/**
 * Fetches minimal public badge state from /verifiedBadges/{uid} (admin-write-only, zero PII).
 * Returns null if unverified, revoked, or unavailable.
 */
export async function fetchPublicVerifiedBadge(uid, { forceRefresh = false } = {}) {
  if (!uid) return null;
  const key = String(uid);
  const cached = badgeCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.loadedAt < BADGE_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { db } = await initializeFirestoreClient();
    const methods = await getFirestoreMethods();
    if (!db || !methods || typeof methods.doc !== "function" || typeof methods.getDoc !== "function") {
      return cached ? cached.data : null;
    }
    const snap = await methods.getDoc(methods.doc(db, "verifiedBadges", key));
    if (snap && snap.exists()) {
      const data = snap.data();
      if (data && data.verified === true) {
        setCachedBadgeStatus(key, data);
        return data;
      }
    }
    setCachedBadgeStatus(key, null);
    return null;
  } catch {
    return cached ? cached.data : null;
  }
}

/**
 * Batch-hydrates public /verifiedBadges records for a list of UIDs safely.
 */
export async function hydratePublicBadgesForUids(uids, { forceRefresh = false } = {}) {
  const unique = [...new Set((uids || []).filter(Boolean).map(String))];
  const results = new Map();
  await Promise.all(
    unique.map(async (uid) => {
      const rec = await fetchPublicVerifiedBadge(uid, { forceRefresh });
      if (rec && rec.verified === true) {
        results.set(uid, rec);
      }
    })
  );
  return results;
}

function createSvgElement(tag, attrs = {}) {
  const el = typeof document.createElementNS === "function"
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Builds the upgraded Octagonal Identity Emblem SVG for JKFixHub Verified Customer.
 * Silhouette: 8-point faceted identity medallion with concentric inner rim and bold verification checkmark.
 */
function buildCustomerBadgeSvg(size = 16) {
  const svg = createSvgElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    class: "jk-badge-svg jk-badge-svg-customer"
  });
  // Faceted octagonal identity medallion
  svg.appendChild(createSvgElement("polygon", {
    points: "7,2 17,2 22,7 22,17 17,22 7,22 2,17 2,7",
    fill: "currentColor",
    "fill-opacity": "0.16",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linejoin": "round"
  }));
  // Subtle concentric inner rim
  svg.appendChild(createSvgElement("circle", {
    cx: "12",
    cy: "12",
    r: "7.2",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.1",
    opacity: "0.25"
  }));
  // Bold, crisp, centered verification checkmark
  svg.appendChild(createSvgElement("path", {
    d: "M7.8 12.3l2.9 2.9 5.8-6.2",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.3",
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  }));
  return svg;
}

/**
 * Builds the upgraded Pointed Craftsman Shield SVG for JKFixHub Verified Professional.
 * Silhouette: Pointed artisan shield with inner crest contour, top pip & bold verification checkmark.
 */
function buildWorkerBadgeSvg(size = 16) {
  const svg = createSvgElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    class: "jk-badge-svg jk-badge-svg-worker"
  });
  // Pointed craftsman artisan shield
  svg.appendChild(createSvgElement("path", {
    d: "M12 2L4 5.2v6.2c0 5.1 3.4 9.7 8 10.8 4.6-1.1 8-5.7 8-10.8V5.2L12 2z",
    fill: "currentColor",
    "fill-opacity": "0.16",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linejoin": "round"
  }));
  // Inner craftsman shield contour
  svg.appendChild(createSvgElement("path", {
    d: "M12 4.4L6 6.9v4.4c0 4 2.5 7.5 6 8.4 3.5-0.9 6-4.4 6-8.4V6.9L12 4.4z",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1",
    opacity: "0.25"
  }));
  // Top crest pip
  svg.appendChild(createSvgElement("circle", {
    cx: "12",
    cy: "6.4",
    r: "1.1",
    fill: "currentColor"
  }));
  // Bold, crisp, centered verification checkmark
  svg.appendChild(createSvgElement("path", {
    d: "M8 12.3l2.8 2.8 5.4-5.6",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.3",
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  }));
  return svg;
}

/**
 * Creates a JKFixHub Verified Customer badge element.
 * @param {object} [options]
 * @param {boolean} [options.compact=false] - Icon-only micro badge beside names.
 * @param {boolean} [options.fullName=false] - Show full "JKFixHub Verified Customer" text.
 * @returns {HTMLSpanElement}
 */
export function createVerifiedCustomerBadge({ compact = false, fullName = false } = {}) {
  const meta = BADGE_META.customer;
  const el = document.createElement("span");
  el.className = `jk-verified-badge jk-badge-customer${compact ? " is-compact" : ""}`;
  el.setAttribute("title", meta.tooltip);
  el.setAttribute("aria-label", meta.tooltip);
  el.setAttribute("data-badge-type", meta.id);

  el.appendChild(buildCustomerBadgeSvg(compact ? 14 : 16));
  if (!compact) {
    const label = document.createElement("span");
    label.className = "jk-badge-label";
    label.textContent = fullName ? meta.name : meta.shortLabel;
    el.appendChild(label);
  }
  return el;
}

/**
 * Creates a JKFixHub Verified Professional badge element.
 * @param {object} [options]
 * @param {boolean} [options.compact=false] - Icon-only micro badge beside names.
 * @param {boolean} [options.fullName=false] - Show full "JKFixHub Verified Professional" text.
 * @returns {HTMLSpanElement}
 */
export function createVerifiedWorkerBadge({ compact = false, fullName = false } = {}) {
  const meta = BADGE_META.worker;
  const el = document.createElement("span");
  el.className = `jk-verified-badge jk-badge-worker${compact ? " is-compact" : ""}`;
  el.setAttribute("title", meta.tooltip);
  el.setAttribute("aria-label", meta.tooltip);
  el.setAttribute("data-badge-type", meta.id);

  el.appendChild(buildWorkerBadgeSvg(compact ? 14 : 16));
  if (!compact) {
    const label = document.createElement("span");
    label.className = "jk-badge-label";
    label.textContent = fullName ? meta.name : meta.shortLabel;
    el.appendChild(label);
  }
  return el;
}

let mountTokenSeq = 0;

/**
 * Mounts or clears an authoritative public verification badge inside a target container.
 * Disappears immediately when badge is absent or revoked. Guards against out-of-order async renders.
 *
 * Canonical signature: mountPublicBadgeIfVerified(container, uid, expectedRole, options)
 */
export async function mountPublicBadgeIfVerified(container, uid, expectedRole, options = {}) {
  // Defensive support if caller passes (uid, container, opts)
  let targetEl = container;
  let targetUid = uid;
  let roleFilter = expectedRole;
  let opts = options;
  if (typeof container === "string" && uid && typeof uid === "object" && "replaceChildren" in uid) {
    targetUid = container;
    targetEl = uid;
    opts = (expectedRole && typeof expectedRole === "object") ? expectedRole : {};
    roleFilter = opts.expectedRole || null;
  }

  if (!targetEl || typeof targetEl.replaceChildren !== "function") return;
  const token = String(++mountTokenSeq);
  if (targetEl.dataset) targetEl.dataset.badgeMountToken = token;
  targetEl.replaceChildren();
  if (!targetUid) return;

  const rec = await fetchPublicVerifiedBadge(targetUid, { forceRefresh: Boolean(opts?.forceRefresh) });
  if (targetEl.dataset && targetEl.dataset.badgeMountToken !== token) return;
  if (!rec || rec.verified !== true) {
    targetEl.replaceChildren();
    return;
  }
  if (roleFilter && rec.role && rec.role !== roleFilter) {
    targetEl.replaceChildren();
    return;
  }
  const badge = (roleFilter === "customer" || rec.role === "customer")
    ? createVerifiedCustomerBadge(opts)
    : createVerifiedWorkerBadge(opts);
  targetEl.replaceChildren(badge);
}
