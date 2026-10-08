// ==========================================
// #ADMIN_CANVAS
// ==========================================
// Ultra-Lightweight Architectural Background & Signature Parallax System
//
// Performance & Accessibility Hardening:
// 1. Device-adaptive rendering profiles (Desktop vs. Mobile vs. Reduced Motion).
// 2. Strict DPR capping (1.0 on mobile, max 1.25 on desktop) to prevent GPU fill-rate exhaustion.
// 3. Frame rate pacing (capped at ~30-40fps) to eliminate 120Hz battery drain.
// 4. Zero DOM mutations in continuous animation loop. Parallax updates strictly throttled to pointer events.
// 5. Zero heavy canvas full-screen gradients in per-frame tick (offloaded to CSS compositor).
// 6. 100% CPU idle (0% rAF) when document is hidden or prefers-reduced-motion is active.
// ==========================================

export function initializeAdminCanvas() {
  const canvas = document.getElementById("admin3dCanvas");
  const signatureLayer = document.getElementById("adminSignatureLayer");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let isMobile = false;

  // Reduced motion query
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let isReducedMotion = reducedMotionQuery.matches;

  reducedMotionQuery.addEventListener("change", (e) => {
    isReducedMotion = e.matches;
    if (isReducedMotion) {
      stopAnimation();
      drawStaticFrame();
    } else {
      startAnimation();
    }
  });

  // Mouse & Parallax tracking
  let mouseX = 0;
  let mouseY = 0;
  let targetMouseX = 0;
  let targetMouseY = 0;
  let isMouseActive = false;
  let parallaxPending = false;

  const handlePointerMove = (e) => {
    if (isMobile || isReducedMotion) return;
    targetMouseX = e.clientX;
    targetMouseY = e.clientY;
    isMouseActive = true;

    // Throttle DOM parallax mutation to pointer activity only
    if (!parallaxPending && signatureLayer) {
      parallaxPending = true;
      requestAnimationFrame(() => {
        if (signatureLayer && !isReducedMotion && !isMobile) {
          const offsetX = (targetMouseX - width / 2) / (width / 2);
          const offsetY = (targetMouseY - height / 2) / (height / 2);
          const tiltX = -offsetY * 3.5;
          const tiltY = offsetX * 4.5;
          const panX = offsetX * 12;
          const panY = offsetY * 8;
          signatureLayer.style.transform = `perspective(1000px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translate3d(${panX.toFixed(1)}px, ${panY.toFixed(1)}px, 0)`;
        }
        parallaxPending = false;
      });
    }
  };

  const handlePointerLeave = () => {
    isMouseActive = false;
    if (signatureLayer) {
      signatureLayer.style.transform = "none";
    }
  };

  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerleave", handlePointerLeave, { passive: true });

  // Geometry nodes & rings
  let nodes = [];
  let rings = [];

  const setupGeometry = () => {
    isMobile = window.innerWidth < 768;
    const nodeCount = isMobile ? 12 : 22;

    nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: (Math.random() - 0.5) * 1400,
        y: (Math.random() - 0.5) * 1000,
        z: Math.random() * 700 + 200,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: Math.random() * 1.4 + 0.8,
        alpha: Math.random() * 0.3 + 0.15
      });
    }

    if (isMobile) {
      rings = [
        { x: 100, y: 50, z: 500, radius: 130, rotX: 0.6, rotY: 0.3, rotZ: 0, speed: 0.0015 }
      ];
    } else {
      rings = [
        { x: -220, y: -90, z: 450, radius: 140, rotX: 0.8, rotY: 0.4, rotZ: 0, speed: 0.002 },
        { x: 280, y: 120, z: 550, radius: 190, rotX: -0.6, rotY: 0.8, rotZ: 0, speed: -0.0018 }
      ];
    }
  };

  // Perspective project helper
  const fov = 600;
  function project(x, y, z) {
    const scale = fov / (fov + z);
    return {
      x: width / 2 + x * scale,
      y: height / 2 + y * scale,
      scale
    };
  }

  // Resize handler
  const handleResize = () => {
    isMobile = window.innerWidth < 768;
    // Strict DPR capping: 1 on mobile to prevent GPU fill-rate exhaustion; 1.25 on desktop
    dpr = isMobile ? 1 : Math.min(window.devicePixelRatio || 1, 1.25);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    setupGeometry();

    if (signatureLayer && isMobile) {
      signatureLayer.style.transform = "none";
    }

    if (isReducedMotion) {
      drawStaticFrame();
    }
  };

  window.addEventListener("resize", handleResize, { passive: true });
  handleResize();

  // --------------------------------------------------------------------------
  // Paced Render Loop (Throttled for zero UI contention)
  // --------------------------------------------------------------------------
  let animationFrameId = null;
  let lastFrameTime = 0;
  // Frame interval: ~33ms (30fps) on mobile, ~22ms (45fps) on desktop
  const getTargetInterval = () => (isMobile ? 33 : 22);

  function drawScene(time) {
    // Clear canvas fast
    ctx.clearRect(0, 0, width, height);

    // 1. Perspective Coordinate Grid (subtle architectural grid lines)
    ctx.save();
    ctx.strokeStyle = "rgba(63, 142, 101, 0.04)";
    ctx.lineWidth = 1;

    const gridSpan = isMobile ? 400 : 600;
    const gridStep = isMobile ? 120 : 100;
    const gridZ = 320;

    ctx.beginPath();
    // Horizontal perspective lines
    for (let gy = -gridSpan; gy <= gridSpan; gy += gridStep) {
      const p1 = project(-gridSpan, gy, gridZ);
      const p2 = project(gridSpan, gy, gridZ);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    // Vertical perspective lines
    for (let gx = -gridSpan; gx <= gridSpan; gx += gridStep) {
      const p1 = project(gx, -gridSpan, gridZ);
      const p2 = project(gx, gridSpan, gridZ);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
    ctx.restore();

    // 2. Floating Architectural Wireframe Rings
    ctx.save();
    ctx.strokeStyle = "rgba(74, 158, 116, 0.065)";
    ctx.lineWidth = 1;

    const segments = isMobile ? 12 : 18;
    for (const ring of rings) {
      if (!isReducedMotion) {
        ring.rotZ += ring.speed;
        ring.rotX += ring.speed * 0.5;
      }

      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const rx = Math.cos(theta) * ring.radius;
        const ry = Math.sin(theta) * ring.radius;

        const cosX = Math.cos(ring.rotX);
        const sinX = Math.sin(ring.rotX);
        const y1 = ry * cosX;
        const z1 = ry * sinX;

        const cosY = Math.cos(ring.rotY);
        const sinY = Math.sin(ring.rotY);
        const x2 = rx * cosY + z1 * sinY;
        const z2 = -rx * sinY + z1 * cosY;

        const cosZ = Math.cos(ring.rotZ);
        const sinZ = Math.sin(ring.rotZ);
        const x3 = x2 * cosZ - y1 * sinZ;
        const y3 = x2 * sinZ + y1 * cosZ;

        const p = project(ring.x + x3, ring.y + y3, ring.z + z2);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 3. Floating Micro-Nodes / Particles
    ctx.save();
    for (const node of nodes) {
      if (!isReducedMotion) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x > 700) node.x = -700;
        if (node.x < -700) node.x = 700;
        if (node.y > 500) node.y = -500;
        if (node.y < -500) node.y = 500;
      }

      const p = project(node.x, node.y, node.z);
      ctx.fillStyle = `rgba(142, 198, 165, ${node.alpha * p.scale})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, node.radius * p.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function loop(time) {
    const targetInterval = getTargetInterval();
    if (time - lastFrameTime >= targetInterval) {
      lastFrameTime = time;
      drawScene(time);
    }
    animationFrameId = requestAnimationFrame(loop);
  }

  function startAnimation() {
    if (!animationFrameId && !isReducedMotion) {
      lastFrameTime = performance.now();
      animationFrameId = requestAnimationFrame(loop);
    }
  }

  function stopAnimation() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  function drawStaticFrame() {
    drawScene(performance.now());
    if (signatureLayer) {
      signatureLayer.style.transform = "none";
    }
  }

  // Document visibility management (Page Visibility API)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopAnimation();
    } else {
      if (!isReducedMotion) startAnimation();
    }
  });

  if (isReducedMotion) {
    drawStaticFrame();
  } else {
    startAnimation();
  }
}
