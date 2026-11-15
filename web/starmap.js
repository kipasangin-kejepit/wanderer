/* Wanderer starmap: a 3D map of our stellar neighbourhood (Three.js).
 * Positions come from each star's sky position and distance (approximate, for
 * navigation). Click a star to lock on; "Warp" flies there and opens the sky view.
 */
import * as THREE from "three";
import { OrbitControls } from "./vendor/three/addons/OrbitControls.js";

// name, RA°, Dec°, distance (light years), colour, kind, archive slug (if SPHEREx data is pre-built)
const STARS = [
  ["Proxima Centauri", 217.429, -62.680, 4.24, "#ff8a5c", "Red dwarf"],
  ["Alpha Centauri A+B", 219.900, -60.834, 4.37, "#fff1c4", "Sun-like double star"],
  ["Barnard's Star", 269.452, 4.693, 5.96, "#ff8a5c", "Fast-moving red dwarf", "barnard"],
  ["Luhman 16", 162.328, -53.319, 6.50, "#c06cff", "Pair of brown dwarfs"],
  ["WISE 0855-0714", 133.786, -7.244, 7.43, "#a35bff", "Coldest known brown dwarf", "wise0855"],
  ["Wolf 359", 164.120, 7.015, 7.86, "#ff8a5c", "Red dwarf"],
  ["Lalande 21185", 165.834, 35.970, 8.31, "#ff9a6a", "Red dwarf"],
  ["Sirius", 101.287, -16.716, 8.60, "#cfe4ff", "Brightest star in the night sky"],
  ["Luyten 726-8", 24.750, -17.950, 8.70, "#ff8a5c", "Pair of flare stars"],
  ["Ross 154", 282.456, -23.836, 9.70, "#ff8a5c", "Red dwarf"],
  ["Ross 248", 355.480, 44.180, 10.30, "#ff8a5c", "Red dwarf"],
  ["Epsilon Eridani", 53.233, -9.458, 10.50, "#ffd08a", "Young orange star with a planet"],
  ["Lacaille 9352", 346.467, -35.853, 10.70, "#ff9a6a", "Red dwarf"],
  ["Ross 128", 176.938, 0.800, 11.00, "#ff8a5c", "Quiet red dwarf with a planet"],
  ["EZ Aquarii", 334.000, -15.300, 11.10, "#ff8a5c", "Triple red dwarf"],
  ["Procyon", 114.825, 5.225, 11.40, "#f4f6ff", "Bright white star"],
  ["61 Cygni", 316.730, 38.750, 11.40, "#ffc77a", "First star to have its distance measured (1838)"],
  ["Struve 2398", 280.700, 59.600, 11.50, "#ff8a5c", "Red dwarf pair"],
  ["Groombridge 34", 4.600, 44.000, 11.60, "#ff8a5c", "Red dwarf pair"],
  ["DX Cancri", 127.460, 26.780, 11.70, "#ff8a5c", "Flare star"],
  ["Epsilon Indi B", 331.046, -56.782, 11.90, "#b46cff", "Pair of brown dwarfs", "epsindib"],
  ["Tau Ceti", 26.017, -15.937, 11.90, "#ffe7a8", "Sun-like star with planets"],
  ["GJ 1061", 53.990, -44.510, 12.00, "#ff8a5c", "Red dwarf with planets"],
  ["YZ Ceti", 18.130, -16.990, 12.10, "#ff8a5c", "Red dwarf with planets"],
  ["Luyten's Star", 111.850, 5.230, 12.20, "#ff8a5c", "Red dwarf with planets"],
  ["Teegarden's Star", 43.250, 16.880, 12.50, "#ff7a50", "Tiny red dwarf with planets"],
  ["Kapteyn's Star", 77.920, -45.020, 12.80, "#ff9a6a", "Ancient halo star"],
  ["Lacaille 8760", 319.310, -38.870, 12.90, "#ff9a6a", "Red dwarf"],
  ["Kruger 60", 337.000, 57.700, 13.10, "#ff8a5c", "Red dwarf pair"],
  ["Ross 614", 97.350, -2.810, 13.40, "#ff8a5c", "Red dwarf pair"],
  ["Wolf 1061", 247.580, -12.660, 14.00, "#ff8a5c", "Red dwarf with planets"],
  ["Van Maanen's Star", 12.290, 5.390, 14.10, "#e8f2ff", "White dwarf"],
  ["Gliese 1", 1.380, -37.350, 14.20, "#ff9a6a", "Red dwarf"],
];
// Targets far outside this map: drawn on the edge in their true direction.
const FAR = [
  ["RW Aurigae", 76.956, 30.401, "#ffd08a", "Variable young star, far beyond this map", "rwaur"],
  ["R Draconis", 248.167, 66.755, "#ff6a4a", "Mira variable giant, far beyond this map", "rdra"],
];

