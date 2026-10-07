# [JK] FixHub security foundation

## Status and objectives

[JK] FixHub (JK FixHub) is an early-stage local services platform. This document describes its current safeguards and the controls required before full production use. The security objectives, in priority order, are to protect customer and worker privacy, protect privileged administration, protect application and stored data, prevent abuse and fraud, and preserve usable functionality.

**Frontend role checks are UX controls, not security boundaries.**

**Real authorization must eventually be enforced server-side.**

**Never store passwords, OTPs, authentication tokens, or secrets in frontend source code.**

No client-side measure can guarantee that an application will never be compromised. Production readiness requires defense in depth and controls at the identity provider, trusted backend, database, storage, and hosting layers.

## Current trust boundaries and limitations

- `js/worker-data.js` contains the fictional sample worker records. It is public sample content, not private account data.
- `js/store.js` holds selected-worker, temporary request, application profile, worker-profile override, and customer-owned request state in memory. A reload clears temporary sessions. It does not use insecure browser storage or send unauthenticated requests.
- `js/auth.js` integrates live Firebase Authentication for customer and worker accounts, alongside an offline demo fallback. Privileged admin access (`js/admin-dashboard.js`) is isolated and not publicly registrable.
- `js/worker-dashboard.js` displays a worker workspace view, editable profile overrides, and availability in memory. Its role checks are client-side controls and will be reinforced with Firestore Security Rules.
- The dashboard's illustrative request rows and counts are fixed demo samples, not submitted or persisted requests. Accept/reject/complete controls open a prototype status notice and do not change records.
- Worker profile edits are limited to name, service, district, experience, and availability. They are held as in-memory store overrides, do not alter `js/worker-data.js`, and reset on reload. Rating, verification, identity, and role remain read-only.
- `js/security.js` defines role capabilities, input validation helpers, and a bounded in-memory event list. These are modifiable client code and are not proof of identity, authorization, audit, or abuse prevention.
- Guest browsing and guest requests remain available. A request is a local preview and is not transmitted or saved.
- `js/customer-requests.js` displays request records only for the current customer demo identity. The store verifies ownership on list, detail, and cancellation operations; cancellation is limited to Pending requests and updates only in-memory demo state.
- Customer request history stores a worker/service/district snapshot, problem description, customer location, allowed status, and demo timestamp. It does not store or display customer phone numbers or email addresses. Guest submissions retain the existing confirmation-only flow and do not enter private customer history.
- `js/chat.js` and `js/store.js` provide an in-app chat prototype. Customer-created requests stay chat-locked while Pending; the worker dashboard offers a clearly labelled, reversible “Accept · Demo only” action to test accepted chat. When a request is marked Completed, chat is closed.
- `js/reviews.js` and `js/store.js` provide an in-memory review system. Reviews are strictly restricted to authenticated customers whose requests reached Completed status. Ratings are integers 1–5, text is sanitized, and duplicate reviews for the same request are prevented. Assigned workers can reply only to reviews on their own profile.
- `js/reports.js` and `js/store.js` provide an in-memory safety reporting workflow for workers, customers, reviews, and messages. Reason codes and descriptions are validated, duplicates are prevented, and reports trigger security events without creating an admin surface.
- `js/abuse.js` provides prototype abuse signal tracking (repeated requests, cancellations, messages, reports, review attempts, and unauthorized access) with soft in-memory rate restrictions. These are client-side UX safeguards and not trusted security boundaries; production abuse prevention must be enforced server-side.
- `js/admin-dashboard.js` and `js/store.js` provide a dedicated admin dashboard and security boundary foundation. Frontend admin checks are prototype UX/security boundaries only. Production admin authorization MUST be enforced server-side using Firebase Authentication, custom admin claims, Firestore Security Rules, and trusted backend logic.
- Normal customer and worker experiences expose NO Admin navigation, buttons, or links. Hiding an admin button is not security: the prototype relies on explicit authorization functions (`canAccessAdmin()`, `canManageWorkers()`, `canManageReports()`, `canManageReviews()`, `canViewAuditLog()`) and rejects unauthorized direct navigation with a generic "Access unavailable." notice without leaking system details.
- In-memory audit logging records all privileged actions (`recordAuditEvent`) with action, target, result, and timestamp. Logs are kept strictly in memory, never stored in browser storage (`localStorage`, `sessionStorage`, `cookies`), and reset on reload or logout.
- Chat is not connected to a worker or backend. No chat or review feature displays, shares, or converts phone numbers into contact actions.
- Client-side checks can be bypassed by changing JavaScript, DOM state, or network requests once network functionality exists. Do not trust a role, worker ID, customer ID, service, or permission supplied by a browser.
- Request fields currently include a customer name, an area, and a problem description. They remain temporary in memory and are not logged. Users should avoid entering sensitive information or a precise home address into this prototype.

