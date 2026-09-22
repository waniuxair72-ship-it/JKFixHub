# JKFixHub

JKFixHub is an interactive frontend prototype for a planned local-services marketplace across Jammu & Kashmir.

## Project structure

- `index.html` - page structure, UI styles, demo search, worker cards, modals, and registration preview.
- `js/scene.js` - standalone Three.js/WebGL background with procedural service objects, network lines, particles, parallax, and performance controls.
- `css/polish.css` - focused product-surface refinements for buttons, cards, service marks, trust items, inputs, and modal motion.
- `.github/agents/jkfixhub-prototype.agent.md` - project-specific prototype guidance.

## Demo mode

The site uses local fictional demo workers only. It does not connect Firebase, store form data, authenticate users, track location, send service requests, or provide real chat.

## 3D background

Three.js `0.160.0` is loaded from jsDelivr in `index.html`. The scene is built from lightweight procedural geometry and includes a glowing JKFixHub hub, ten service-inspired objects, connection paths, moving request particles, depth, mouse parallax, scroll response, reduced-motion support, tab-visibility pausing, and a CSS fallback when WebGL is unavailable.

## Run locally

Open `index.html` in a browser with internet access so the Three.js CDN can load. The same static structure works on GitHub Pages without a build step.

## GitHub Pages

Commit `index.html` and the `js/scene.js` folder to the `main` branch. GitHub Pages will serve the static prototype from the repository root.
