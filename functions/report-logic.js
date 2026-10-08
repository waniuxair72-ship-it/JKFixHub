/**
 * @file report-logic.js
 * @description Trusted abuse reporting and moderation backend foundation for JK FixHub.
 *
 * Security Principles:
 * 1. Authenticated users (customers/workers) can submit reports.
 * 2. Strict whitelist on targetType and reason codes.
 * 3. Text content bounded, sanitized, and stripped of injection vectors.
 * 4. Duplicate open report prevention.
 * 5. Abuse signal tracking and security event logging.
 */

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { assertAuthenticated } = require("./auth-helpers");
const { recordAuditEvent, recordSecurityEvent } = require("./audit-logger");

const ALLOWED_TARGET_TYPES = Object.freeze([
  "worker",
  "customer",
  "review",
  "message"
]);

const ALLOWED_REPORT_REASONS = Object.freeze([
  "harassment",
  "unprofessional_conduct",
  "fraud",
  "spam",
  "inappropriate_content",
  "safety_hazard",
  "other"
]);

const SCRIPT_INJECTION_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i;

/**
 * Validates report submission payload.
 * @param {object} data
 */
function validateReportInput(data) {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Report payload must be an object.");
  }

  const { targetType, targetId, reason, description } = data;

  if (!ALLOWED_TARGET_TYPES.includes(targetType)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid target type. Allowed: ${ALLOWED_TARGET_TYPES.join(", ")}.`
    );
  }

  if (
    !targetId ||
    typeof targetId !== "string" ||
    targetId.trim().length === 0 ||
    targetId.length > 128 ||
    /[/\\.\0]/.test(targetId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid or malformed target identifier."
    );
  }

  if (!ALLOWED_REPORT_REASONS.includes(reason)) {
    throw new HttpsError(
      "invalid-argument",
      `Invalid report reason. Allowed: ${ALLOWED_REPORT_REASONS.join(", ")}.`
    );
  }

  if (typeof description !== "string") {
    throw new HttpsError("invalid-argument", "Report description must be a string.");
  }

  const trimmedDesc = description.trim();
  if (trimmedDesc.length < 10 || trimmedDesc.length > 1000) {
    throw new HttpsError(
      "invalid-argument",
      "Report description must be between 10 and 1,000 characters."
    );
  }

  if (SCRIPT_INJECTION_PATTERN.test(trimmedDesc)) {
    throw new HttpsError(
      "invalid-argument",
      "Report description contains disallowed script content."
    );
  }

  return {
    targetType,
    targetId: targetId.trim(),
    reason,
    cleanDescription: trimmedDesc.replace(HTML_TAG_PATTERN, "").trim()
  };
}

/**
 * Submits a validated Trust & Safety incident report.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} request - Functions v2 callable request.
 * @returns {Promise<{ success: boolean, reportId: string }>}
 */
async function submitReport(db, request) {
  const uid = assertAuthenticated(request);
  const { targetType, targetId, reason, cleanDescription } = validateReportInput(
    request.data
  );

  // Check duplicate open report for same target by same reporter
  const existingSnap = await db
    .collection("reports")
    .where("reporterUid", "==", uid)
    .where("targetId", "==", targetId)
    .where("targetType", "==", targetType)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0].data();
    if (existing.status !== "resolved" && existing.status !== "dismissed") {
      await recordSecurityEvent(db, {
        type: "DUPLICATE_REPORT_ATTEMPT",
        actorUid: uid,
        targetType,
        targetId,
        severity: "Low",
        details: { existingReportId: existingSnap.docs[0].id }
      });
      throw new HttpsError(
        "already-exists",
        "You already have an active report submitted for this target."
      );
    }
  }

  const reportDoc = {
    reporterUid: uid,
    reporterId: uid,
    targetType,
    targetId,
    reason,
    description: cleanDescription,
    status: "open",
    createdAt: FieldValue.serverTimestamp(),
    resolvedAt: null,
    resolvedBy: null
  };

  const docRef = await db.collection("reports").add(reportDoc);

  await recordAuditEvent(db, {
    actorUid: uid,
    action: "REPORT_SUBMITTED",
    targetType: "report",
    targetId: docRef.id,
    result: "success",
    details: { targetType, targetId, reason }
  });

  return {
    success: true,
    reportId: docRef.id,
    message: "Report submitted successfully and queued for review."
  };
}

module.exports = {
  ALLOWED_TARGET_TYPES,
  ALLOWED_REPORT_REASONS,
  validateReportInput,
  submitReport
};