## Firebase Authentication security architecture (Step 16)

- **Authentication vs. Authorization:** Firebase Authentication verifies user identity (`uid`, `email`, `emailVerified`). It does NOT provide application authorization or role enforcement on its own. Frontend application profile mapping (`uid -> { role, name, district }`) is an in-memory boundary for Step 16. Authoritative role authorization and access controls will be enforced in Step 17 using Firestore Security Rules and in Step 19 using trusted backend logic.
- **Client Configuration vs. Server Secrets:** `js/firebase-config.js` defines public client-side routing parameters (`apiKey`, `authDomain`, `projectId`, `appId`). These parameters are public client identifiers, NOT server secrets. Server-side secrets (Service Account JSON, Admin SDK keys, database master secrets) must NEVER be committed or present in client code.
- **Password Security:** The frontend never stores, caches, or logs user passwords. Passwords are submitted directly to the Firebase Authentication SDK over TLS and immediately discarded. Passwords are never placed in `store.js`, browser storage, console logs, or security events.
- **Email Verification Workflow:** Real user registration triggers `sendEmailVerification()`. Account status clearly reflects whether the email address has been verified by the identity provider (`user.emailVerified`). Unverified accounts show a verification notice and resend option without trusting unverified claims.
- **Session & Token Management:** The application delegates session persistence to Firebase Auth SDK. Custom token storage in `localStorage`, `sessionStorage`, or cookies is prohibited. User ID tokens are not exposed in DOM attributes or frontend storage.
- **Safe Error Handling:** Raw Firebase error codes (`auth/invalid-credential`, `auth/user-not-found`, stack traces, internal codes) are never displayed to users. All auth errors are sanitized through `mapFirebaseAuthError()` to prevent account enumeration and infrastructure disclosure.
- **Worker Verification Safeguard:** Newly registered workers are initialized with `isVerified: false` and marked as "Pending Verification". Public registration does not grant verified badges, premium status, or administrative access.
- **Admin Authentication Isolation:** Admin access remains strictly isolated. Public registration and login interfaces offer only Customer and Worker options. Production admin authorization must require Firebase Authentication with custom admin claims assigned by a trusted backend, validated by Firestore Security Rules, and fortified with Multi-Factor Authentication (MFA).
- **Graceful Prototype Fallback:** If Firebase project credentials are not yet configured, the system provides an explicitly labeled "Demo Preview" fallback mode so development and manual testing can continue without compromising security boundaries.

## Cloud Firestore & Admin Authorization security architecture (Step 17)

- **Server-Side Authorization Boundary:** Client-side role variables (`user.role`, `currentUser`, `isAdmin`, capability lists) are strictly UX conveniences. They are NEVER treated as security boundaries. All access to data is enforced on the Google Cloud / Firestore servers via `firestore.rules`. Tampering with client memory, executing JavaScript console commands, modifying DOM attributes, or setting mock cookies has ZERO impact on Firestore data access. If an unauthorized user queries a restricted collection, the Firestore database engine denies the request at the protocol level.
- **Authoritative Admin Authorization Pipeline:**
  1. User authenticates via Firebase Authentication (`admin.html`).
  2. Client receives verified Firebase UID (`request.auth.uid`).
  3. Client queries Firestore document `/admins/{uid}`.
  4. `firestore.rules` verifies:
     - `exists(/databases/$(database)/documents/admins/$(request.auth.uid))`
     - `data.active == true`
     - `data.role == "admin"`
  5. If valid, Admin Panel loads; otherwise, session is immediately terminated with `signOut()` and a generic access denied message is displayed.
