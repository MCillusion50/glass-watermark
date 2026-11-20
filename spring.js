// 真正的弹簧求解器：位置/速度积分，不是 CSS 缓动曲线
// 对应 Compose 里的 spring(stiffness, dampingRatio)，按下会过冲再稳定

const STIFFNESS = 460;
const DAMPING = 15;

function createSpring(from, to) {
  return { x: from, v: 0, target: to };
}

export function attachSpringPress(root = document) {
  const items = new Map();
  let raf = 0;
  let last = 0;

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function tick(now) {
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
    last = now;
    let alive = false;

    for (const [el, st] of items) {
      // 两个轴分开求，按下时横向压得更多，松手才会“弹”出来
      for (const axis of ['sx', 'sy']) {
        const s = st[axis];
        const a = -STIFFNESS * (s.x - s.target) - DAMPING * s.v;
        s.v += a * dt;
        s.x += s.v * dt;
      }
      el.style.transform = `scale(${st.sx.x.toFixed(4)}, ${st.sy.x.toFixed(4)})`;

      const settled = Math.abs(st.sx.x - st.sx.target) < 0.0015 && Math.abs(st.sx.v) < 0.02 &&
        Math.abs(st.sy.x - st.sy.target) < 0.0015 && Math.abs(st.sy.v) < 0.02;

      if (settled) {
        if (st.sx.target === 1 && st.sy.target === 1) {
          el.style.transform = '';
          items.delete(el);
        } else {
          st.sx.x = st.sx.target; st.sx.v = 0;
          st.sy.x = st.sy.target; st.sy.v = 0;
        }
      } else {
        alive = true;
      }
    }

    if (alive || items.size) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
    }
  }

  function ensure(el) {
    let st = items.get(el);
    if (!st) {
      st = {
        sx: createSpring(1, 1),
        sy: createSpring(1, 1),
      };
      items.set(el, st);
    }
    return st;
  }

  function setTarget(el, x, y) {
    const st = ensure(el);
    if (reduce) {
      el.style.transform = x === 1 ? '' : `scale(${x}, ${y})`;
      return;
    }
    st.sx.target = x;
    st.sy.target = y;
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function highlight(el, ev) {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--hx', `${((ev.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--hy', `${((ev.clientY - r.top) / r.height) * 100}%`);
  }

  const selector = 'button, .pill, .lens, .model-item, .ghost, .primary, .tool, .ball, .x';

  root.querySelectorAll(selector).forEach((el) => {
    if (el.dataset.springBound) return;
    el.dataset.springBound = '1';
    el.classList.add('springable');

    el.addEventListener('pointerdown', (ev) => {
      highlight(el, ev);
      el.classList.add('is-pressed');
      setTarget(el, 0.955, 0.90);
    });
    el.addEventListener('pointermove', (ev) => {
      if (el.classList.contains('is-pressed')) highlight(el, ev);
    });

    const release = () => {
      el.classList.remove('is-pressed');
      setTarget(el, 1, 1);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  });
}
