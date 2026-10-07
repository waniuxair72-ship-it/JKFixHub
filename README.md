# [JK] FixHub

[JK] FixHub (JK FixHub) is a planned local-services platform connecting customers with skilled local repair and service professionals across Jammu & Kashmir.

## Project structure

- `index.html` - public platform interface, search, worker cards, customer modals, and customer/worker account onboarding.
- `admin.html` - dedicated privileged administration application with Firebase Authentication and server-side authorization.
- `css/admin.css` - responsive, accessible styling for the platform administration panel adhering to `DESIGN_SYSTEM.md`.
- `js/worker-data.js` - fictional sample worker records (read-only single source of worker records).
- `js/search.js` - worker discovery, filtering, and card rendering.
- `js/request.js` - frontend request validation and creation flow.
- `js/store.js` - in-memory application state boundary (requests, reviews, reports, temporary sessions).
- `js/firebase-config.js` - client-side public Firebase Web configuration boundary and modular SDK initialization (Auth & Firestore).
- `js/firestore-service.js` - Cloud Firestore data access layer, admin verification, and audit logging.
- `js/admin-auth.js` - authoritative administrator authentication and session boundary.
- `js/admin-app.js` - live Firestore administration panel controller (workers, customers, requests, reports, reviews, security, audit log).
- `js/auth.js` - Firebase Authentication controller, email/password registration, login, logout, and offline fallback.
- `js/worker-dashboard.js` - worker workspace with temporary profile overrides, request workflow, and reviews.
- `js/customer-requests.js` - customer request history, detail view, cancellation, and review access.
- `js/chat.js` - private chat architecture for accepted requests.
- `js/reviews.js` - review system for completed requests and worker replies.
- `js/reports.js` - trust and safety reporting system for workers, customers, reviews, and messages.
- `js/abuse.js` - in-memory abuse signal tracking and soft prototype rate limiting.
- `js/admin-dashboard.js` - legacy in-memory admin security boundary and test harness.
- `js/security.js` - frontend validation, capability definitions, and security-event logging helpers.
- `js/modals.js` and `js/navigation.js` - modal and navigation behavior.
- `js/scene.js` - standalone Three.js/WebGL background with procedural service objects, network lines, particles, parallax, and adaptive performance controls.
- `css/polish.css` - responsive natural-technology visual system, component styles, and reduced-motion-aware interactions.
- `firestore.rules` - server-side Cloud Firestore Security Rules enforcing least-privilege, admin membership, and document privacy.
- `firestore.indexes.json` - Cloud Firestore index configuration.
- `firebase.json` - Firebase project configuration.
- `DESIGN_SYSTEM.md` - permanent reference for [JK] FixHub colors, typography, spacing, components, motion, responsiveness, and accessibility.
- `SECURITY.md` - current frontend security boundaries, Firestore security rules, admin authorization architecture, and bootstrap procedures.
- `.github/agents/jkfixhub-prototype.agent.md` - project-specific prototype guidance.

## Current Stage & Service Boundaries

### CURRENT (Implemented in Steps 16 & 17):
- **Firebase Authentication**: Live email/password registration and sign-in for Customers and Workers via modular Firebase Web SDK.
- **Cloud Firestore Backend Foundation (Step 17)**: Document data layer supporting users, workers, requests, reviews, reports, security events, and audit logs.
- **Server-Side Authorization (`firestore.rules`)**: Authoritative database security rules enforcing least privilege, customer request ownership, worker profile boundaries, and `/admins/{uid}` membership verification. Client-side role tampering cannot bypass Firestore rules.
- **Dedicated Admin Panel (`admin.html`)**: Segregated administrative panel requiring Firebase Authentication and verified `/admins/{uid}` document membership.
- **Administrative Operations**: Worker moderation (approve/suspend/restore), customer inspection, request tracking, trust & safety report resolution, review moderation, and security signal monitoring.
- **Append-Only Audit Trail**: Every privileged administrative operation writes an immutable record to `/auditLogs` with admin UID, action, target, timestamp, and outcome.

### NOT YET (Planned for Future Steps):
- **Firebase Storage** (Step 18+): Cloud object storage for identity documents, verification certificates, and profile attachments.
- **Cloud Functions / Backend Enforcement** (Step 19+): Server-authoritative custom claims (`admin: true`), automated database triggers, and production-grade rate limiting.

## 3D background

Three.js `0.160.0` is loaded from jsDelivr in `index.html` with Subresource Integrity. The scene uses lightweight procedural geometry for a glowing hub, service-inspired objects, connection paths, and particles. It adds pointer parallax and scroll response, scales and simplifies rendering for smaller or lower-power devices, pauses while the tab is hidden, and renders a still scene when reduced motion is requested. The CSS visual treatment remains in place if WebGL is unavailable.

## Security

Read `SECURITY.md` before adding backend operations, database persistence, uploads, or production authorization. Frontend role checks and validation are usability safeguards only; they do not provide trusted authorization or production anti-abuse controls. Real authorization must be enforced server-side.

Future visual changes should follow `DESIGN_SYSTEM.md` and update it in the same task whenever the shipped visual rules change.

## Run locally

Open `index.html` in a browser with internet access so the Three.js CDN can load. The same static structure works on GitHub Pages without a build step.

## GitHub Pages

Commit `index.html` and the `js/scene.js` folder to the `main` branch. GitHub Pages will serve the static prototype from the repository root.

## Code maintenance notes

- `index.html` contains the page structure, demo data, modal logic, and interaction wiring.
- `js/scene.js` owns the ambient Three.js visualization and keeps the WebGL behavior isolated from the rest of the page.
- `css/polish.css` is the visual reference for the shipped product identity; preserve it unless a design change is explicitly requested.
- Keep new changes scoped to code clarity and maintainability without altering the working demo experience or visual output.
