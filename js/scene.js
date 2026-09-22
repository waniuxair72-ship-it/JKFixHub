(function () {
  "use strict";

  function initWebGLBackground() {
    const canvas = document.getElementById("webgl-background");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!canvas || !window.THREE || !window.WebGLRenderingContext) return;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: window.innerWidth > 700,
        powerPreference: "low-power"
      });
    } catch (error) {
      canvas.style.display = "none";
      return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07131f, 0.035);
    const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0.2, 8.5);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.15 : 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const group = new THREE.Group();
    const network = new THREE.Group();
    const movingObjects = [];
    const travelers = [];
    scene.add(group, network);
    scene.add(new THREE.HemisphereLight(0x9edbe9, 0x07131f, 0.55));

    const keyLight = new THREE.PointLight(0x69d9ef, 2.1, 15);
    keyLight.position.set(1.5, 2.5, 3);
    scene.add(keyLight);

    const fillLight = new THREE.PointLight(0x8ce5c2, 1.05, 12);
    fillLight.position.set(-3, -2, 1);
    scene.add(fillLight);

    const rimLight = new THREE.PointLight(0xffffff, 0.45, 9);
    rimLight.position.set(0, 3, -3);
    scene.add(rimLight);

    const center = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.05, 2),
      new THREE.MeshStandardMaterial({
        color: 0x123b50,
        emissive: 0x1b9ab4,
        emissiveIntensity: 0.85,
        metalness: 0.55,
        roughness: 0.28,
        transparent: true,
        opacity: 0.94
      })
    );
    group.add(center);

    const innerCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.68, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x69d9ef, transparent: true, opacity: 0.16 })
    );
    group.add(innerCore);

    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.22, 1),
      new THREE.MeshBasicMaterial({ color: 0x8ce5c2, wireframe: true, transparent: true, opacity: 0.12 })
    );
    group.add(shell);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.42, 0.012, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x69d9ef, transparent: true, opacity: 0.52 })
    );
    ring.rotation.x = Math.PI / 2.5;
    group.add(ring);
    const ringSecond = ring.clone();
    ringSecond.scale.setScalar(0.72);
    ringSecond.rotation.x = Math.PI / 1.8;
    ringSecond.rotation.y = Math.PI / 5;
    ringSecond.material = ring.material.clone();
    ringSecond.material.color.setHex(0x8ce5c2);
    ringSecond.material.opacity = 0.32;
    group.add(ringSecond);

    const nodePositions = [
      [-2.55, 1.45, -0.9], [2.35, 1.2, -1.6], [-2.45, -1.25, 0.2],
      [2.55, -1.3, -1], [-0.35, 2.35, -2.5], [0.2, -2.25, -2.1],
      [-3.15, 0.05, -2.6], [3.1, 0.05, -2.8], [-1.1, -2.45, -3], [1.15, 2.45, -3.2]
    ];
    const serviceKinds = ["bolt", "appliance", "pin", "screen", "gear", "toolbox", "circuit", "worker", "washer", "home"];
    const nodeMaterials = [0x69d9ef, 0x8ce5c2, 0x69d9ef, 0x8ce5c2, 0xffffff, 0x69d9ef, 0x8ce5c2, 0x69d9ef, 0x8ce5c2, 0xffffff];
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x69d9ef, transparent: true, opacity: 0.2 });

    function makeMaterial(color) {
      return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.42, roughness: 0.34, metalness: 0.38, transparent: true, opacity: 0.84 });
    }

    function createServiceObject(kind, color) {
      const object = new THREE.Group();
      const material = makeMaterial(color);
      const detail = makeMaterial(0xffffff);
      if (kind === "bolt") object.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), material));
      if (kind === "appliance") { const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.4), material); const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.03), detail); handle.position.set(0.19, 0.02, 0.22); object.add(box, handle); }
      if (kind === "pin") { const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8), material); const stem = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 8), material); stem.position.y = -0.3; object.add(head, stem); }
      if (kind === "screen") { const screen = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.4, 0.08), material); const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.08), detail); stand.position.y = -0.28; object.add(screen, stand); }
      if (kind === "gear") { const gear = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.1, 6, 10), material); const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8), detail); hub.rotation.x = Math.PI / 2; object.add(gear, hub); }
      if (kind === "toolbox") { const box = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.34, 0.4), material); const bar = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 6, 12, Math.PI), detail); bar.rotation.z = Math.PI; bar.position.y = 0.24; object.add(box, bar); }
      if (kind === "circuit") { const board = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.08, 0.4), material); const chip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.13), detail); chip.position.y = 0.09; object.add(board, chip); }
      if (kind === "worker") { const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.28, 4, 8), material); const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), detail); head.position.y = 0.32; object.add(body, head); }
      if (kind === "washer") { const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.4, 12), material); const door = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.035, 6, 16), detail); door.rotation.x = Math.PI / 2; door.position.y = 0.22; object.add(drum, door); }
      if (kind === "home") { const base = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.4), material); const roof = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.3, 4), detail); roof.rotation.y = Math.PI / 4; roof.position.y = 0.3; object.add(base, roof); }
      return object;
    }

    nodePositions.forEach((position, index) => {
      const node = createServiceObject(serviceKinds[index], nodeMaterials[index]);
      node.position.set(...position);
      node.userData = { phase: index * 1.7, baseY: position[1], spin: 0.7 + index * 0.04 };
      group.add(node);
      movingObjects.push(node);

      const endpoint = new THREE.Vector3(...position);
      const control = new THREE.Vector3(position[0] * 0.45, position[1] * 0.45 + (index % 2 ? 0.28 : -0.2), position[2] * 0.55 + 0.45);
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), control, endpoint);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(18)), lineMaterial.clone());
      line.userData = { endpoint, curve };
      network.add(line);
      if (index < 6) {
        const traveler = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: index % 2 ? 0x8ce5c2 : 0xffffff, transparent: true, opacity: 0.9 }));
        traveler.userData = { curve, phase: index * 0.9, speed: 0.055 + index * 0.004 };
        network.add(traveler);
        travelers.push(traveler);
      }
    });

    const particleCount = window.innerWidth < 700 ? 42 : 82;
    const particlePositions = new Float32Array(particleCount * 3);
    for (let index = 0; index < particleCount; index += 1) { particlePositions[index * 3] = (Math.random() - 0.5) * 12; particlePositions[index * 3 + 1] = (Math.random() - 0.5) * 8; particlePositions[index * 3 + 2] = (Math.random() - 0.5) * 8 - 1; }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
    const particles = new THREE.Points(particleGeometry, new THREE.PointsMaterial({ color: 0x9de4ef, size: window.innerWidth < 700 ? 0.025 : 0.035, transparent: true, opacity: 0.42, depthWrite: false }));
    scene.add(particles);

    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
    let scrollTarget = 0; let scrollValue = 0; let sceneIntensity = 1; let intensityTarget = 1; let running = true; let lastTime = 0;
    window.addEventListener("pointermove", (event) => { pointer.targetX = (event.clientX / window.innerWidth - 0.5) * 0.35; pointer.targetY = (event.clientY / window.innerHeight - 0.5) * 0.22; }, { passive: true });
    window.addEventListener("scroll", () => { scrollTarget = Math.min(window.scrollY / Math.max(document.body.scrollHeight - window.innerHeight, 1), 1); }, { passive: true });
    const sectionObserver = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) intensityTarget = entry.target.id === "find-worker" ? 1.12 : entry.target.id === "services" || entry.target.id === "how-it-works" ? 1.22 : entry.target.id === "trust" ? 0.7 : entry.target.classList.contains("worker-cta") ? 1.14 : 1; }), { threshold: 0.45 });
    document.querySelectorAll("main > section").forEach((section) => sectionObserver.observe(section));
    document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) requestAnimationFrame(animate); });
    window.addEventListener("resize", () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.15 : 1.5)); renderer.setSize(window.innerWidth, window.innerHeight, false); });

    function animate(time = 0) {
      if (!running) return;
      requestAnimationFrame(animate);
      const elapsed = time * 0.001; const delta = Math.min((time - lastTime) * 0.001, 0.05); lastTime = time;
      pointer.x += (pointer.targetX - pointer.x) * 0.035; pointer.y += (pointer.targetY - pointer.y) * 0.035; scrollValue += (scrollTarget - scrollValue) * 0.025;
      const movement = reducedMotion ? 0.1 : 1; sceneIntensity += (intensityTarget - sceneIntensity) * 0.025;
      center.rotation.x += delta * 0.08 * movement; center.rotation.y += delta * 0.12 * movement; innerCore.rotation.y -= delta * 0.06 * movement; shell.rotation.y += delta * 0.035 * movement; ring.rotation.z += delta * 0.05 * movement; ringSecond.rotation.z -= delta * 0.035 * movement; center.scale.setScalar(1 + Math.sin(elapsed * 0.9) * 0.035 * movement); innerCore.scale.setScalar(1 + Math.sin(elapsed * 1.1) * 0.06 * movement);
      movingObjects.forEach((object) => { object.rotation.x += delta * 0.12 * movement * object.userData.spin; object.rotation.y += delta * 0.17 * movement * object.userData.spin; object.position.y = object.userData.baseY + Math.sin(elapsed * 0.55 + object.userData.phase) * 0.09 * movement; });
      travelers.forEach((traveler) => { const progress = (elapsed * traveler.userData.speed + traveler.userData.phase) % 1; traveler.position.copy(traveler.userData.curve.getPoint(progress)); traveler.material.opacity = (0.25 + Math.sin(progress * Math.PI) * 0.65) * movement * sceneIntensity; });
      particles.rotation.y += delta * 0.008 * movement; particles.position.y = Math.sin(elapsed * 0.15) * 0.12 * movement;
      group.rotation.y += (pointer.x * 0.22 + Math.sin(elapsed * 0.08) * 0.025 + scrollValue * 0.06 - group.rotation.y) * 0.018; group.rotation.x += (-pointer.y * 0.14 - scrollValue * 0.025 - group.rotation.x) * 0.018; network.rotation.y = group.rotation.y; network.rotation.x = group.rotation.x;
      network.children.forEach((line) => { if (line.material.opacity !== undefined && line.userData.curve) line.material.opacity = (0.14 + sceneIntensity * 0.1) * movement; });
      keyLight.intensity = 1.9 + Math.sin(elapsed * 0.7) * 0.25 * movement;
      renderer.render(scene, camera);
    }
    animate();
  }

  initWebGLBackground();
}());