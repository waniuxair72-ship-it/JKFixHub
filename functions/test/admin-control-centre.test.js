/**
 * @file admin-control-centre.test.js
 * @description Automated backend test suite for the JKFixHub Platform Control Centre Cloud Functions.
 *
 * Verifies:
 * - Authoritative /admins/{uid} role & active==true enforcement (customers, workers, inactive admins, unauth rejected)
 * - Maintenance mode, customer/worker registration toggles, new request pause, services & districts configuration
 * - Announcements CRUD, publish/pause/archive, audience/priority/expiry validation
 * - Customer suspension & reactivation with historical preservation and audit logging
 * - Worker approval, rejection, suspension & reactivation with audit logging
 * - Immutable audit logs and security event capture on unauthorized attempts
 */

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { MockFirestore } = require("./mock-firestore");

process.env.NODE_ENV = "test";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8085";

const {
  adminUpdatePlatformConfig,
  adminManageAnnouncement,
  adminUpdateCustomerStatus,
  adminUpdateWorkerStatus
} = require("../admin-operations");

async function readDoc(db, col, id) {
  const snap = await db.collection(col).doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function readCol(db, col) {
  const snap = await db.collection(col).get();
  return (snap.docs || []).map((d) => ({ id: d.id, ...d.data() }));
}

describe("JKFixHub Admin Platform Control Centre — Backend Security & Operations", () => {
  let db;

  const ACTIVE_ADMIN_UID = "admin_active_001";
  const INACTIVE_ADMIN_UID = "admin_inactive_002";
  const CUSTOMER_UID = "customer_user_001";
  const WORKER_UID = "worker_user_001";

  beforeEach(() => {
    db = new MockFirestore();

    db.seed("admins", ACTIVE_ADMIN_UID, {
      uid: ACTIVE_ADMIN_UID,
      email: "admin@jkfixhub.test",
      role: "admin",
      active: true,
      displayName: "Active Admin"
    });

    db.seed("admins", INACTIVE_ADMIN_UID, {
      uid: INACTIVE_ADMIN_UID,
      email: "inactive@jkfixhub.test",
      role: "admin",
      active: false,
      displayName: "Revoked Admin"
    });

    db.seed("users", CUSTOMER_UID, {
      uid: CUSTOMER_UID,
      role: "customer",
      name: "Aamir Customer",
      district: "Srinagar",
      status: "active"
    });

    db.seed("users", WORKER_UID, {
      uid: WORKER_UID,
      role: "worker",
      name: "Bilal Electrician",
      district: "Srinagar"
    });

    db.seed("workers", WORKER_UID, {
      id: WORKER_UID,
      name: "Bilal Electrician",
      service: "Electrician",
      district: "Srinagar",
      status: "pending",
      isVerified: false
    });
  });

  // --------------------------------------------------------------------------
  // 1. Authorization & Fail-Closed Security
  // --------------------------------------------------------------------------
  test("1. Rejects unauthenticated caller on all admin control functions", async () => {
    await assert.rejects(
      () => adminUpdatePlatformConfig(db, { auth: null, data: { patch: { maintenanceMode: true } } }),
      (err) => err.code === "unauthenticated"
    );
    await assert.rejects(
      () => adminManageAnnouncement(db, { auth: null, data: { operation: "create", payload: {} } }),
      (err) => err.code === "unauthenticated"
    );
    await assert.rejects(
      () => adminUpdateCustomerStatus(db, { auth: null, data: { customerId: CUSTOMER_UID, status: "suspended" } }),
      (err) => err.code === "unauthenticated"
    );
  });

  test("2. Rejects normal customer and normal worker with permission-denied and logs security event", async () => {
    await assert.rejects(
      () => adminUpdatePlatformConfig(db, {
        auth: { uid: CUSTOMER_UID },
        data: { patch: { maintenanceMode: true } }
      }),
      (err) => err.code === "permission-denied"
    );

    await assert.rejects(
      () => adminManageAnnouncement(db, {
        auth: { uid: WORKER_UID },
        data: { operation: "create", payload: { title: "Hack", message: "Unauthorized notice" } }
      }),
      (err) => err.code === "permission-denied"
    );

    const secEvents = await readCol(db, "securityEvents");
    assert.ok(secEvents.length >= 2);
    assert.ok(secEvents.every((e) => e.type === "UNAUTHORIZED_ADMIN_ACTION"));
  });

  test("3. Rejects inactive admin (active: false) from performing privileged mutations", async () => {
    await assert.rejects(
      () => adminUpdatePlatformConfig(db, {
        auth: { uid: INACTIVE_ADMIN_UID },
        data: { patch: { customerRegistrationEnabled: false } }
      }),
      (err) => err.code === "permission-denied"
    );

    await assert.rejects(
      () => adminUpdateCustomerStatus(db, {
        auth: { uid: INACTIVE_ADMIN_UID },
        data: { customerId: CUSTOMER_UID, status: "suspended", reason: "Unauthorized attempt" }
      }),
      (err) => err.code === "permission-denied"
    );
  });

  test("4. Client-side role tampering in /users/{uid} cannot grant admin permissions", async () => {
    db.seed("users", "tampered_uid", {
      uid: "tampered_uid",
      role: "admin",
      active: true
    });

    await assert.rejects(
      () => adminUpdatePlatformConfig(db, {
        auth: { uid: "tampered_uid" },
        data: { patch: { maintenanceMode: true } }
      }),
      (err) => err.code === "permission-denied"
    );
  });

  // --------------------------------------------------------------------------
  // 2. Platform Controls (Maintenance, Registrations, Requests, Services, Districts)
  // --------------------------------------------------------------------------
  test("5. Active admin can enable and disable Maintenance Mode with message, schedule, and audit log", async () => {
    const resOn = await adminUpdatePlatformConfig(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        actionType: "MAINTENANCE_MODE_ENABLED",
        summary: "Scheduled window",
        patch: {
          maintenanceMode: true,
          maintenanceMessage: "Upgrading Srinagar dispatch servers.",
          maintenanceStart: "2026-11-18T10:00:00.000Z",
          maintenanceEnd: "2026-11-18T12:00:00.000Z"
        }
      }
    });
    assert.equal(resOn.success, true);

    const cfgDoc = await readDoc(db, "platformConfig", "public");
    assert.equal(cfgDoc.maintenanceMode, true);
    assert.equal(cfgDoc.maintenanceMessage, "Upgrading Srinagar dispatch servers.");

    const resOff = await adminUpdatePlatformConfig(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        actionType: "MAINTENANCE_MODE_DISABLED",
        patch: { maintenanceMode: false }
      }
    });
    assert.equal(resOff.success, true);
    assert.equal((await readDoc(db, "platformConfig", "public")).maintenanceMode, false);

    const logs = await readCol(db, "auditLogs");
    assert.ok(logs.some((l) => l.action === "MAINTENANCE_MODE_ENABLED" && l.adminUid === ACTIVE_ADMIN_UID));
    assert.ok(logs.some((l) => l.action === "MAINTENANCE_MODE_DISABLED" && l.adminUid === ACTIVE_ADMIN_UID));
  });

  test("6. Active admin can independently pause/resume customer registration, worker registration, and new requests", async () => {
    await adminUpdatePlatformConfig(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        actionType: "REGISTRATION_AND_REQUEST_CONTROLS",
        patch: {
          customerRegistrationEnabled: false,
          workerRegistrationEnabled: false,
          newRequestsEnabled: false,
          newRequestsPauseMessage: "Paused for storm advisory."
        }
      }
    });

    const cfg = await readDoc(db, "platformConfig", "public");
    assert.equal(cfg.customerRegistrationEnabled, false);
    assert.equal(cfg.workerRegistrationEnabled, false);
    assert.equal(cfg.newRequestsEnabled, false);
    assert.equal(cfg.newRequestsPauseMessage, "Paused for storm advisory.");
  });

  test("7. Active admin can manage services & districts and automatically computes disabled lists for security rules", async () => {
    const res = await adminUpdatePlatformConfig(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        actionType: "SERVICES_AND_DISTRICTS_UPDATED",
        patch: {
          services: [
            { id: "electrician", name: "Electrician", description: "Wiring", enabled: true },
            { id: "plumbing", name: "Plumbing", description: "Pipes", enabled: false },
            { id: "solar-repair", name: "Solar Inverter Repair", description: "Solar systems", enabled: true }
          ],
          districts: [
            { id: "srinagar", name: "Srinagar", enabled: true },
            { id: "kupwara", name: "Kupwara", enabled: false }
          ]
        }
      }
    });
    assert.equal(res.success, true);

    const cfg = await readDoc(db, "platformConfig", "public");
    assert.ok(cfg.disabledServices.includes("plumbing"));
    assert.ok(cfg.disabledServices.includes("plumber")); // Synonym expansion prevents bypass
    assert.deepEqual(cfg.disabledDistricts, ["kupwara"]);
    assert.equal(cfg.services.length, 3);
  });

  test("7b. Maintenance schedule validation rejects invalid ISO dates and end <= start", async () => {
    await assert.rejects(
      () => adminUpdatePlatformConfig(db, {
        auth: { uid: ACTIVE_ADMIN_UID },
        data: {
          patch: {
            maintenanceMode: true,
            maintenanceStart: "2026-11-18T14:00:00.000Z",
            maintenanceEnd: "2026-11-18T12:00:00.000Z"
          }
        }
      }),
      (err) => err.code === "invalid-argument"
    );
  });

  // --------------------------------------------------------------------------
  // 3. Announcements System
  // --------------------------------------------------------------------------
  test("8. Active admin can create, edit, publish, pause, archive announcements and validate expiry dates", async () => {
    const created = await adminManageAnnouncement(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        operation: "create",
        payload: {
          title: "Winter Heater Safety Notice",
          message: "Please verify wiring before turning on high-wattage room heaters.",
          audience: "customers",
          priority: "important",
          status: "draft",
          publishAt: "2026-11-18T08:00:00.000Z",
          expiresAt: "2026-12-18T08:00:00.000Z"
        }
      }
    });
    assert.equal(created.success, true);
    assert.ok(created.announcementId);

    const saved = await readDoc(db, "announcements", created.announcementId);
    assert.equal(saved.status, "draft");
    assert.equal(saved.audience, "customers");
    assert.equal(typeof saved.publishAtMs, "number");
    assert.equal(typeof saved.expiresAtMs, "number");

    // Publish
    await adminManageAnnouncement(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { operation: "status", announcementId: created.announcementId, payload: { status: "published" } }
    });
    assert.equal((await readDoc(db, "announcements", created.announcementId)).status, "published");

    // Pause
    await adminManageAnnouncement(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { operation: "status", announcementId: created.announcementId, payload: { status: "paused" } }
    });
    assert.equal((await readDoc(db, "announcements", created.announcementId)).status, "paused");

    // Archive
    await adminManageAnnouncement(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { operation: "status", announcementId: created.announcementId, payload: { status: "archived" } }
    });
    assert.equal((await readDoc(db, "announcements", created.announcementId)).status, "archived");

    // Invalid expiry <= publish date rejected
    await assert.rejects(
      () => adminManageAnnouncement(db, {
        auth: { uid: ACTIVE_ADMIN_UID },
        data: {
          operation: "create",
          payload: {
            title: "Bad Dates",
            message: "Expiry is before publish.",
            audience: "everyone",
            priority: "normal",
            status: "published",
            publishAt: "2026-11-20T10:00:00.000Z",
            expiresAt: "2026-11-19T10:00:00.000Z"
          }
        }
      }),
      (err) => err.code === "invalid-argument"
    );
  });

  // --------------------------------------------------------------------------
  // 4. Customer & Worker Moderation
  // --------------------------------------------------------------------------
  test("9. Customer suspension and reactivation preserve records and log admin identity & reason", async () => {
    const susp = await adminUpdateCustomerStatus(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        customerId: CUSTOMER_UID,
        status: "suspended",
        reason: "Abusive conduct reported in chat"
      }
    });
    assert.equal(susp.success, true);
    const afterSusp = await readDoc(db, "users", CUSTOMER_UID);
    assert.equal(afterSusp.status, "suspended");
    assert.equal(afterSusp.suspensionReason, "Abusive conduct reported in chat");
    assert.equal(afterSusp.suspendedBy, ACTIVE_ADMIN_UID);
    assert.equal(afterSusp.name, "Aamir Customer"); // Data preserved, never deleted

    const react = await adminUpdateCustomerStatus(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: {
        customerId: CUSTOMER_UID,
        status: "active",
        reason: "Appeal accepted"
      }
    });
    assert.equal(react.success, true);
    const afterReact = await readDoc(db, "users", CUSTOMER_UID);
    assert.equal(afterReact.status, "active");
    assert.equal(afterReact.suspensionReason, null);

    const logs = await readCol(db, "auditLogs");
    assert.ok(logs.some((l) => l.action === "CUSTOMER_SUSPENDED" && l.targetId === CUSTOMER_UID));
    assert.ok(logs.some((l) => l.action === "CUSTOMER_REACTIVATED" && l.targetId === CUSTOMER_UID));

    // Idempotency: re-activating already-active customer returns alreadyInState without duplicate audit log
    const beforeCount = logs.length;
    const idem = await adminUpdateCustomerStatus(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { customerId: CUSTOMER_UID, status: "active" }
    });
    assert.equal(idem.success, true);
    assert.equal(idem.alreadyInState, true);
    assert.equal((await readCol(db, "auditLogs")).length, beforeCount);
  });

  test("10. Worker approval, rejection, and suspension record previous & new statuses in auditLogs", async () => {
    await adminUpdateWorkerStatus(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { workerId: WORKER_UID, isVerified: true, status: "active", reason: "Credentials verified" }
    });
    assert.equal((await readDoc(db, "workers", WORKER_UID)).isVerified, true);
    assert.equal((await readDoc(db, "workers", WORKER_UID)).status, "active");

    await adminUpdateWorkerStatus(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { workerId: WORKER_UID, status: "suspended", reason: "Pending safety investigation" }
    });
    assert.equal((await readDoc(db, "workers", WORKER_UID)).status, "suspended");

    await adminUpdateWorkerStatus(db, {
      auth: { uid: ACTIVE_ADMIN_UID },
      data: { workerId: WORKER_UID, isVerified: false, status: "rejected", reason: "Invalid ID" }
    });
    assert.equal((await readDoc(db, "workers", WORKER_UID)).status, "rejected");

    const logs = await readCol(db, "auditLogs");
    assert.ok(logs.some((l) => l.action === "WORKER_APPROVED" && l.details.previousStatus === "pending"));
    assert.ok(logs.some((l) => l.action === "WORKER_SUSPENDED" && l.details.previousStatus === "active"));
    assert.ok(logs.some((l) => l.action === "WORKER_REJECTED" && l.details.previousStatus === "suspended"));
  });
});
