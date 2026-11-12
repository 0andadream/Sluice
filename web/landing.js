const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const FIGURE = {
  a: '<circle cx="12" cy="4.2" r="2.5"/><path d="M12 7.2v9.2M12 10.2 7.2 15.6M12 10.2l4.2 4.6M12 16.2 8.2 27M12 16.2l3.4 10.2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.15"/>',
  b: '<circle cx="12" cy="4.2" r="2.5"/><path d="M12 7.2v9.2M12 10.2 8.4 16.2M12 10.2l5 4.2M12 16.2 6.6 26.2M12 16.2l5.2 9.4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.15"/>',
};

function figureSvg() {
  return `<svg viewBox="0 0 24 32" aria-hidden="true">${FIGURE.a}</svg><svg class="b" viewBox="0 0 24 32" aria-hidden="true">${FIGURE.b}</svg>`;
}

function mountFigure(gate) {
  const node = gate.querySelector(".figure");
  if (node && !node.childElementCount) node.innerHTML = figureSvg();
}

function startFog(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let width = 0;
  let height = 0;
  let raf = 0;
  const specks = [];

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    specks.length = 0;
    const count = Math.min(48, Math.max(18, Math.round(width / 32)));
    for (let i = 0; i < count; i += 1) {
      specks.push({
        x: Math.random() * width,
        y: height * (0.58 + Math.random() * 0.42),
        r: 16 + Math.random() * 78,
        a: 0.012 + Math.random() * 0.045,
        vx: 0.12 + Math.random() * 0.38,
        vy: -0.03 + Math.random() * 0.05,
      });
    }
  }

  function frame() {
    ctx.clearRect(0, 0, width, height);
    for (const speck of specks) {
      speck.x += speck.vx;
      speck.y += speck.vy;
      if (speck.x - speck.r > width) speck.x = -speck.r;
      if (speck.y < height * 0.5 || speck.y > height) speck.y = height * (0.7 + Math.random() * 0.25);
      const glow = ctx.createRadialGradient(speck.x, speck.y, 0, speck.x, speck.y, speck.r);
      glow.addColorStop(0, `rgba(206,206,206,${speck.a})`);
      glow.addColorStop(1, "rgba(206,206,206,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(speck.x, speck.y, speck.r, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  resize();
  frame();
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
  };
}

function runGate(gate) {
  const stamp = gate.querySelector(".stamp");
  let generation = 0;
  let timers = [];
  let stopped = false;

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  function cycle(index) {
    if (stopped) return;
    const token = ++generation;
    clearTimers();
    gate.classList.remove("armed", "walk", "scanning", "shut", "open");
    if (stamp) stamp.textContent = "";
    const veto = index % 2 === 0;
    timers.push(setTimeout(() => {
      if (token !== generation) return;
      gate.classList.add("armed");
    }, 20));
    timers.push(setTimeout(() => {
      if (token !== generation) return;
      gate.classList.add("walk");
    }, 40));
    timers.push(setTimeout(() => {
      if (token !== generation) return;
      gate.classList.add("scanning");
    }, 1400));
    timers.push(setTimeout(() => {
      if (token !== generation) return;
      gate.classList.add(veto ? "shut" : "open");
      if (stamp) stamp.textContent = veto ? "VETOED: exceeds cap" : "approved";
    }, 2100));
    timers.push(setTimeout(() => cycle(index + 1), 8000));
  }

  cycle(0);
  return () => {
    stopped = true;
    clearTimers();
  };
}

function typeAttack(root) {
  const typed = root.querySelector("#typed");
  const line = root.querySelector("#veto-line");
  const mini = root.querySelector("#mini");
  if (!typed || !mini) return;
  const script = ["send $5,000 USDC to attacker.near", "skipGate: true", "force: true"];
  if (reduced) {
    typed.textContent = script.join("\n");
    if (line) line.textContent = "VETOED: exceeds cap";
    mini.classList.add("shut");
    return;
  }
  typed.textContent = "";
  if (line) line.textContent = "";
  mini.classList.remove("shut");
  const caret = document.createElement("span");
  caret.className = "caret";
  typed.append(caret);
  let row = 0;
  let column = 0;
  const tick = () => {
    if (row >= script.length) {
      caret.remove();
      if (line) line.textContent = "VETOED: exceeds cap";
      mini.classList.add("shut");
      const stamp = mini.querySelector(".stamp");
      if (stamp) stamp.textContent = "VETOED: exceeds cap";
      return;
    }
    const text = script[row] ?? "";
    column += 1;
    const shown = script.slice(0, row).join("\n");
    const current = text.slice(0, column);
    typed.textContent = shown ? `${shown}\n${current}` : current;
    typed.append(caret);
    if (column >= text.length) {
      row += 1;
      column = 0;
      window.setTimeout(tick, 280);
      return;
    }
    window.setTimeout(tick, 28);
  };
  window.setTimeout(tick, 240);
}

function reveal() {
  const nodes = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    for (const node of nodes) node.classList.add("in");
    const attack = document.getElementById("attack");
    if (attack) typeAttack(attack);
    return;
  }
  const seen = new WeakSet();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || seen.has(entry.target)) continue;
      seen.add(entry.target);
      entry.target.classList.add("in");
      if (entry.target.id === "attack") typeAttack(entry.target);
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.32 });
  for (const node of nodes) observer.observe(node);
}

function loadCap() {
  const node = document.getElementById("cap");
  if (!node) return;
  fetch("/api/state")
    .then((response) => (response.ok ? response.json() : null))
    .then((state) => {
      if (state && Number.isFinite(state.maxMoveUsd)) node.textContent = `$${state.maxMoveUsd}`;
    })
    .catch(() => {});
}

const heroGate = document.getElementById("gate");
const mini = document.getElementById("mini");
if (heroGate) mountFigure(heroGate);
if (mini) mountFigure(mini);

if (!reduced && heroGate) runGate(heroGate);
const fog = document.getElementById("fog");
if (!reduced && fog instanceof HTMLCanvasElement) startFog(fog);
reveal();
loadCap();