const R = Math.PI / 180;
const eqToVec = (ra, dec, d) => new THREE.Vector3(d * Math.cos(dec * R) * Math.cos(ra * R), d * Math.sin(dec * R), -d * Math.cos(dec * R) * Math.sin(ra * R));

const stage = document.getElementById("mapStage");
const labelsEl = document.getElementById("mapLabels");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x010307, 0.012);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 2000);
camera.position.set(14, 11, 22);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 2; controls.maxDistance = 70;
controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
controls.addEventListener("start", () => { controls.autoRotate = false; });

// --- textures ---
function glowTexture(inner = 0.0, ring = false) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  if (ring) {
    g.strokeStyle = "rgba(94,242,255,1)"; g.lineWidth = 5;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 3;
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) { g.beginPath(); g.moveTo(64 + Math.cos(a) * 40, 64 + Math.sin(a) * 40); g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62); g.stroke(); }
  } else {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.18 + inner, "rgba(255,255,255,.85)");
    grd.addColorStop(0.45, "rgba(255,255,255,.18)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glow = glowTexture();
const ringTex = glowTexture(0, true);

// --- background: random stars + Milky Way band ---
(() => {
  const N = 9000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  // galactic -> equatorial rotation (transpose of the IAU equatorial->galactic matrix)
  const T = [[-0.0548755604, 0.4941094279, -0.8676661490], [-0.8734370902, -0.4448296300, -0.1980763734], [-0.4838350155, 0.7469822445, 0.4559837762]];
  for (let i = 0; i < N; i++) {
    let ra, dec;
    if (i < N * 0.55) { // band
      const l = Math.random() * 2 * Math.PI, b = (Math.random() + Math.random() + Math.random() - 1.5) * 0.25;
      const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
      const e = [0, 1, 2].map((k) => T[0][k] * g[0] + T[1][k] * g[1] + T[2][k] * g[2]);
      ra = Math.atan2(e[1], e[0]) / R; dec = Math.asin(e[2]) / R;
    } else { ra = Math.random() * 360; dec = Math.asin(2 * Math.random() - 1) / R; }
    const v = eqToVec(ra, dec, 600 + Math.random() * 300);
    pos.set([v.x, v.y, v.z], i * 3);
    const w = 0.5 + Math.random() * 0.5, tint = Math.random();
    col.set(tint < 0.15 ? [w, w * 0.8, w * 0.6] : tint < 0.3 ? [w * 0.75, w * 0.85, w] : [w, w, w], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, fog: false });
  scene.add(new THREE.Points(geo, mat));
})();

// --- navigation grid on the equatorial plane ---
const gridMat = new THREE.LineBasicMaterial({ color: 0x5ef2ff, transparent: true, opacity: 0.18 });
const gridMatStrong = new THREE.LineBasicMaterial({ color: 0x5ef2ff, transparent: true, opacity: 0.35 });
for (const r of [5, 10, 15]) {
  const pts = []; for (let a = 0; a <= 128; a++) { const t = (a / 128) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(t), 0, r * Math.sin(t))); }
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), r === 15 ? gridMatStrong : gridMat));
}
for (let h = 0; h < 24; h += 2) {
  const a = h * 15 * R, p = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(16 * Math.cos(a), 0, -16 * Math.sin(a))];
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), gridMat));
}

