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
 * Builds the original Octagonal Identity Emblem SVG for JKFixHub Verified Customer.
 * Silhouette: Faceted octagon with customer identity profile + check accent (distinct royal blue).
 */
function buildCustomerBadgeSvg(size = 16) {
  const svg = createSvgElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    class: "jk-badge-svg jk-badge-svg-customer"
  });
  // Faceted octagonal seal
  svg.appendChild(createSvgElement("polygon", {
    points: "7.5,2 16.5,2 22,7.5 22,16.5 16.5,22 7.5,22 2,16.5 2,7.5",
    fill: "currentColor",
    opacity: "0.14",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linejoin": "round"
  }));
  // Customer identity head + shoulders + precision verification check
  svg.appendChild(createSvgElement("circle", {
    cx: "10.5",
    cy: "9",
    r: "2.6",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8"
  }));
  svg.appendChild(createSvgElement("path", {
    d: "M6.5 16.8c.6-2.2 2.2-3.3 4-3.3 1.2 0 2.2.4 2.9 1.2",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round"
  }));
  svg.appendChild(createSvgElement("path", {
    d: "M14.2 14.8l1.6 1.6 3.1-3.4",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  }));
  return svg;
}

/**
 * Builds the original Pointed Craftsman Shield SVG for JKFixHub Verified Professional.
 * Silhouette: Pointed artisan shield with inner craft emblem & checkmark (distinct emerald teal).
 */
function buildWorkerBadgeSvg(size = 16) {
  const svg = createSvgElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    class: "jk-badge-svg jk-badge-svg-worker"
  });
  // Pointed professional shield silhouette
  svg.appendChild(createSvgElement("path", {
    d: "M12 2.2L4.2 5.4v5.8c0 5.1 3.3 9.4 7.8 10.8 4.5-1.4 7.8-5.7 7.8-10.8V5.4L12 2.2z",
    fill: "currentColor",
    opacity: "0.15",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linejoin": "round"
  }));
  // Inner precision craft diamond + check
  svg.appendChild(createSvgElement("path", {
    d: "M8.8 12.1l2.2 2.2 4.5-4.7",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.1",
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  }));
  svg.appendChild(createSvgElement("circle", {
    cx: "12",
    cy: "6.4",
    r: "1",
    fill: "currentColor"
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

  el.appendChild(buildCustomerBadgeSvg(compact ? 15 : 16));
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

  el.appendChild(buildWorkerBadgeSvg(compact ? 15 : 16));
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
