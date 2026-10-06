# JKFixHub

JKFixHub is an interactive frontend prototype for a planned local-services marketplace across Jammu & Kashmir.

## Project structure

- `index.html` - page structure, demo search, worker cards, modals, and registration preview.
- `js/worker-data.js` - the fictional demo worker records.
- `js/search.js` - worker discovery, filtering, and card rendering.
- `js/request.js` - frontend-only request preview and validation.
- `js/store.js` - in-memory worker, request, and demo-user state.
- `js/auth.js` - customer/worker demo-role UI; not real authentication.
- `js/worker-dashboard.js` - worker dashboard preview with temporary profile overrides and illustrative request samples.
- `js/security.js` - frontend validation, capability definitions, and temporary security-event helpers.
- `js/modals.js` and `js/navigation.js` - modal and navigation behavior.
- `js/scene.js` - standalone Three.js/WebGL background with procedural service objects, network lines, particles, parallax, and adaptive performance controls.
- `css/polish.css` - responsive natural-technology visual system, component styles, and reduced-motion-aware interactions.
- `DESIGN_SYSTEM.md` - permanent reference for JKFixHub colors, typography, spacing, components, motion, responsiveness, and accessibility.
- `SECURITY.md` - current frontend security boundaries and production security requirements.
- `.github/agents/jkfixhub-prototype.agent.md` - project-specific prototype guidance.

## Demo mode

The site uses local fictional demo workers only. It does not connect Firebase, persist form data, provide real authentication, track location, send service requests, or provide real chat. Demo roles and request drafts exist in memory only and are cleared on reload.

Worker dashboard profile edits, availability changes, and request samples are frontend-only demo state. Dashboard actions do not accept, reject, or complete real requests.

## 3D background

Three.js `0.160.0` is loaded from jsDelivr in `index.html` with Subresource Integrity. The scene uses lightweight procedural geometry for a glowing JKFixHub hub, service-inspired objects, connection paths, and particles. It adds pointer parallax and scroll response, scales and simplifies rendering for smaller or lower-power devices, pauses while the tab is hidden, and renders a still scene when reduced motion is requested. The CSS visual treatment remains in place if WebGL is unavailable.

## Security

Read `SECURITY.md` before adding authentication, user-generated content, uploads, messaging, or backend operations. Frontend role checks and validation are usability safeguards only; they do not provide trusted authorization or production anti-abuse controls.

The interface uses local-only demo data. Search, service selection, profile views, and prototype status modals work in the browser; worker registration, location lookup, requests, contact, identity checks, and communication are not connected.

Future visual changes should follow `DESIGN_SYSTEM.md` and update it in the same task whenever the shipped visual rules change. The project-specific agent guidance in `.github/agents/jkfixhub-prototype.agent.md` also requires this.

## Run locally

Open `index.html` in a browser with internet access so the Three.js CDN can load. The same static structure works on GitHub Pages without a build step.

## GitHub Pages

Commit `index.html` and the `js/scene.js` folder to the `main` branch. GitHub Pages will serve the static prototype from the repository root.

## Code maintenance notes

- `index.html` contains the page structure, demo data, modal logic, and interaction wiring.
- `js/scene.js` owns the ambient Three.js visualization and keeps the WebGL behavior isolated from the rest of the page.
- `css/polish.css` is the visual reference for the shipped product identity; preserve it unless a design change is explicitly requested.
- Keep new changes scoped to code clarity and maintainability without altering the working demo experience or visual output.