// --- stars ---
const bodies = [];
function addBody(name, pos, color, size, info) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sp.position.copy(pos); sp.scale.setScalar(size); scene.add(sp);
  // drop line to the grid plane (classic nav-map look)
  if (Math.abs(pos.y) > 0.05) {
    const g = new THREE.BufferGeometry().setFromPoints([pos.clone(), new THREE.Vector3(pos.x, 0, pos.z)]);
    const drop = new THREE.Line(g, new THREE.LineDashedMaterial({ color: info.slug ? 0x5ef2ff : 0x6f8fa0, dashSize: 0.25, gapSize: 0.2, transparent: true, opacity: info.slug ? 0.6 : 0.3 }));
    drop.computeLineDistances(); scene.add(drop);
    const foot = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.17, 24), new THREE.MeshBasicMaterial({ color: 0x5ef2ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    foot.rotation.x = -Math.PI / 2; foot.position.set(pos.x, 0, pos.z); scene.add(foot);
  }
  const label = document.createElement("div");
  label.className = "star-label" + (info.slug ? " target" : "") + (info.sol ? " sol" : "");
  label.textContent = name;
  labelsEl.appendChild(label);
  const b = { name, pos, sprite: sp, label, size, ...info };
  bodies.push(b);
  return b;
}
addBody("SOL · you are here", new THREE.Vector3(0, 0, 0), "#ffd27a", 1.6, { sol: true, kind: "Our Sun", dist: 0, ra: null, dec: null });
for (const [name, ra, dec, d, color, kind, slug] of STARS) addBody(name, eqToVec(ra, dec, d), color, slug ? 1.25 : (kind.includes("dwarf") && !kind.includes("Red") ? 0.8 : 1.0), { kind, ra, dec, dist: d, slug });
for (const [name, ra, dec, color, kind, slug] of FAR) addBody(`${name} ›`, eqToVec(ra, dec, 17.5), color, 1.1, { kind, ra, dec, dist: null, slug, far: true });

// Unknown signals (easter eggs): pulsing magenta blips in the direction of famous "alien" spots.
const signals = [];
for (const sp of (window.FX && window.FX.spots ? window.FX.spots() : [])) {
  const dist = sp.id === "proxima" ? 4.6 : 16.5;
  const pos = eqToVec(sp.ra, sp.dec, dist);
  const blip = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color("#ff4fd8"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  blip.position.copy(pos); blip.scale.setScalar(0.9); scene.add(blip);
  if (!sp.found) blip.material.opacity = 0.4; // faint until discovered
  const label = document.createElement("div");
  label.className = "star-label signal"; label.textContent = sp.found ? `◈ ${sp.title.split(":").pop().trim()}` : "◈ ?";
  labelsEl.appendChild(label);
  const b = { name: label.textContent.replace("◈ ", ""), pos, sprite: blip, label, size: 0.9, signal: true, spot: sp, ra: sp.ra, dec: sp.dec, kind: "Unidentified transmission" };
  bodies.push(b); signals.push(b);
}

// selection reticle
const reticle = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthWrite: false, depthTest: false }));
reticle.visible = false; scene.add(reticle);
let selected = null, hovered = null;

// --- picking (screen-space, forgiving for small sprites) ---
const tmp = new THREE.Vector3();
function screenPos(p) { tmp.copy(p).project(camera); return { x: (tmp.x * 0.5 + 0.5) * innerWidth, y: (-tmp.y * 0.5 + 0.5) * innerHeight, behind: tmp.z > 1 }; }
function pick(x, y) {
  let best = null, bd = 26;
  for (const b of bodies) { const s = screenPos(b.pos); if (s.behind) continue; const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = b; } }
  return best;
}
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
  down = null;
  const b = pick(e.clientX, e.clientY);
  if (b) select(b);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  const b = pick(e.clientX, e.clientY);
  if (hovered && hovered !== b) hovered.label.classList.remove("hover");
  hovered = b; if (b) b.label.classList.add("hover");
  renderer.domElement.style.cursor = b ? "pointer" : "grab";
});

