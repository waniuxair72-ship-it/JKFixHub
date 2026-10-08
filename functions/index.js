/**
 * @file index.js
 * @description Cloud Functions for Firebase 2nd Gen entry point for [JK] FixHub.
 *
 * Security Architecture:
 * 1. Cloud Functions 2nd Gen (Node.js 22, firebase-functions v2).
 * 2. All client-requested mutations use HTTPS Callable functions (onCall) with verified auth context.
 * 3. Server-side role and resource ownership validation on every sensitive operation.
 * 4. Immutable audit logging and security event capture.
 * 5. Production deployment intentionally deferred (local emulator workflow active).
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onCall } = require("firebase-functions/v2/https");

// Initialize Admin SDK
initializeApp();
const db = getFirestore();

// Import trusted backend logic modules
const {
  acceptRequest,
  rejectRequest,
  completeRequest,
  cancelRequest
} = require("./request-lifecycle");

const { submitReview } = require("./review-logic");
const { submitReport } = require("./report-logic");

const {
  adminUpdateWorkerStatus,
  adminModerateReport,
  adminModerateReview
} = require("./admin-operations");

// ----------------------------------------------------------------------------
// Request Lifecycle Callable Functions
// ----------------------------------------------------------------------------

/**
 * Worker accepts a pending service request assigned to them.
 */
exports.acceptServiceRequest = onCall(async (request) => {
  return await acceptRequest(db, request);
});

/**
 * Worker rejects a pending service request assigned to them.
 */
exports.rejectServiceRequest = onCall(async (request) => {
  return await rejectRequest(db, request);
});

/**
 * Worker marks an accepted service request as completed.
 */
exports.completeServiceRequest = onCall(async (request) => {
  return await completeRequest(db, request);
});

/**
 * Customer cancels their own pending service request.
 */
exports.cancelServiceRequest = onCall(async (request) => {
  return await cancelRequest(db, request);
});

// ----------------------------------------------------------------------------
// Review & Reputation Callable Functions
// ----------------------------------------------------------------------------

/**
 * Customer submits a validated review for a completed service request.
 */
exports.submitReview = onCall(async (request) => {
  return await submitReview(db, request);
});

// ----------------------------------------------------------------------------
// Safety & Abuse Reporting Callable Functions
// ----------------------------------------------------------------------------

/**
 * Authenticated user submits a safety/abuse report.
 */
exports.submitReport = onCall(async (request) => {
  return await submitReport(db, request);
});

// ----------------------------------------------------------------------------
// Privileged Administration Callable Functions
// ----------------------------------------------------------------------------

/**
 * Admin updates worker verification or moderation status.
 */
exports.adminUpdateWorkerStatus = onCall(async (request) => {
  return await adminUpdateWorkerStatus(db, request);
});

/**
 * Admin updates moderation status of an incident report.
 */
exports.adminModerateReport = onCall(async (request) => {
  return await adminModerateReport(db, request);
});

/**
 * Admin moderates the publication status of a customer review.
 */
exports.adminModerateReview = onCall(async (request) => {
  return await adminModerateReview(db, request);
});
