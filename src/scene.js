import * as THREE from 'three';
import { gsap } from 'gsap';
import {
  LUDO_COLORS,
  OUTER_PATH,
  STAR_ONLY_INDICES,
  HOME_STRETCH,
  HOME_YARDS,
  TILE_SIZE,
  gridToWorld,
} from './boardData.js';

function createStarTileTexture(bgHex, borderHex = '#38bdf8') {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');

  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = borderHex;
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, 240, 240);

  // Draw crisp 5-point Star shield
  ctx.save();
  ctx.translate(128, 128);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 74 : 34;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function createDiceFaceTexture(value) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');

  // Glossy ivory-white dice face with subtle bevel border
  const grad = ctx.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#e2e8f0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, 244, 244);

  const pipColor = value === 6 ? '#ef233c' : value === 1 ? '#2563eb' : '#0f172a';
  const pips = {
    1: [[128, 128]],
    2: [[72, 72], [184, 184]],
    3: [[72, 72], [128, 128], [184, 184]],
    4: [[72, 72], [184, 72], [72, 184], [184, 184]],
    5: [[72, 72], [184, 72], [128, 128], [72, 184], [184, 184]],
    6: [[72, 64], [184, 64], [72, 128], [184, 128], [72, 192], [184, 192]],
  };

  ctx.fillStyle = pipColor;
  (pips[value] || []).forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, value === 1 ? 30 : 21, 0, Math.PI * 2);
    ctx.fill();
  });

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

// Target Euler rotations for BoxGeometry(+x:1, -x:6, +y:2, -y:5, +z:3, -z:4) so face N points UP (+Y)
const DICE_FACE_ROTATIONS = {
  1: { x: 0, z: Math.PI / 2 },
  2: { x: 0, z: 0 },
  3: { x: -Math.PI / 2, z: 0 },
  4: { x: Math.PI / 2, z: 0 },
  5: { x: Math.PI, z: 0 },
  6: { x: 0, z: -Math.PI / 2 },
};

export class Ludo3DArena {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(
      44,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    this.baseCamPos = new THREE.Vector3(0, 12.6, 8.8);
    this.baseLookAt = new THREE.Vector3(0, 0, 0.25);
    this.currentLookAt = this.baseLookAt.clone();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // LinearToneMapping keeps neon arcade colors 100% vivid and punchy without filmic desaturation
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.clock = new THREE.Clock();
    this.particles = [];
    this.pawns = [[], [], [], []]; // seat -> 4 pawn groups
    this.highlightedPawns = new Set();
    this.previewMarkers = [];

    this._setupLights();
    this._setupBoard();
    this._setup3DDice();
    this._setupAllPawns();
    this._updateCameraForAspect();

    window.addEventListener('resize', () => this._onResize());
  }

