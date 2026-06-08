/* =========================================================================
   course-ai · 学习工作台（自适应）— 应用逻辑
   ========================================================================= */
(function () {
  'use strict';
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const TOTAL = 6319; // 1:45:19
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), x = s%60;
    const mm = String(m).padStart(2,'0'), xx = String(x).padStart(2,'0');
    return h > 0 ? h + ':' + mm + ':' + xx : mm + ':' + xx;
  }

  /* ----------------------------- persistence ----------------------------- */
  const LS = 'courseai_wb_adaptive_v1';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
  const state = {
    device: saved.device || 'fit',
    theme:  saved.theme  || 'light',
    tab:    saved.tab    || 'overview',
    sub:    saved.sub    || 'ainote',
    pos:    typeof saved.pos === 'number' ? saved.pos : 0,
  };
  function persist() {
    localStorage.setItem(LS, JSON.stringify({
      device: state.device, theme: state.theme, tab: state.tab, sub: state.sub, pos: state.pos,
    }));
  }

  /* ----------------------------- tabs ----------------------------- */
  function setTab(name) {
    state.tab = name; persist();
    $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.pane === name));
    $$('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  }

  /* ----------------------------- player ----------------------------- */
  let playing = false, cur = state.pos;
  const PLAY = '<polygon points="6 4 20 12 6 20 6 4"/>';
  const PAUSE = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

  function setPlaying(p) {
    playing = p;
    $('#stage').classList.toggle('playing', p);
    $('#playIcon').innerHTML = p ? PAUSE : PLAY;
  }
  function setTime(s, save = true) {
    cur = Math.max(0, Math.min(TOTAL, s));
    const pct = (cur / TOTAL) * 100;
    $('#scrubFill').style.width = pct + '%';
    $('#scrubHandle').style.left = pct + '%';
    $('#curTime').textContent = fmt(cur);
    if (save) { state.pos = Math.round(cur); persist(); }
  }
  function jump(t) {
    setTime(t);
    let best = null;
    $$('#txList .tx-line').forEach(l => { l.classList.remove('cur'); if (+l.dataset.t <= t) best = l; });
    if (best) best.classList.add('cur');
  }

  /* ----------------------------- device presets ----------------------------- */
  const DEVICES = {
    fit:     { w: null, label: '自适应' },
    desktop: { w: 1440, label: '桌面' },
    laptop:  { w: 1180, label: '笔记本' },
    ipadL:   { w: 1024, label: 'iPad 横屏' },
    ipadP:   { w: 834,  label: 'iPad 竖屏' },
    phone:   { w: 390,  label: '手机' },
  };
  function applyDevice() {
    const d = DEVICES[state.device] || DEVICES.fit;
    const frame = $('#frame'), stage = $('#stage-host');
    if (d.w == null) {
      frame.style.width = '100%'; frame.style.maxWidth = 'none';
      frame.classList.remove('boxed'); stage.classList.remove('padded');
    } else {
      frame.style.width = d.w + 'px'; frame.style.maxWidth = '100%';
      frame.classList.add('boxed'); stage.classList.add('padded');
    }
    $$('#deviceBar button').forEach(b => b.classList.toggle('on', b.dataset.device === state.device));
    const measure = () => {
      const w = Math.round($('#app').getBoundingClientRect().width);
      $('#readout').textContent = (d.w == null ? '自适应' : d.label) + ' · ' + w + 'px';
    };
    requestAnimationFrame(measure);
    setTimeout(measure, 340); // re-measure after the width transition settles
  }

  /* ----------------------------- init ----------------------------- */
  function init() {
    $('#app').setAttribute('data-theme', state.theme);

    // tabs
    $('#tabs').addEventListener('click', e => {
      const t = e.target.closest('.tab'); if (!t) return;
      setTab(t.dataset.pane);
      $('.panel-scroll')?.scrollTo({ top: 0 });
    });
    setTab(state.tab);

    // notes sub-tabs
    const seg = $('#notesSeg');
    const genLabel = $('#genLabel');
    const subLabels = { ainote: '生成 AI 笔记', quiz: '生成 AI 出题', mind: '生成 AI 脑图' };
    function setSub(sub) {
      state.sub = sub; persist();
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.sub === sub));
      $$('[data-sub]').forEach(el => { if (el.tagName === 'BUTTON') return; el.style.display = el.dataset.sub === sub ? '' : 'none'; });
      if (genLabel) genLabel.textContent = subLabels[sub];
    }
    seg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSub(b.dataset.sub); });
    setSub(state.sub);

    // quiz reveal
    $$('.q-reveal').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.q-card');
        const on = card.classList.toggle('revealed');
        btn.textContent = on ? '隐藏答案' : '显示答案';
        card.querySelectorAll('.q-opt[data-correct]').forEach(o => o.classList.toggle('correct', on));
      });
    });

    // player
    $('#bigPlay').addEventListener('click', () => setPlaying(true));
    $('#playBtn').addEventListener('click', () => setPlaying(!playing));
    const scrub = $('#scrub');
    scrub.addEventListener('click', e => { const r = scrub.getBoundingClientRect(); setTime(((e.clientX - r.left) / r.width) * TOTAL); });

    // speed
    const speeds = [1, 1.25, 1.5, 2, 0.75]; let si = 0;
    $('#speedBtn').addEventListener('click', () => { si = (si + 1) % speeds.length; $('#speedBtn').textContent = speeds[si].toFixed(2).replace(/0$/,'').replace(/\.$/,'.0') + '×'; });
    $('#ccBtn').addEventListener('click', e => e.currentTarget.classList.toggle('on'));

    // jump from timestamps / chapters / transcript
    document.body.addEventListener('click', e => {
      const el = e.target.closest('[data-t]');
      if (el && (el.classList.contains('tchip') || el.classList.contains('chapter') || el.classList.contains('tx-line'))) {
        jump(+el.dataset.t);
        // on stacked layouts, scroll the video into view by scrolling the stack up
        const stack = $('.stack');
        if (stack && getComputedStyle(stack).display === 'block') stack.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    // rail dark toggle
    $('#railDark').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      persist();
      $('#app').setAttribute('data-theme', state.theme);
      $('#railDark').classList.toggle('active', state.theme === 'dark');
    });
    $('#railDark').classList.toggle('active', state.theme === 'dark');

    // device presets
    $('#deviceBar').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state.device = b.dataset.device; persist(); applyDevice();
    });
    window.addEventListener('resize', () => {
      const d = DEVICES[state.device];
      requestAnimationFrame(() => {
        const w = Math.round($('#app').getBoundingClientRect().width);
        $('#readout').textContent = (d.w == null ? '自适应' : d.label) + ' · ' + w + 'px';
      });
    });

    setTime(state.pos, false);
    applyDevice();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
