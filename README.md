# JKFixHub

JKFixHub is an interactive frontend prototype for a planned local-services marketplace across Jammu & Kashmir.

## Project structure

- `index.html` - page structure, demo search, worker cards, modals, and registration preview.
- `js/scene.js` - standalone Three.js/WebGL background with procedural service objects, network lines, particles, parallax, and adaptive performance controls.
- `css/polish.css` - responsive natural-technology visual system, component styles, and reduced-motion-aware interactions.
- `DESIGN_SYSTEM.md` - permanent reference for JKFixHub colors, typography, spacing, components, motion, responsiveness, and accessibility.
- `.github/agents/jkfixhub-prototype.agent.md` - project-specific prototype guidance.

## Demo mode

The site uses local fictional demo workers only. It does not connect Firebase, store form data, authenticate users, track location, send service requests, or provide real chat.

## 3D background

Three.js `0.160.0` is loaded from jsDelivr in `index.html`. The scene uses lightweight procedural geometry for a glowing JKFixHub hub, service-inspired objects, connection paths, and particles. It adds pointer parallax and scroll response, scales and simplifies rendering for smaller or lower-power devices, pauses while the tab is hidden, and renders a still scene when reduced motion is requested. The CSS visual treatment remains in place if WebGL is unavailable.

The interface uses local-only demo data. Search, service selection, profile views, and prototype status modals work in the browser; worker registration, location lookup, requests, contact, identity checks, and communication are not connected.

Future visual changes should follow `DESIGN_SYSTEM.md` and update it in the same task whenever the shipped visual rules change. The project-specific agent guidance in `.github/agents/jkfixhub-prototype.agent.md` also requires this.

## Run locally

Open `index.html` in a browser with internet access so the Three.js CDN can load. The same static structure works on GitHub Pages without a build step.

## GitHub Pages

Commit `index.html` and the `js/scene.js` folder to the `main` branch. GitHub Pages will serve the static prototype from the repository root.
