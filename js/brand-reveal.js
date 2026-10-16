// ==========================================================================
// JK FIXHUB - SEGMENTED-RING HERO SEQUENCER
// Handles brand reveal lifecycle, reduced-motion overrides, and service card routing.
// ==========================================================================

export function initializeBrandReveal() {
  const stage = document.querySelector(".hero-ring-stage");
  if (!stage) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Immediate static settle if reduced motion is preferred
  if (prefersReducedMotion) {
    stage.classList.add("is-settled");
  } else {
    // Stage D: Settle after coordinated mechanical opening sequence (~2.4s)
    const settleTimeout = setTimeout(() => {
      stage.classList.add("is-settled");
    }, 2400);

    // If arc animation fires an animationend event, settle smoothly
    const primaryArc = stage.querySelector(".arc-top-left");
    if (primaryArc) {
      primaryArc.addEventListener("animationend", () => {
        clearTimeout(settleTimeout);
        stage.classList.add("is-settled");
      }, { once: true });
    }
  }

  // Interactive routing for the Coverage Across Kashmir service cards
  const serviceCards = document.querySelectorAll(".service-card-item");
  serviceCards.forEach((card) => {
    card.addEventListener("click", (event) => {
      const serviceTarget = card.getAttribute("data-service-select");
      if (serviceTarget) {
        const serviceSelect = document.getElementById("serviceFilter");
        if (serviceSelect) {
          // If the select contains an option matching or starting with this service
          for (let i = 0; i < serviceSelect.options.length; i++) {
            const opt = serviceSelect.options[i];
            if (opt.value && (opt.value.includes(serviceTarget) || serviceTarget.includes(opt.value))) {
              serviceSelect.selectedIndex = i;
              serviceSelect.dispatchEvent(new Event("change", { bubbles: true }));
              break;
            }
          }
        }
      }
    });
  });
}
