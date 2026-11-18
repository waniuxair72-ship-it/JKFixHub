// ==========================================
// #MEMBERSHIP_AND_TRUST_SEPARATION
// ==========================================
// Architectural foundation for future JKFixHub Pro membership.
//
// STRICT SEPARATION INVARIANTS (Phase 6):
// 1. Official Verification Status (admin-granted identity/craft trust) is 100% independent
//    of paid membership. A paid worker NEVER automatically becomes verified.
// 2. Paid Membership Status is currently inert ("free" / "inactive"). No payments,
//    subscriptions, billing changes, or charges are active.
// 3. Promotional Ranking / Placement is strictly disabled (enabled: false, weight: 0).
//    Organic discovery and genuine verified trust signals remain completely untouched.
// ==========================================

export const VERIFICATION_STATUSES = Object.freeze([
  "Not Verified",
  "Pending",
  "Verified",
  "Rejected",
  "Revoked"
]);

export const MEMBERSHIP_TIERS = Object.freeze({
  FREE: "free",
  PRO_RESERVED: "pro" // Reserved for future explicit activation only
});

export const MEMBERSHIP_STATUSES = Object.freeze({
  INACTIVE: "inactive",
  ACTIVE: "active",
  EXPIRED: "expired",
  CANCELLED: "cancelled"
});

/**
 * Returns the default inert future-membership block (no active paid features).
 */
export function buildDefaultMembershipState() {
  return {
    tier: MEMBERSHIP_TIERS.FREE,
    status: MEMBERSHIP_STATUSES.INACTIVE,
    billingProvider: null,
    startedAt: null,
    expiresAt: null
  };
}

/**
 * Returns the default disabled promotional placement block (zero ranking impact).
 */
export function buildDefaultPromotionalPlacement() {
  return {
    enabled: false,
    districts: [],
    services: [],
    rankingWeight: 0
  };
}

/**
 * Canonical fail-closed check for whether a customer holds an active official
 * JKFixHub Verified Customer badge. A stale standalone `isVerified: true` flag
 * without `customerVerification.status === "Verified"` NEVER grants a badge.
 */
export function isCustomerOfficiallyVerified(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return false;
  if (rawUser.status === "deleted") return false;
  if (rawUser.isVerified === false) return false;
  return rawUser.customerVerification?.status === "Verified";
}

/**
 * Canonical fail-closed check for whether a worker holds an active official
 * JKFixHub Verified Professional badge.
 * - If `workerVerification` is present, its `status` MUST be `"Verified"` AND `isVerified !== false`.
 *   A stale `isVerified: true` NEVER overrides `"Revoked"`, `"Rejected"`, `"Pending"`, or `"Not Verified"`.
 * - If `workerVerification` is absent (pre-backfill legacy worker), falls back to `isVerified === true`.
 * - Deleted or rejected worker accounts are NEVER verified.
 */
export function isWorkerOfficiallyVerified(rawWorker) {
  if (!rawWorker || typeof rawWorker !== "object") return false;
  if (rawWorker.status === "deleted" || rawWorker.status === "rejected") return false;
  if (rawWorker.isVerified === false) return false;
  const wv = rawWorker.workerVerification;
  if (wv && typeof wv === "object" && typeof wv.status === "string" && wv.status.trim()) {
    return wv.status.trim() === "Verified" && rawWorker.isVerified !== false;
  }
  return rawWorker.isVerified === true;
}

/**
 * Normalizes a customer verification record safely without inventing verified status.
 * Registration or photo upload NEVER auto-verifies an account.
 */
export function normalizeCustomerVerification(rawUser) {
  const cv = rawUser?.customerVerification;
  const rawStatus = typeof cv?.status === "string" ? cv.status.trim() : "Not Verified";
  const validStatus = VERIFICATION_STATUSES.includes(rawStatus) ? rawStatus : "Not Verified";
  const verified = isCustomerOfficiallyVerified(rawUser);
  const status = verified ? "Verified" : (validStatus === "Verified" ? "Revoked" : validStatus);
  return {
    status,
    isVerified: verified,
    verifiedAt: verified ? (cv?.verifiedAt || null) : null,
    verifiedBy: cv?.verifiedBy || null,
    updatedAt: cv?.updatedAt || null,
    internalNote: typeof cv?.internalNote === "string" ? cv.internalNote : "",
    rejectionReason: typeof cv?.rejectionReason === "string" ? cv.rejectionReason : "",
    history: Array.isArray(cv?.history) ? cv.history : []
  };
}

/**
 * Normalizes a worker professional verification record alongside existing isVerified flag.
 * Paid membership NEVER influences verification status.
 * A stale `isVerified: true` NEVER overrides an explicit Revoked/Rejected/Pending status.
 */
export function normalizeWorkerVerification(rawWorker) {
  const wv = rawWorker?.workerVerification;
  let status;
  if (rawWorker?.status === "deleted") {
    status = "Revoked";
  } else if (typeof wv?.status === "string" && VERIFICATION_STATUSES.includes(wv.status.trim())) {
    status = wv.status.trim();
  } else if (rawWorker?.status === "rejected") {
    status = "Rejected";
  } else if (rawWorker?.isVerified === true) {
    status = "Verified";
  } else if (rawWorker?.status === "pending") {
    status = "Pending";
  } else {
    status = "Not Verified";
  }
  const verified = isWorkerOfficiallyVerified(rawWorker);
  return {
    status: verified ? "Verified" : (status === "Verified" ? "Revoked" : status),
    isVerified: verified,
    verifiedAt: verified ? (wv?.verifiedAt || null) : null,
    verifiedBy: wv?.verifiedBy || null,
    updatedAt: wv?.updatedAt || null,
    internalNote: typeof wv?.internalNote === "string" ? wv.internalNote : (rawWorker?.adminNotes || ""),
    history: Array.isArray(wv?.history) ? wv.history : []
  };
}

/**
 * Explicitly resolves the three separated trust & future-commercial layers for any account.
 * Guarantees paid membership never elevates official verification or alters organic ranking today.
 */
export function resolveAccountTrustAndMembership(account, role = "worker") {
  const verification = role === "customer"
    ? normalizeCustomerVerification(account)
    : normalizeWorkerVerification(account);

  // Strictly separated inert membership & promotional blocks (never auto-granted)
  const membership = buildDefaultMembershipState();
  const promotionalPlacement = buildDefaultPromotionalPlacement();

  return {
    verification,
    membership,
    promotionalPlacement
  };
}
