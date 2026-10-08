// ==========================================
// #ADMIN_CANVAS
// ==========================================
// Lightweight 3D Cinematic Background & Signature Parallax System
//
// Performance & Accessibility Guarantees:
// 1. Zero external 3D libraries — ultra-fast vanilla Canvas 2D engine (<60fps target).
// 2. Halts animation loop when document is hidden (0% background CPU usage).
// 3. Strictly respects prefers-reduced-motion (draws single static frame, halts rAF).
// 4. Subtle, non-intrusive ambient depth that never interferes with text readability.
// ==========================================

export function initializeAdminCanvas() {
  const canvas = document.getElementById("admin3dCanvas");
  const signatureLayer = document.getElementById("adminSignatureLayer");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let width = 0;
  let height = 0;
  let dpr = 1;

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

  const handlePointerMove = (e) => {
    targetMouseX = e.clientX;
    targetMouseY = e.clientY;
    isMouseActive = true;
  };

  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerleave", () => {
    isMouseActive = false;
  }, { passive: true });

  // Resize handler
  const handleResize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    if (isReducedMotion) {
      drawStaticFrame();
    }
  };

  window.addEventListener("resize", handleResize, { passive: true });
  handleResize();

  // --------------------------------------------------------------------------
  // Spatial Geometry Models
  // --------------------------------------------------------------------------
  // 3D Polygons & Nodes
  const nodes = [];
  const nodeCount = 35;
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      x: (Math.random() - 0.5) * 1600,
      y: (Math.random() - 0.5) * 1200,
      z: Math.random() * 800 + 200,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      radius: Math.random() * 1.6 + 0.8,
      alpha: Math.random() * 0.35 + 0.15
    });
  }

  // Floating wireframe rings (Architectural rings)
  const rings = [
    { x: -280, y: -120, z: 450, radius: 140, rotX: 0.8, rotY: 0.4, rotZ: 0, speed: 0.003 },
    { x: 380, y: 160, z: 550, radius: 220, rotX: -0.6, rotY: 0.8, rotZ: 0, speed: -0.0025 },
    { x: 120, y: -260, z: 650, radius: 180, rotX: 1.2, rotY: -0.5, rotZ: 0, speed: 0.002 }
  ];

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

  // --------------------------------------------------------------------------
  // Render Routine
  // --------------------------------------------------------------------------
  let animationFrameId = null;
  let lastTime = performance.now();

  function drawScene(time) {
    const delta = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    // Smooth pointer damping
    if (!isMouseActive) {
      // Gentle ambient lissajous motion if idle
      targetMouseX = width / 2 + Math.sin(time * 0.0008) * 120;
      targetMouseY = height / 2 + Math.cos(time * 0.0006) * 80;
    }
    mouseX += (targetMouseX - mouseX) * 0.05;
    mouseY += (targetMouseY - mouseY) * 0.05;

    // Clear canvas with deep obsidian slate gradient
    ctx.clearRect(0, 0, width, height);

    // 1. Subtle Ambient Radial Glow following pointer
    const glowRadius = Math.max(width * 0.55, 600);
    const ambientGlow = ctx.createRadialGradient(
      mouseX, mouseY, 40,
      mouseX, mouseY, glowRadius
    );
    ambientGlow.addColorStop(0, "rgba(49, 122, 86, 0.12)");
    ambientGlow.addColorStop(0.45, "rgba(35, 78, 56, 0.05)");
    ambientGlow.addColorStop(1, "rgba(10, 16, 12, 0)");
    ctx.fillStyle = ambientGlow;
    ctx.fillRect(0, 0, width, height);

    // 2. Perspective Coordinate Grid
    ctx.save();
    ctx.strokeStyle = "rgba(63, 142, 101, 0.045)";
    ctx.lineWidth = 1;

    const gridSpan = 700;
    const gridStep = 100;
    const gridZ = 300;

    // Horizontal perspective lines
    for (let gy = -gridSpan; gy <= gridSpan; gy += gridStep) {
      const p1 = project(-gridSpan, gy, gridZ);
      const p2 = project(gridSpan, gy, gridZ);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // Vertical perspective lines
    for (let gx = -gridSpan; gx <= gridSpan; gx += gridStep) {
      const p1 = project(gx, -gridSpan, gridZ);
      const p2 = project(gx, gridSpan, gridZ);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    ctx.restore();

    // 3. Floating Architectural Wireframe Rings
    ctx.save();
    for (const ring of rings) {
      if (!isReducedMotion) {
        ring.rotZ += ring.speed;
        ring.rotX += ring.speed * 0.6;
      }

      ctx.strokeStyle = "rgba(74, 158, 116, 0.075)";
      ctx.lineWidth = 1.2;

      const segments = 24;
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        // Local 3D ring coords
        let rx = Math.cos(theta) * ring.radius;
        let ry = Math.sin(theta) * ring.radius;
        let rz = 0;

        // Apply rotations
        // Rot X
        const cosX = Math.cos(ring.rotX);
        const sinX = Math.sin(ring.rotX);
        const y1 = ry * cosX - rz * sinX;
        const z1 = ry * sinX + rz * cosX;

        // Rot Y
        const cosY = Math.cos(ring.rotY);
        const sinY = Math.sin(ring.rotY);
        const x2 = rx * cosY + z1 * sinY;
        const z2 = -rx * sinY + z1 * cosY;

        // Rot Z
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

    // 4. Floating Micro-Nodes / Particles
    ctx.save();
    for (const node of nodes) {
      if (!isReducedMotion) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x > 800) node.x = -800;
        if (node.x < -800) node.x = 800;
        if (node.y > 600) node.y = -600;
        if (node.y < -600) node.y = 600;
      }

      const p = project(node.x, node.y, node.z);
      ctx.fillStyle = `rgba(142, 198, 165, ${node.alpha * p.scale})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, node.radius * p.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 5. Update Signature Parallax Transformation
    if (signatureLayer && !isReducedMotion) {
      const offsetX = (mouseX - width / 2) / (width / 2);
      const offsetY = (mouseY - height / 2) / (height / 2);
      const tiltX = -offsetY * 4.5;
      const tiltY = offsetX * 5.5;
      const panX = offsetX * 16;
      const panY = offsetY * 12;

      signatureLayer.style.transform = `perspective(1000px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translate3d(${panX.toFixed(1)}px, ${panY.toFixed(1)}px, 0)`;
    }
  }

  function loop(time) {
    drawScene(time);
    animationFrameId = requestAnimationFrame(loop);
  }

  function startAnimation() {
    if (!animationFrameId && !isReducedMotion) {
      lastTime = performance.now();
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

  // Document visibility management
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

