// ==========================================
// #ABUSE_PREVENTION
// ==========================================

// Prototype abuse prevention and rate-tracking foundation.
// This is an in-memory UX safeguard only and does NOT provide
// trusted server-side anti-abuse or security controls.
// Production enforcement must be executed server-side.
import { recordSecurityEvent } from "./security.js";

export const SIGNAL_SEVERITY = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH"
});

const WINDOW_MS = 60000; // 1-minute sliding window

// In-memory sliding window history: { [userId]: { [action]: [timestamp, ...] } }
const actionHistory = new Map();

// In-memory active restrictions: { [key: `${userId}:${action}`]: { expiresAt: number, reason: string } }
const activeRestrictions = new Map();

// In-memory recorded signals
const recordedSignals = [];
const MAX_SIGNALS = 50;

function getActionTimestamps(userId, action) {
  if (!actionHistory.has(userId)) {
    actionHistory.set(userId, new Map());
  }
  const userActions = actionHistory.get(userId);
  if (!userActions.has(action)) {
    userActions.set(action, []);
  }
  const now = Date.now();
  const validTimestamps = userActions.get(action).filter((time) => now - time < WINDOW_MS);
  userActions.set(action, validTimestamps);
  return validTimestamps;
}

export function recordAbuseSignal(userId, signalType, details = {}) {
  const safeUserId = typeof userId === "string" ? userId : "anonymous";
  const now = Date.now();
  const signal = {
    userId: safeUserId,
    type: signalType,
    severity: details.severity || SIGNAL_SEVERITY.LOW,
    timestamp: new Date(now).toISOString(),
    details: typeof details.reason === "string" ? details.reason : ""
  };

  recordedSignals.push(signal);
  if (recordedSignals.length > MAX_SIGNALS) {
    recordedSignals.shift();
  }

  try {
    recordSecurityEvent("ABUSE_SIGNAL_TRIGGERED");
  } catch {
    // Graceful fallback if event recording is unavailable
  }

  return signal;
}

export function applyTemporaryRestriction(userId, actionType, durationSeconds, reason = "Rate limit exceeded") {
  const safeUserId = typeof userId === "string" ? userId : "anonymous";
  const key = `${safeUserId}:${actionType}`;
  const expiresAt = Date.now() + Math.max(1, durationSeconds) * 1000;

  activeRestrictions.set(key, {
    expiresAt,
    reason: typeof reason === "string" ? reason : "Please slow down."
  });

  try {
    recordSecurityEvent("ABUSE_RESTRICTION_APPLIED");
  } catch {
    // Graceful fallback
  }
}

export function isActionRestricted(userId, actionType) {
  const safeUserId = typeof userId === "string" ? userId : "anonymous";
  const key = `${safeUserId}:${actionType}`;
  const restriction = activeRestrictions.get(key);

  if (restriction) {
    const now = Date.now();
    if (now < restriction.expiresAt) {
      const remainingSeconds = Math.ceil((restriction.expiresAt - now) / 1000);
      return {
        restricted: true,
        remainingSeconds,
        reason: restriction.reason
      };
    }
    activeRestrictions.delete(key);
  }

  return { restricted: false, remainingSeconds: 0, reason: "" };
}

export function checkAndTrackAction(userId, actionType) {
  const safeUserId = typeof userId === "string" ? userId : "anonymous";

  // Check if already restricted
  const check = isActionRestricted(safeUserId, actionType);
  if (check.restricted) {
    return check;
  }

  const timestamps = getActionTimestamps(safeUserId, actionType);
  const now = Date.now();
  timestamps.push(now);

  // Threshold rules for in-memory signals & soft prototype restrictions
  if (actionType === "request") {
    if (timestamps.length >= 6) {
      recordAbuseSignal(safeUserId, "REPEATED_REQUESTS", {
        severity: SIGNAL_SEVERITY.MEDIUM,
        reason: "Excessive service requests in 60 seconds"
      });
      applyTemporaryRestriction(safeUserId, actionType, 45, "Too many requests created. Please wait 45 seconds.");
      return isActionRestricted(safeUserId, actionType);
    }
    if (timestamps.length >= 4) {
      recordAbuseSignal(safeUserId, "REPEATED_REQUESTS", {
        severity: SIGNAL_SEVERITY.LOW,
        reason: "Multiple service requests in 60 seconds"
      });
    }
  } else if (actionType === "cancel_request") {
    if (timestamps.length >= 4) {
      recordAbuseSignal(safeUserId, "REPEATED_CANCELLATIONS", {
        severity: SIGNAL_SEVERITY.MEDIUM,
        reason: "Repeated request cancellations in 60 seconds"
      });
      applyTemporaryRestriction(safeUserId, actionType, 30, "Too many cancellations. Please wait 30 seconds.");
      return isActionRestricted(safeUserId, actionType);
    }
    if (timestamps.length >= 2) {
      recordAbuseSignal(safeUserId, "REPEATED_CANCELLATIONS", {
        severity: SIGNAL_SEVERITY.LOW,
        reason: "Multiple cancellations in 60 seconds"
      });
    }
  } else if (actionType === "report") {
    if (timestamps.length >= 4) {
      recordAbuseSignal(safeUserId, "REPEATED_REPORTS", {
        severity: SIGNAL_SEVERITY.HIGH,
        reason: "Excessive report submissions in 60 seconds"
      });
      applyTemporaryRestriction(safeUserId, actionType, 60, "Too many reports submitted. Please wait 60 seconds.");
      return isActionRestricted(safeUserId, actionType);
    }
    if (timestamps.length >= 2) {
      recordAbuseSignal(safeUserId, "REPEATED_REPORTS", {
        severity: SIGNAL_SEVERITY.MEDIUM,
        reason: "Multiple report submissions in 60 seconds"
      });
    }
  } else if (actionType === "review") {
    if (timestamps.length >= 4) {
      recordAbuseSignal(safeUserId, "REPEATED_REVIEWS", {
        severity: SIGNAL_SEVERITY.MEDIUM,
        reason: "Rapid review attempts in 60 seconds"
      });
      applyTemporaryRestriction(safeUserId, actionType, 30, "Please wait 30 seconds before submitting another review.");
      return isActionRestricted(safeUserId, actionType);
    }
    if (timestamps.length >= 2) {
      recordAbuseSignal(safeUserId, "REPEATED_REVIEWS", {
        severity: SIGNAL_SEVERITY.LOW,
        reason: "Multiple review attempts in 60 seconds"
      });
    }
  } else if (actionType === "unauthorized_attempt") {
    recordAbuseSignal(safeUserId, "UNAUTHORIZED_ACCESS_ATTEMPT", {
      severity: SIGNAL_SEVERITY.HIGH,
      reason: "Attempted unauthorized UI or data access"
    });
  }

  return { restricted: false, remainingSeconds: 0, reason: "" };
}

export function resetAbuseSignals() {
  actionHistory.clear();
  activeRestrictions.clear();
  recordedSignals.length = 0;
}

export function getRecordedAbuseSignals() {
  return recordedSignals.map((signal) => ({ ...signal }));
}

export function getActiveRestrictionsCount() {
  const now = Date.now();
  let count = 0;
  for (const [key, restriction] of activeRestrictions.entries()) {
    if (now < restriction.expiresAt) {
      count += 1;
    } else {
      activeRestrictions.delete(key);
    }
  }
  return count;
}

