/**
 * @file audit-logger.js
 * @description Trusted audit logging and security event recording for JK FixHub backend.
 *
 * Security Principles:
 * 1. Sensitive data (passwords, tokens, secrets, private keys) are NEVER logged.
 * 2. Audit logs are append-only and immutable.
 * 3. Security events capture unauthorized actions, injection attempts, and abuse signals.
 */

const { FieldValue } = require("firebase-admin/firestore");

const SENSITIVE_KEY_PATTERN = /(password|token|secret|credential|auth|key|apiKey|private)/i;

/**
 * Sanitizes an object to ensure no sensitive credentials or tokens are logged.
 * @param {any} value
 * @returns {any}
 */
function sanitizeLogPayload(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map(sanitizeLogPayload);
  }

  const sanitized = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      sanitized[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      sanitized[k] = sanitizeLogPayload(v);
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

/**
 * Records an immutable administrative or lifecycle event in the /auditLogs collection.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} entry
 * @param {string} entry.actorUid - Authenticated UID performing the action.
 * @param {string} entry.action - Standard action identifier (e.g. REQUEST_STATUS_TRANSITION).
 * @param {string} entry.targetType - Target entity type (request, worker, report, review).
 * @param {string} entry.targetId - ID of target entity.
 * @param {"success"|"failure"} [entry.result="success"]
 * @param {object} [entry.details={}] - Non-sensitive context.
 * @returns {Promise<boolean>}
 */
async function recordAuditEvent(db, {
  actorUid,
  action,
  targetType = "general",
  targetId = "unknown",
  result = "success",
  details = {}
}) {
  if (!db || !actorUid || !action) return false;

  try {
    const cleanDetails = sanitizeLogPayload(details);
    const auditRecord = {
      adminUid: String(actorUid),
      actorUid: String(actorUid),
      action: String(action),
      targetType: String(targetType),
      targetId: String(targetId),
      result: String(result),
      details: typeof cleanDetails === "object" && cleanDetails !== null ? cleanDetails : {},
      timestamp: FieldValue.serverTimestamp()
    };

    await db.collection("auditLogs").add(auditRecord);
    return true;
  } catch (err) {
    console.warn("[JKFixHub Audit] Failed to record audit log:", err?.message || err);
    return false;
  }
}

/**
 * Records an immutable security event in the /securityEvents collection.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} event
 * @param {string} event.type - Security signal type (e.g. UNAUTHORIZED_ACCESS, INVALID_TRANSITION).
 * @param {string} [event.actorUid=null]
 * @param {string} [event.role=null]
 * @param {string} [event.targetType=null]
 * @param {string} [event.targetId=null]
 * @param {"Low"|"Medium"|"High"|"Critical"} [event.severity="Medium"]
 * @param {object} [event.details={}]
 * @returns {Promise<boolean>}
 */
async function recordSecurityEvent(db, {
  type,
  actorUid = null,
  role = null,
  targetType = null,
  targetId = null,
  severity = "Medium",
  details = {}
}) {
  if (!db || !type) return false;

  try {
    const cleanDetails = sanitizeLogPayload(details);
    const eventRecord = {
      type: String(type),
      actor: actorUid ? String(actorUid) : "anonymous",
      actorUid: actorUid ? String(actorUid) : null,
      role: role ? String(role) : null,
      targetType: targetType ? String(targetType) : null,
      targetId: targetId ? String(targetId) : null,
      severity: String(severity),
      details: typeof cleanDetails === "object" && cleanDetails !== null ? cleanDetails : {},
      timestamp: FieldValue.serverTimestamp()
    };

    await db.collection("securityEvents").add(eventRecord);
    return true;
  } catch (err) {
    console.warn("[JKFixHub Security] Failed to record security event:", err?.message || err);
    return false;
  }
}

module.exports = {
  recordAuditEvent,
  recordSecurityEvent,
  sanitizeLogPayload
};
