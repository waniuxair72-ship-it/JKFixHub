# [JK] FixHub

[JK] FixHub (JK FixHub) is a planned local-services platform connecting customers with skilled local repair and service professionals across Jammu & Kashmir.

## Project structure

- `index.html` - page structure, search, worker cards, modals, and account onboarding.
- `js/worker-data.js` - fictional sample worker records (read-only single source of worker records).
- `js/search.js` - worker discovery, filtering, and card rendering.
- `js/request.js` - frontend request validation and creation flow.
- `js/store.js` - in-memory application state boundary (requests, reviews, reports, temporary sessions).
- `js/firebase-config.js` - client-side public Firebase Web configuration boundary and modular SDK initialization.
- `js/auth.js` - Firebase Authentication controller, email/password registration, login, logout, and offline fallback.
- `js/worker-dashboard.js` - worker workspace with temporary profile overrides, request workflow, and reviews.
- `js/customer-requests.js` - customer request history, detail view, cancellation, and review access.
- `js/chat.js` - private chat architecture for accepted requests.
- `js/reviews.js` - review system for completed requests and worker replies.
- `js/reports.js` - trust and safety reporting system for workers, customers, reviews, and messages.
- `js/abuse.js` - in-memory abuse signal tracking and soft prototype rate limiting.
- `js/admin-dashboard.js` - privileged admin dashboard foundation and security boundary (workers, requests, reports, reviews, security events, audit log).
- `js/security.js` - frontend validation, capability definitions, and security-event logging helpers.
- `js/modals.js` and `js/navigation.js` - modal and navigation behavior.
- `js/scene.js` - standalone Three.js/WebGL background with procedural service objects, network lines, particles, parallax, and adaptive performance controls.
- `css/polish.css` - responsive natural-technology visual system, component styles, and reduced-motion-aware interactions.
- `DESIGN_SYSTEM.md` - permanent reference for [JK] FixHub colors, typography, spacing, components, motion, responsiveness, and accessibility.
- `SECURITY.md` - current frontend security boundaries and production security requirements.
- `.github/agents/jkfixhub-prototype.agent.md` - project-specific prototype guidance.

## Current Stage & Service Boundaries

### CURRENT (Implemented in Step 16):
- **Firebase Authentication**: Live email/password registration and sign-in for Customers and Workers via modular Firebase Web SDK.
- **Email Verification**: Identity provider verification email dispatch and live `emailVerified` status tracking.
- **Strict Role Isolation**: Public interface exposes only Customer and Worker options; Admin interface is completely segregated and protected by `canAccessAdmin()` boundaries.
- **In-Memory Store**: Application state (`js/store.js`) maintains sessions, request drafts, reviews, reports, and audit events in memory during the active browser session.

### NOT YET (Planned for Future Steps):
- **Cloud Firestore** (Step 17+): Persistent cloud database storage and server-enforced Security Rules.
- **Firebase Storage** (Step 18+): Cloud object storage for documents and profile attachments.
- **Cloud Functions / Backend Enforcement** (Step 19+): Server-authoritative role verification, custom claims, and production anti-abuse infrastructure.

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