function select(b) {
  selected = b; controls.autoRotate = false;
  reticle.visible = true; reticle.position.copy(b.pos);
  window.dispatchEvent(new CustomEvent("wanderer:mapselect", { detail: {
    name: b.name.replace(/ ›$/, "").replace(" · you are here", ""), ra: b.ra, dec: b.dec, dist: b.signal ? null : b.dist, kind: b.kind, slug: b.slug || null,
    sol: !!b.sol, far: !!b.far || !!b.signal, signal: !!b.signal,
  } }));
}

// --- warp: fly the camera to the star, flash, then hand over to the sky view ---
let flight = null;
function warpTo(name) {
  const b = bodies.find((x) => x.name.replace(/ ›$/, "") === name) || selected;
  if (!b) return Promise.resolve();
  const from = camera.position.clone(), tFrom = controls.target.clone();
  const dir = b.pos.clone().sub(from).normalize();
  const to = b.pos.clone().sub(dir.multiplyScalar(0.6));
  const flash = document.createElement("div");
  flash.style.cssText = "position:fixed;inset:0;background:#dffcff;opacity:0;pointer-events:none;z-index:30;transition:opacity .35s";
  document.body.appendChild(flash);
  return new Promise((resolve) => {
    flight = { t0: performance.now(), dur: 1700, from, to, tFrom, tTo: b.pos.clone(), done: () => {
      flash.style.opacity = "1";
      setTimeout(() => { resolve(); flash.style.opacity = "0"; setTimeout(() => flash.remove(), 400); camera.fov = 50; camera.updateProjectionMatrix(); camera.position.set(14, 11, 22); controls.target.set(0, 0, 0); }, 380);
    } };
  });
}

// --- render loop (only while the starmap is visible) ---
function frame(now) {
  requestAnimationFrame(frame);
  if (!document.body.classList.contains("mode-map")) return;
  if (flight) {
    const t = Math.min(1, (now - flight.t0) / flight.dur), e = t * t * (3 - 2 * t);
    camera.position.lerpVectors(flight.from, flight.to, e);
    controls.target.lerpVectors(flight.tFrom, flight.tTo, Math.min(1, e * 1.6));
    camera.fov = 50 + Math.sin(t * Math.PI) * 45; camera.updateProjectionMatrix();
    if (t >= 1) { const d = flight.done; flight = null; d(); }
  }
  controls.update();
  const pulse = 1 + Math.sin(now / 300) * 0.12;
  for (const s of signals) s.sprite.scale.setScalar(s.spot.found ? 0.7 + 0.5 * (0.5 + 0.5 * Math.sin(now / 260 + s.ra)) : 0.45 + 0.12 * Math.sin(now / 700 + s.ra));
  if (reticle.visible && selected) reticle.scale.setScalar(selected.size * 1.6 * pulse);
  for (const b of bodies) {
    const s = screenPos(b.pos);
    const near = camera.position.distanceTo(b.pos);
    const show = !s.behind && s.x > -50 && s.x < innerWidth + 50 && s.y > -20 && s.y < innerHeight + 20 && (b.slug || b.sol || (b.signal && b.spot.found) || near < 26 || b === hovered || b === selected);
    b.label.style.display = show ? "block" : "none";
    if (show) b.label.style.left = `${s.x}px`, b.label.style.top = `${s.y}px`;
    if (!b.signal) b.sprite.scale.setScalar(b.size * (b === hovered ? 1.35 : 1));
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

window.Starmap = { warpTo, select: (name) => { const b = bodies.find((x) => x.name.startsWith(name)); if (b) select(b); } };
window.dispatchEvent(new Event("wanderer:starmap-ready"));