- **Zero Client-Side Admin Mutation:** Under `firestore.rules`, all write operations to `/admins/{uid}` are blocked (`allow write: if false`). No browser client, customer, or worker can write to, create, or alter an admin document. Admins cannot self-promote, and customers cannot escalate privileges.
- **First Administrator Bootstrap Procedure (Firebase Console):**
  To establish the platform's initial administrator securely without introducing client-side backdoors:
  1. Open the [Firebase Console](https://console.firebase.google.com/) for project `jkfixhub`.
  2. Under **Authentication** -> **Users**, click **Add user** (or choose a dedicated administrative email, e.g., `admin@jkfixhub.com`).
  3. Copy the newly generated **User UID** (28-character unique identifier).
  4. Under **Cloud Firestore** -> **Data**, click **Start collection**:
     - **Collection ID**: `admins`
     - **Document ID**: `<Paste the User UID>`
  5. Add the following fields to the document:
     - `uid`: string (equal to the User UID)
     - `email`: string (e.g. `admin@jkfixhub.com`)
     - `role`: string `"admin"`
     - `active`: boolean `true`
     - `displayName`: string `"Platform Administrator"`
     - `createdBy`: string `"system-bootstrap"`
     - `createdAt`: timestamp (current date/time)
     - `lastLoginAt`: timestamp (current date/time)
  6. Deploy `firestore.rules` to Firebase:
     `firebase deploy --only firestore:rules`
  7. Navigate directly to `admin.html` and sign in with the admin credentials.
- **Separation of Roles & Existing Accounts:** The test customer account (`waniuxair72@gmail.com`) was intentionally NOT given admin access. In accordance with the principle of least privilege, customer and worker identities remain completely segregated from administrative identities.
- **Dedicated Admin Entry Point (`admin.html`):** The administration interface is physically separated into `admin.html` with its own script (`js/admin-app.js`) and stylesheet (`css/admin.css`). The public application (`index.html`) contains no Admin buttons, links, or navigation options. Attempting to access `#admin` in `index.html` displays a generic denial notice (`adminAccessDeniedModal`) and scrubs `#admin` from the browser history via `history.replaceState`.
- **Append-Only Tamper-Resistant Audit Trail (`/auditLogs`):** Privileged operations (worker approval, suspension, restoration, report resolution, review moderation) automatically write an immutable audit record to `/auditLogs` with admin UID, action, target, timestamp, and outcome. In `firestore.rules`, audit logs can only be created by verified administrators, can only be read by administrators, and cannot be modified or deleted (`allow update, delete: if false`).
- **Sanitized Error Messaging:** If an unauthorized user attempts to log in via `admin.html`, the system displays: *"Access unavailable. This area is restricted to authorized administrators."* The system never leaks whether an account exists, whether an email is registered, or internal database schema details.

## Privacy requirements

### Customers

- Do not publicly display customer phone numbers, email addresses, exact addresses, request descriptions, or account details.
- Reveal only the minimum information needed for a worker to fulfill an accepted request.
- Define purpose, access, retention, deletion, and consent before collecting real customer data.
- Do not put private data in URLs, public HTML attributes, analytics, client logs, or error messages.

### Workers

- Never publicly display worker phone numbers, identity documents, private contact details, or exact home locations.
- Use district-level discovery where adequate. Reveal additional location only to an authorized participant when necessary.
- Store identity and verification documents in a restricted private storage area, never in public worker profiles.
- Provide worker-controlled profile visibility, account access, and suspension/appeal processes.

### Administrators

- Do not add admin demo login or expose admin functions in the public customer/worker frontend.
- Use a separate, strongly protected identity and privileged access path for real administrators.
- Require MFA, least privilege, short-lived sessions, controlled role assignment, and auditable administrative actions.
- Enforce strict data minimization: admin dashboards must display only the necessary moderation and verification data, without publicizing private phone numbers or documents.

## Authentication and authorization requirements

- Use a supported identity provider for production authentication. Do not build password storage in the browser.
- Store no passwords, OTPs, refresh tokens, access tokens, private keys, or service credentials in frontend source, HTML, URLs, browser storage, or logs.
- Configure secure session handling through the chosen provider and hosting architecture; define revocation, expiry, recovery, and account deletion.
- Treat client-provided roles and IDs as untrusted input. Do not authorize an action because `user.role` equals a role name or because a control is hidden.
- Enforce every read and write against the authenticated principal and resource owner in trusted server code and database rules.
- Customer access must be limited to that customer's own requests and authorized conversations/reviews. Worker access must be limited to that worker's own profile and requests assigned to them.
- When customer request history is connected to Firebase, enforce request ownership on every read and cancellation in Firestore Security Rules or trusted backend code. Validate IDs, immutable owner/worker fields, input sizes, status transitions, and server timestamps; permit customer cancellation only from statuses allowed by the production workflow. The in-memory checks in `js/store.js` are prototype safeguards only.
- Admin access must use explicit least-privilege policy and server-verified roles; never trust a client-set role or claim.
- A UI capability map may guide what controls are shown, but must not be the final security check.
- Before connecting the dashboard to real data, enforce worker ownership, profile field allowlists, availability updates, request assignment/status transitions, and access to customer request details in trusted backend logic and Firebase Security Rules. Do not rely on the dashboard's client-side role guard.
- For chat, enforce authenticated request ownership/worker assignment and Accepted status on every conversation and message read/write in Firebase Security Rules and/or trusted backend logic. Deny public reads; do not trust conversation IDs, roles, participant IDs, status, or sender identity provided by a client. Cloud Functions or other trusted services may enforce status transitions, abuse controls, report/block handling, and audit requirements. Implement real rate limiting server-side; frontend throttles are bypassable.
- Treat chat message content as private request data. Escape/render it as text, do not expose it publicly, and define access, retention, deletion, and moderation policy before production. Never expose customer or worker phone numbers in profiles, requests, or chat, and do not automatically share contact details. Report/block actions require backend enforcement and review workflows before they can be represented as effective controls.
- For reviews, enforce server-side validation ensuring only the authenticated customer who created the request can submit a review, only once, and only after the request has reached verified server-stamped Completed status. Validate integer ratings (1–5), sanitized content, and worker ownership of replies in Firestore Security Rules and Cloud Functions.
- For reports and abuse prevention, implement server-side rate limits, IP/account-level anomaly detection, and tamper-resistant moderation queues. Client-side abuse signal tracking in `js/abuse.js` is an exploratory prototype UX mechanism and provides no defense against automated or malicious manipulation.
- For admin operations, production systems require Firebase Authentication custom claims (e.g. `request.auth.token.admin == true`), server-side rule verification on admin actions, and tamper-resistant Cloud Functions audit logs. Frontend checks in `js/admin-dashboard.js` and `js/store.js` are exploratory UX safeguards and provide no defense against browser manipulation without backend enforcement.

## Future Firebase and backend requirements

### Firestore Security Rules

- Default-deny all collections; permit only explicitly required operations.
- Require authenticated identities for private data and verify ownership/assignment on every read and write.
- Validate allowed fields, types, sizes, immutable identifiers, state transitions, and server-managed timestamps in rules and/or trusted functions.
- Prevent users from changing their own role, verification state, suspension state, moderation result, ownership, or audit metadata.
- Restrict worker profile public reads to approved public fields; keep contact information and internal review/moderation fields private.
- Protect requests so customers create requests only for themselves; workers read or transition only requests assigned to them; validate allowed status transitions server-side.
- Test rules with emulator-based allow/deny cases for guest, customer, worker, suspended user, and admin contexts. Rules are mandatory even if Cloud Functions also validate.

### Firebase Storage Security Rules

- Deny public listing and access to identity documents and private uploads.
- Require authenticated ownership and narrowly scoped access for each object path.
- Enforce maximum file size, allowed content types, and safe ownership metadata in rules; do not rely on the filename or browser MIME type.
- Validate file signatures and scan uploads server-side before making approved content available. Store private documents outside public profile paths.
- Use short-lived, appropriately scoped download access and define deletion/retention policy.

### Cloud Functions or trusted backend

- Revalidate all inputs and authorization on every operation. Derive user identity from verified credentials, never request fields.
- Enforce request ownership, worker assignment, state transitions, reviews, reports, suspensions, role changes, and administrative operations server-side.
- Keep provider credentials and other secrets in an approved secrets manager; rotate them and grant least-privilege service identities.
- Return generic user-facing errors. Keep stack traces, database structure, security-rule details, credentials, and internal paths in protected developer diagnostics only.
- Make sensitive operations idempotent where appropriate and protect against replay, race conditions, and mass assignment.

## Input handling and XSS prevention

- Validate and normalize all values at the frontend for usability and repeat the validation on the trusted server. Enforce both type and length limits.
- Treat names, descriptions, profile fields, reviews, reports, district/service values, and chat messages as untrusted.
- Render data with DOM APIs and `textContent`; do not concatenate untrusted values into `innerHTML`, attributes, URLs, CSS, or executable code.
- Where a rich-text format is genuinely needed, use a reviewed context-aware sanitizer and an explicit allowlist. Do not try to secure content by removing strings such as `<script>`.
- Do not use `eval`, `Function`, `document.write`, inline event handlers, or dynamic script construction with input.
- The current search cards and worker profiles use DOM construction and the `setTextContent` helper from `js/security.js`. The static HTML templates in `index.html` are trusted project markup.
- Frontend validation is not an anti-spam measure or a substitute for backend validation.

## Request, abuse, and fraud controls

- Request details in this prototype are in-memory only. Client-side rate limits and role checks, if added, are not abuse prevention.
- Future request creation, messaging, reviews, reports, and uploads need server-side schema validation, ownership checks, throttling, deduplication, and abuse monitoring.
- Apply rate limits per account and relevant network/device signals, with risk-based escalation and safeguards against denying shared networks unfairly.
- Define account suspension and appeal processes. Enforce suspension on every backend operation and revoke or constrain active sessions as appropriate.
- Create audit records server-side for authentication/security events, role and permission changes, moderation, suspensions, and administrative access.
- Audit records must be append-only or otherwise tamper-resistant, access-controlled, retained only as long as justified, and must not include passwords, tokens, unnecessary contact details, or full request contents.
- The present `js/security.js` event list is capped at 50 records, in memory only, client-modifiable, and contains only event type, timestamp, and a supported role. It is a development structure, not a production audit log.

## External resources and API keys

- The prototype loads the pinned Three.js 0.160.0 browser build from jsDelivr. Its script tag uses Subresource Integrity and anonymous CORS; the page policy restricts scripts to the same origin and that CDN.
- Do not add third-party scripts without a clear need, version pinning, integrity verification where supported, and a review of data access and privacy impact.
- Browser-visible Firebase configuration and public API identifiers are not secrets, but access must still be constrained by rules, App Check where appropriate, quotas, and monitoring.
- Private API keys, service-account credentials, signing keys, and provider secrets belong in a managed server-side secrets store, never in the static site or its build output.
- App Check can reduce automated abuse of supported Firebase services but is not authorization and does not replace rules, backend validation, or rate limiting.

## Content Security Policy and HTTP headers

- `index.html` has a transitional CSP meta policy. It allows local scripts plus the integrity-pinned Three.js CDN and disables inline script attributes. It permits `'unsafe-inline'` styles because the page has inline styles and the existing pointer effect applies styles at runtime.
- This policy is not a substitute for a reviewed deployment policy. A meta policy cannot set every directive (including `frame-ancestors`) and does not provide HTTP response-header protections.
- Before production, move styles and runtime style updates toward nonce/hash or external styles, tighten the policy, and configure CSP as an HTTP response header.
- Configure and verify hosting headers such as HSTS (HTTPS only), `X-Content-Type-Options: nosniff`, an appropriate `Referrer-Policy`, `Permissions-Policy`, and CSP including `frame-ancestors`. Consider COOP/CORP/CORS only as appropriate to the deployed application.
- Keep allowed origins and `connect-src` limited to required production services.

## Security testing

Before each release, test:

- Guest, customer, worker, suspended, and admin authorization cases at the backend and database-rule level, including attempted cross-account reads and writes.
- Input boundary values, Unicode names, quotes, markup-like strings, very long content, malformed IDs, invalid enum values, and stored/reflected XSS cases.
- File type/size checks, upload scanning, access control, deletion, and private-document exposure.
- Rate limits, replay/idempotency, request state transitions, abuse reports, account suspension, and audit-log integrity.
- CSP and all HTTP response headers on the deployed origin, third-party integrity behavior, dependency updates, and browser console/network errors.
- Privacy review for data collection, access, retention, exports, deletion, analytics, and logs.

## Production deployment checklist

- [ ] Real authentication provider configured; no credentials embedded in source or browser storage.
- [ ] MFA and strengthened access controls applied to administrator accounts.
- [ ] Firestore rules default-deny and emulator-tested for allowed and forbidden cases.
- [ ] Storage rules default-deny; private uploads scanned and isolated.
- [ ] Every sensitive operation authorized and validated in trusted server code.
- [ ] Server-side rate limiting, abuse controls, suspension enforcement, and tamper-resistant audit logging enabled.
- [ ] Data minimization, consent, retention, deletion, backup, and incident-response policies approved.
- [ ] App Check enabled where appropriate and treated only as a supplementary control.
- [ ] Secrets stored and rotated through a managed secrets service with least privilege.
- [ ] Production CSP and HTTP security headers reviewed and verified on the deployed origin.
- [ ] Dependency, rules, backend, privacy, accessibility, and security tests pass.
- [ ] Monitoring, alerting, backups, recovery, and a vulnerability-response process are operational.