  _setupLights() {
    // Bright Hemisphere + zero-decay Directional lighting so colors stay ultra-vibrant like the mockup!
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3b82f6, 1.55));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.25);
    keyLight.position.set(3, 18, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.left = -10;
    keyLight.shadow.camera.right = 10;
    keyLight.shadow.camera.top = 10;
    keyLight.shadow.camera.bottom = -10;
    keyLight.shadow.bias = -0.0005;
    this.scene.add(keyLight);

    this.turnLight = new THREE.PointLight(0xff1744, 6, 12, 1.2);
    this.turnLight.position.set(-3, 3.2, 3);
    this.scene.add(this.turnLight);

    const rim = new THREE.DirectionalLight(0x38bdf8, 1.35);
    rim.position.set(-8, 7, -8);
    this.scene.add(rim);
  }

  _setupBoard() {
    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);

    const boardSpan = 15 * TILE_SIZE + 0.5;

    // Giant glowing circular neon arena stage underneath the 3D Ludo board (matching right-panel mockup!)
    const stageDiscGeo = new THREE.CylinderGeometry(7.2, 7.6, 0.22, 72);
    const stageDiscMat = new THREE.MeshStandardMaterial({
      color: 0x070d24,
      roughness: 0.22,
      metalness: 0.65,
    });
    const stageDisc = new THREE.Mesh(stageDiscGeo, stageDiscMat);
    stageDisc.position.y = -0.42;
    stageDisc.receiveShadow = true;
    this.boardGroup.add(stageDisc);

    // Concentric glowing electric-blue, magenta, and orange-gold neon floor rings
    const floorRings = [
      { radius: 5.85, tube: 0.07, color: 0x3b82f6, y: -0.29 },
      { radius: 6.55, tube: 0.05, color: 0x8b5cf6, y: -0.29 },
      { radius: 7.25, tube: 0.04, color: 0xf97316, y: -0.28 },
    ];
    floorRings.forEach((fr) => {
      const rGeo = new THREE.TorusGeometry(fr.radius, fr.tube, 16, 84);
      const rMat = new THREE.MeshStandardMaterial({
        color: fr.color,
        emissive: fr.color,
        emissiveIntensity: 2.0,
        roughness: 0.15,
      });
      const rMesh = new THREE.Mesh(rGeo, rMat);
      rMesh.rotation.x = Math.PI / 2;
      rMesh.position.y = fr.y;
      this.boardGroup.add(rMesh);
    });

    // Thick beveled obsidian slab base
    const baseGeo = new THREE.BoxGeometry(boardSpan + 0.3, 0.34, boardSpan + 0.3);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x0b1430,
      roughness: 0.22,
      metalness: 0.6,
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = -0.17;
    baseMesh.receiveShadow = true;
    this.boardGroup.add(baseMesh);

    // Crisp luminous white-cyan perimeter board trim
    const frameGeo = new THREE.BoxGeometry(boardSpan + 0.42, 0.08, boardSpan + 0.42);
    // Glows through the gaps between tiles: the neon grid lines of the mockup
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x172554,
      emissive: 0x2563eb,
      emissiveIntensity: 0.75,
      roughness: 0.15,
    });
    const frameMesh = new THREE.Mesh(frameGeo, frameMat);
    frameMesh.position.y = -0.02;
    this.boardGroup.add(frameMesh);

    const tileGeo = new THREE.BoxGeometry(TILE_SIZE * 0.93, 0.085, TILE_SIZE * 0.93);
    const edgeTileMat = new THREE.MeshStandardMaterial({
      color: 0x101d52,
      emissive: 0x0b1640,
      emissiveIntensity: 0.4,
      roughness: 0.18,
      metalness: 0.0,
    });
    const innerTileMat = new THREE.MeshStandardMaterial({
      color: 0x0c1744,
      emissive: 0x081133,
      emissiveIntensity: 0.35,
      roughness: 0.22,
      metalness: 0.05,
    });
    const starTex = createStarTileTexture('#101d52', '#f8fafc');
    const starMat = new THREE.MeshStandardMaterial({
      map: starTex,
      roughness: 0.22,
      metalness: 0.2,
    });

    // 52 Outer Path tiles (outer perimeter tiles glossy ice-white, inner corridor dark navy like mockup)
    OUTER_PATH.forEach(([r, c], idx) => {
      const startColor = LUDO_COLORS.find((lc) => lc.startIndex === idx);
      const isOuterEdge = r === 0 || r === 14 || c === 0 || c === 14;
      let mat = isOuterEdge ? edgeTileMat : innerTileMat;
      if (startColor) {
        mat = new THREE.MeshStandardMaterial({
          map: createStarTileTexture(startColor.hex, '#ffffff'),
          roughness: 0.2,
        });
      } else if (STAR_ONLY_INDICES.has(idx)) {
        mat = starMat;
      }
      const tile = new THREE.Mesh(tileGeo, mat);
      const pos = gridToWorld(r, c);
      tile.position.set(pos.x, 0.035, pos.z);
      tile.receiveShadow = true;
      this.boardGroup.add(tile);
    });

    // 4 Colored Home-Stretch Columns (vivid neon glossy tiles matching mockup)
    LUDO_COLORS.forEach((lc) => {
      const stretchMat = new THREE.MeshStandardMaterial({
        color: lc.three,
        emissive: lc.three,
        emissiveIntensity: 0.62,
        roughness: 0.18,
        metalness: 0.0,
      });
      HOME_STRETCH[lc.id].forEach(([r, c]) => {
        const tile = new THREE.Mesh(tileGeo, stretchMat);
        const pos = gridToWorld(r, c);
        tile.position.set(pos.x, 0.035, pos.z);
        tile.receiveShadow = true;
        this.boardGroup.add(tile);
      });
    });

    // 4 Colored 6x6 Home Yards with 4 Glowing Token Pads each
    const yardCoords = [
      { seat: 0, centerR: 11.5, centerC: 2.5 }, // Red Bottom-Left
      { seat: 1, centerR: 2.5, centerC: 2.5 }, // Green Top-Left
      { seat: 2, centerR: 2.5, centerC: 11.5 }, // Yellow Top-Right
      { seat: 3, centerR: 11.5, centerC: 11.5 }, // Blue Bottom-Right
    ];

    const yardSpan = 6 * TILE_SIZE - 0.06;
    const yardGeo = new THREE.BoxGeometry(yardSpan, 0.14, yardSpan);
    const padGeo = new THREE.CylinderGeometry(0.27, 0.3, 0.065, 32);

    const wellTints = [0x080306, 0x030806, 0x080702, 0x030510]; // near-black wells

    yardCoords.forEach(({ seat, centerR, centerC }) => {
      const lc = LUDO_COLORS[seat];
      const yardMat = new THREE.MeshStandardMaterial({
        color: lc.three,
        roughness: 0.18,
        metalness: 0.0,
        emissive: lc.three,
        emissiveIntensity: 0.65,
      });
      const yard = new THREE.Mesh(yardGeo, yardMat);
      const pos = gridToWorld(centerR, centerC);
      yard.position.set(pos.x, 0.055, pos.z);
      yard.receiveShadow = true;
      this.boardGroup.add(yard);

      // Deep color-tinted glossy well inside the vivid colored yard frame (matching mockup)
      const innerGeo = new THREE.BoxGeometry(yardSpan * 0.8, 0.04, yardSpan * 0.8);
      const innerMat = new THREE.MeshStandardMaterial({
        color: wellTints[seat],
        emissive: lc.three,
        emissiveIntensity: 0.04,
        roughness: 0.18,
        metalness: 0.05,
      });
      const inner = new THREE.Mesh(innerGeo, innerMat);
      inner.position.set(pos.x, 0.115, pos.z);
      inner.receiveShadow = true;
      this.boardGroup.add(inner);

      // 4 Crisp glossy white circular token pads
      const padMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.18,
        roughness: 0.16,
      });
      HOME_YARDS[seat].forEach(([pr, pc]) => {
        const pPos = gridToWorld(pr, pc);
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.position.set(pPos.x, 0.128, pPos.z);
        pad.receiveShadow = true;
        this.boardGroup.add(pad);
      });
    });

    // Center 3x3 Glowing Crown Home Arena
    const centerSpan = 3 * TILE_SIZE - 0.06;
    const centerGeo = new THREE.BoxGeometry(centerSpan, 0.11, centerSpan);
    const centerMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.2,
      metalness: 0.65,
    });
    const centerBase = new THREE.Mesh(centerGeo, centerMat);
    centerBase.position.set(0, 0.045, 0);
    centerBase.receiveShadow = true;
    this.boardGroup.add(centerBase);

    // 4 colored triangular wedges + golden crown ring in center
    const crownRingGeo = new THREE.TorusGeometry(0.66, 0.045, 16, 48);
    const crownRingMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0xfacc15,
      emissiveIntensity: 1.2,
      roughness: 0.2,
      metalness: 0.85,
    });
    this.centerRing = new THREE.Mesh(crownRingGeo, crownRingMat);
    this.centerRing.rotation.x = Math.PI / 2;
    this.centerRing.position.set(0, 0.12, 0);
    this.boardGroup.add(this.centerRing);
  }

  _setup3DDice() {
    const diceGeo = new THREE.BoxGeometry(0.76, 0.76, 0.76);
    // BoxGeometry face order: +x (1), -x (6), +y (2), -y (5), +z (3), -z (4)
    const faceOrder = [1, 6, 2, 5, 3, 4];
    const materials = faceOrder.map(
      (num) =>
        new THREE.MeshStandardMaterial({
          map: createDiceFaceTexture(num),
          roughness: 0.18,
          metalness: 0.08,
        })
    );
    this.diceMesh = new THREE.Mesh(diceGeo, materials);
    this.diceMesh.position.set(0, 0.5, 0);
    this.diceMesh.castShadow = true;
    this.diceMesh.receiveShadow = true;
    this.diceMesh.userData.isDice = true;
    this.scene.add(this.diceMesh);
  }

  _createPawnMesh(seat, pawnIndex) {
    const lc = LUDO_COLORS[seat];
    const group = new THREE.Group();

    // Metallic chrome base ring
    const baseGeo = new THREE.CylinderGeometry(0.19, 0.22, 0.08, 24);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.2,
      metalness: 0.8,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.04;
    base.castShadow = true;
    group.add(base);

    // Glossy tapered vivid body (zero dark metallic reflection)
    const bodyGeo = new THREE.ConeGeometry(0.185, 0.46, 28);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: lc.three,
      roughness: 0.15,
      metalness: 0.0,
      emissive: lc.three,
      emissiveIntensity: 0.55,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.28;
    body.castShadow = true;
    group.add(body);

    // Glossy spherical head
    const headGeo = new THREE.SphereGeometry(0.145, 24, 24);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.y = 0.54;
    head.castShadow = true;
    group.add(head);

    // Movable pulsing halo ring under the pawn
    const haloGeo = new THREE.RingGeometry(0.24, 0.34, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.02;
    group.add(halo);

    group.userData = {
      isPawn: true,
      seat,
      pawnIndex,
      haloMat,
      bodyMat,
    };

    // Tag child meshes so raycasting hits return the pawn identity
    group.traverse((obj) => {
      obj.userData.pawnGroup = group;
    });

    this.scene.add(group);
    return group;
  }

  _setupAllPawns() {
    for (let seat = 0; seat < 4; seat++) {
      this.pawns[seat] = [];
      for (let i = 0; i < 4; i++) {
        const pawn = this._createPawnMesh(seat, i);
        const [r, c] = HOME_YARDS[seat][i];
        const pos = gridToWorld(r, c);
        pawn.position.set(pos.x, 0.14, pos.z);
        this.pawns[seat].push(pawn);
      }
    }
  }

  setSeatVisibility(seat, visible) {
    (this.pawns[seat] || []).forEach((p) => {
      p.visible = visible;
    });
  }

  setTurnSpotlight(seat) {
    const lc = LUDO_COLORS[seat] || LUDO_COLORS[0];
    const yardLightPos = [
      { x: -3.2, z: 3.2 },
      { x: -3.2, z: -3.2 },
      { x: 3.2, z: -3.2 },
      { x: 3.2, z: 3.2 },
    ][seat] || { x: 0, z: 0 };

    const col = new THREE.Color(lc.three);
    gsap.to(this.turnLight.color, { r: col.r, g: col.g, b: col.b, duration: 0.4 });
    gsap.to(this.turnLight.position, {
      x: yardLightPos.x,
      z: yardLightPos.z,
      duration: 0.5,
      ease: 'power2.out',
    });
  }

  animateDiceRoll(finalValue) {
    const targetRot = DICE_FACE_ROTATIONS[finalValue] || DICE_FACE_ROTATIONS[1];
    gsap.killTweensOf(this.diceMesh.position);
    gsap.killTweensOf(this.diceMesh.rotation);

    return new Promise((resolve) => {
      const tl = gsap.timeline({ onComplete: resolve });
      // Launch up and spin wildly in 3D
      tl.to(
        this.diceMesh.position,
        { y: 2.85, duration: 0.28, ease: 'power2.out' },
        0
      )
        .to(
          this.diceMesh.position,
          { y: 0.5, duration: 0.38, ease: 'bounce.out' },
          0.28
        )
        .to(
          this.diceMesh.rotation,
          {
            x: targetRot.x + Math.PI * 4,
            y: Math.PI * 2,
            z: targetRot.z + Math.PI * 4,
            duration: 0.64,
            ease: 'power3.out',
          },
          0
        )
        .set(this.diceMesh.rotation, {
          x: targetRot.x,
          y: 0,
          z: targetRot.z,
        });
    });
  }

  clearLandingPreviews() {
    this.previewMarkers.forEach((m) => {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this.previewMarkers = [];
  }

  showLandingPreviews(targets) {
    this.clearLandingPreviews();
    targets.forEach(({ x, z, isCapture, colorThree }) => {
      const ringColor = isCapture ? 0xff2a55 : colorThree || 0x38bdf8;
      const geo = new THREE.RingGeometry(0.18, 0.3, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: ringColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.11, z);
      mesh.userData.isCapturePreview = isCapture;
      this.scene.add(mesh);
      this.previewMarkers.push(mesh);
    });
  }

  triggerSafeShieldDome(x, z) {
    const domeGeo = new THREE.SphereGeometry(0.46, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.58,
      side: THREE.DoubleSide,
      roughness: 0.1,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.position.set(x, 0.08, z);
    dome.scale.set(0.2, 0.2, 0.2);
    this.scene.add(dome);

    gsap.to(dome.scale, { x: 1.15, y: 1.15, z: 1.15, duration: 0.35, ease: 'back.out(1.6)' });
    gsap.to(domeMat, {
      opacity: 0,
      duration: 0.7,
      delay: 0.25,
      onComplete: () => {
        this.scene.remove(dome);
        domeGeo.dispose();
        domeMat.dispose();
      },
    });
  }

  spawnHopTrailSpark(x, z, colorThree) {
    const geo = new THREE.OctahedronGeometry(0.055, 0);
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i === 0 ? 0xffffff : colorThree,
        transparent: true,
        opacity: 0.9,
      });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x + (Math.random() - 0.5) * 0.18, 0.14, z + (Math.random() - 0.5) * 0.18);
      p.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 1.1,
        1.4 + Math.random() * 1.2,
        (Math.random() - 0.5) * 1.1
      );
      p.userData.life = 0.65;
      this.scene.add(p);
      this.particles.push(p);
    }
  }

  triggerHomeFireworks(colorThree) {
    const colors = [colorThree, 0xfacc15, 0x38bdf8, 0xf472b6];
    colors.forEach((col, idx) => {
      setTimeout(() => {
        this.triggerBurst(
          (Math.random() - 0.5) * 1.2,
          (Math.random() - 0.5) * 1.2,
          col,
          1.35
        );
      }, idx * 140);
    });
  }

  cinematicSwoopTo(x, z, holdSec = 0.55) {
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.currentLookAt);
    const origPos = this.baseCamPos.clone();
    const origLook = this.baseLookAt.clone();

    const tl = gsap.timeline();
    tl.to(
      this.camera.position,
      {
        x: x * 0.55,
        y: Math.max(6.8, origPos.y * 0.62),
        z: z * 0.55 + 4.8,
        duration: 0.34,
        ease: 'power2.out',
      },
      0
    )
      .to(
        this.currentLookAt,
        { x, y: 0.25, z, duration: 0.34, ease: 'power2.out' },
        0
      )
      .to(
        this.camera.position,
        {
          x: origPos.x,
          y: origPos.y,
          z: origPos.z,
          duration: 0.55,
          ease: 'power3.inOut',
        },
        0.34 + holdSec
      )
      .to(
        this.currentLookAt,
        {
          x: origLook.x,
          y: origLook.y,
          z: origLook.z,
          duration: 0.55,
          ease: 'power3.inOut',
        },
        0.34 + holdSec
      );
  }

  setMovablePawns(seat, movableIndices) {
    this.highlightedPawns.clear();
    for (let s = 0; s < 4; s++) {
      this.pawns[s].forEach((p, idx) => {
        const isMovable = s === seat && movableIndices.includes(idx);
        p.userData.haloMat.opacity = isMovable ? 0.95 : 0;
        if (isMovable) {
          this.highlightedPawns.add(p);
        } else {
          gsap.to(p.scale, { x: 1, y: 1, z: 1, duration: 0.2 });
        }
      });
    }
  }

  hopPawnToWorld(pawn, targetX, targetZ, baseY = 0.08, duration = 0.2) {
    const startX = pawn.position.x;
    const startZ = pawn.position.z;
    const startY = pawn.position.y;
    const proxy = { t: 0 };

    return new Promise((resolve) => {
      gsap.to(proxy, {
        t: 1,
        duration,
        ease: 'power1.inOut',
        onUpdate: () => {
          const t = proxy.t;
          pawn.position.x = startX + (targetX - startX) * t;
          pawn.position.z = startZ + (targetZ - startZ) * t;
          pawn.position.y =
            startY + (baseY - startY) * t + Math.sin(t * Math.PI) * 0.62;
        },
        onComplete: resolve,
      });
    });
  }

  triggerBurst(x, z, colorThree, power = 1) {
    // 3D Shockwave ring
    const waveGeo = new THREE.RingGeometry(0.18, 0.36, 36);
    const waveMat = new THREE.MeshBasicMaterial({
      color: colorThree,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    const wave = new THREE.Mesh(waveGeo, waveMat);
    wave.rotation.x = -Math.PI / 2;
    wave.position.set(x, 0.14, z);
    this.scene.add(wave);

    gsap.to(wave.scale, {
      x: 4.5 * power,
      y: 4.5 * power,
      z: 4.5 * power,
      duration: 0.55,
      ease: 'power2.out',
    });
    gsap.to(waveMat, {
      opacity: 0,
      duration: 0.55,
      onComplete: () => {
        this.scene.remove(wave);
        waveGeo.dispose();
        waveMat.dispose();
      },
    });

    // 3D Particle sparks
    const count = Math.floor(28 * power);
    const geo = new THREE.OctahedronGeometry(0.08, 0);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xffffff : colorThree,
        transparent: true,
        opacity: 1,
      });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, 0.25, z);
      const a = Math.random() * Math.PI * 2;
      const spd = (1.8 + Math.random() * 3.8) * power;
      p.userData.vel = new THREE.Vector3(
        Math.cos(a) * spd,
        2.8 + Math.random() * 3.5 * power,
        Math.sin(a) * spd
      );
      p.userData.life = 1;
      this.scene.add(p);
      this.particles.push(p);
    }
  }

  cameraShake(intensity = 1) {
    gsap.killTweensOf(this.camera.position);
    const orig = this.baseCamPos.clone();
    gsap
      .timeline()
      .to(this.camera.position, {
        x: orig.x + (Math.random() - 0.5) * 0.45 * intensity,
        y: orig.y - 0.45 * intensity,
        z: orig.z - 0.45 * intensity,
        duration: 0.12,
      })
      .to(this.camera.position, {
        x: orig.x,
        y: orig.y,
        z: orig.z,
        duration: 0.45,
        ease: 'elastic.out(1, 0.35)',
      });
  }

  pickInteractive(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targets = [this.diceMesh, ...this.pawns.flat()];
    const hits = this.raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;

    const hitObj = hits[0].object;
    if (hitObj.userData.isDice) return { type: 'dice' };
    if (hitObj.userData.pawnGroup) {
      const g = hitObj.userData.pawnGroup;
      return {
        type: 'pawn',
        seat: g.userData.seat,
        pawnIndex: g.userData.pawnIndex,
      };
    }
    return null;
  }

  /**
   * Frames the whole board on any screen: picks a viewing angle for the screen
   * shape, then finds the closest camera distance at which every board corner
   * (and the pawns at the back) is on screen, clear of the top bar and the
   * bottom controls.
   */
  _updateCameraForAspect() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    this.camera.aspect = aspect;

    // Steeper (more top-down) on tall phones so the square board uses the width.
    const elevationDeg = aspect < 0.8 ? 64 : aspect < 1.2 ? 58 : 52;
    this.camera.fov = aspect < 0.8 ? 46 : 42;
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));

    // Space taken by the HUD, in pixels (bigger bottom dock on phones).
    const topPx = h < 500 ? 52 : 74;
    const bottomPx = h < 500 ? 86 : w <= 640 ? 176 : 124;
    const yMax = 1 - (2 * topPx) / h;
    const yMin = -1 + (2 * bottomPx) / h;
    const xMax = 0.97;

    const half = 15 * TILE_SIZE * 0.5 + 0.35;
    const pts = [
      [-half, 0, -half], [half, 0, -half], [-half, 0, half], [half, 0, half],
      [-half, 0.75, -half], [half, 0.75, -half],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));

    // Aim at the middle of the free area between the top bar and the dock.
    const target = new THREE.Vector3(0, 0, 0);
    const fits = (d) => {
      this.camera.position.copy(target).addScaledVector(dir, d);
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      let top = -Infinity;
      let bottom = Infinity;
      let ok = true;
      for (const p of pts) {
        const v = p.clone().project(this.camera);
        if (Math.abs(v.x) > xMax) ok = false;
        top = Math.max(top, v.y);
        bottom = Math.min(bottom, v.y);
      }
      return { ok: ok && top - bottom <= yMax - yMin, top, bottom };
    };

    let lo = 4;
    let hi = 80;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid).ok) hi = mid;
      else lo = mid;
    }
    // Shift the view so the board sits centred in the free area.
    const { top, bottom } = fits(hi);
    const shiftNdc = (yMax + yMin) / 2 - (top + bottom) / 2;
    const worldPerNdc = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * hi;
    const up = new THREE.Vector3(0, Math.cos(el), -Math.sin(el)); // camera "up" on the ground plane
    target.addScaledVector(up, -shiftNdc * worldPerNdc / Math.max(up.length(), 1e-6));
    target.y = 0;

    this.baseLookAt.copy(target);
    this.currentLookAt.copy(target);
    this.baseCamPos.copy(target).addScaledVector(dir, hi);
    this.camera.position.copy(this.baseCamPos);
    this.camera.lookAt(this.currentLookAt);
    this.camera.updateProjectionMatrix();
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this._updateCameraForAspect();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  startRenderLoop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const elapsed = this.clock.getElapsedTime();

      this.centerRing.rotation.z = elapsed * 0.85;

      // Pulse movable pawns smoothly
      this.highlightedPawns.forEach((p) => {
        const s = 1.08 + Math.sin(elapsed * 7) * 0.1;
        p.scale.set(s, s, s);
      });

      // Pulse glowing 3D landing & capture preview markers
      this.previewMarkers.forEach((m) => {
        const pulse = m.userData.isCapturePreview
          ? 1.05 + Math.sin(elapsed * 10) * 0.22
          : 1.0 + Math.sin(elapsed * 5.5) * 0.14;
        m.scale.set(pulse, pulse, pulse);
      });

      // Update 3D particles
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.userData.vel.y -= 13 * dt;
        p.position.addScaledVector(p.userData.vel, dt);
        if (p.position.y < 0.1) {
          p.position.y = 0.1;
          p.userData.vel.y *= -0.5;
        }
        p.rotation.x += 6 * dt;
        p.rotation.y += 5 * dt;
        p.userData.life -= 1.5 * dt;
        p.material.opacity = Math.max(0, p.userData.life);
        if (p.userData.life <= 0) {
          this.scene.remove(p);
          p.material.dispose();
          this.particles.splice(i, 1);
        }
      }

      this.camera.lookAt(this.currentLookAt);
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }
}
