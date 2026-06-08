/* =========================================================================
   course-ai · 自适应课程库  —  应用逻辑
   渲染内容 / 视图切换 / 抽屉侧栏 / 方向 / 设备预设 / 主题 / 持久化
   ========================================================================= */
(function () {
  'use strict';

  /* ----------------------------- icons ----------------------------- */
  const I = {
    play:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    playSm: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    more:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  };

  /* ----------------------------- data ----------------------------- */
  const FOLDERS = {
    shenlun:   { name: '申论' },
    record:    { name: '录制视频' },
  };

  const DATA = {
    shenlun: [
      { t: '01.【申论之根】底层逻辑.mp4',      dur: '1:45:19', st: 'done',  pg: 100, date: '6月3日', tint: 'blue' },
      { t: '02.【概括题】概括对策.mp4',        dur: '1:12:04', st: 'done',  pg: 100, date: '6月3日', tint: 'green' },
      { t: '03.【概括题】概括原因.mp4',        dur: '58:32',   st: 'ready', pg: 46,  date: '6月4日', tint: 'amber' },
      { t: '04.【概括题】概括问题.mp4',        dur: '1:06:11', st: 'proc',  pg: 62,  date: '6月5日', tint: 'violet' },
      { t: '05.【对策题】提出对策专项.mp4',    dur: '1:33:50', st: 'ready', pg: 0,   date: '6月5日', tint: 'rose' },
      { t: '06.【综合分析】方法论精讲.mp4',    dur: '1:21:38', st: 'pend',  pg: 0,   date: '6月6日', tint: 'blue' },
      { t: '07.【应用文】格式与采分点.mp4',    dur: '49:27',   st: 'pend',  pg: 0,   date: '6月6日', tint: 'green' },
      { t: '08.【大作文】分论点写作训练.mp4',  dur: '2:04:55', st: 'pend',  pg: 0,   date: '6月7日', tint: 'amber' },
    ],
    record: [
      { t: '晨读带学_2024-05-30.mp4',     dur: '22:10', st: 'ready', pg: 0,   date: '5月30日', tint: 'violet' },
      { t: '模考讲评·材料题片段.mp4',      dur: '06:48', st: 'done',  pg: 100, date: '5月28日', tint: 'rose' },
      { t: '周末答疑回放_05.mp4',          dur: '41:25', st: 'pend',  pg: 0,   date: '5月25日', tint: 'blue' },
    ],
  };

  const STATUS = {
    done:  { label: '已处理', cls: 'done' },
    ready: { label: '可学习', cls: 'ready' },
    proc:  { label: '处理中', cls: 'proc' },
    pend:  { label: '待处理', cls: 'pend' },
  };
  const TINT = {
    blue:   ['var(--t-blue)','var(--t-blue-2)'],
    green:  ['var(--t-green)','var(--t-green-2)'],
    amber:  ['var(--t-amber)','var(--t-amber-2)'],
    violet: ['var(--t-violet)','var(--t-violet-2)'],
    rose:   ['var(--t-rose)','var(--t-rose-2)'],
  };

  /* ----------------------------- state ----------------------------- */
  const LS = 'courseai_adaptive_v1';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
  const state = {
    dir:    saved.dir    || 'a',
    device: saved.device || 'fit',
    view:   saved.view   || null,      // null → per-direction default
    theme:  saved.theme  || 'light',
    folder: saved.folder || 'shenlun',
    filter: 'all',
  };
  function persist() {
    localStorage.setItem(LS, JSON.stringify({
      dir: state.dir, device: state.device, view: state.view, theme: state.theme, folder: state.folder,
    }));
  }
  function defaultView() { return state.dir === 'b' ? 'list' : 'grid'; }
  function curView() { return state.view || defaultView(); }

  /* ----------------------------- helpers ----------------------------- */
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function chip(v) {
    const s = STATUS[v.st];
    let label = s.label;
    if (v.st === 'proc') label = '处理中 ' + v.pg + '%';
    return `<span class="chip ${s.cls}"><span class="dot"></span>${label}</span>`;
  }
  function metaText(v) {
    if (v.st === 'done')  return '已处理';
    if (v.st === 'proc')  return '生成中 ' + v.pg + '%';
    if (v.st === 'ready' && v.pg > 0) return '已学 ' + v.pg + '%';
    if (v.st === 'ready') return '资料就绪';
    return v.date + ' 添加';
  }
  function tintVars(v) { const [a, b] = TINT[v.tint]; return `--tint:${a};--tint2:${b};`; }

  function items() {
    let arr = DATA[state.folder] || [];
    if (state.filter !== 'all') arr = arr.filter(v => v.st === state.filter);
    return arr;
  }

  /* ----------------------------- render: hero ----------------------------- */
  function renderHero() {
    const host = $('#heroArea');
    if (state.dir !== 'a') { host.innerHTML = ''; return; }
    const arr = DATA[state.folder] || [];
    // pick the in-progress one, else first
    const v = arr.find(x => x.st === 'proc') || arr.find(x => x.st === 'ready' && x.pg > 0) || arr[0];
    if (!v) { host.innerHTML = ''; return; }
    const pg = v.pg || 0;
    host.innerHTML = `
      <div class="hero">
        <div class="hero-card">
          <div class="hero-art"></div>
          <div class="hero-body">
            <div class="hero-meta">
              <div class="eyebrow">继续学习 · ${FOLDERS[state.folder].name}</div>
              <h3>${v.t.replace(/\.mp4$/, '')}</h3>
              <div class="ln">${pg > 0 ? '上次看到 ' + pg + '%，共 ' + v.dur : '资料已就绪 · 共 ' + v.dur}</div>
              <div class="hero-bar"><i style="width:${Math.max(pg, 4)}%"></i></div>
            </div>
            <button class="hero-play">${I.play}<span>${pg > 0 ? '继续学习' : '开始学习'}</span></button>
          </div>
        </div>
      </div>`;
  }

  /* ----------------------------- render: content ----------------------------- */
  function cardHTML(v, i) {
    const pg = v.pg || 0;
    return `
      <article class="card" data-i="${i}" style="${tintVars(v)}">
        <div class="thumb">
          <div class="subj"></div>
          <button class="more" title="更多">${I.more}</button>
          <span class="play">${I.play}</span>
          <span class="dur">${v.dur}</span>
          ${pg > 0 && pg < 100 ? `<div class="ov-bar"><i style="width:${pg}%"></i></div>` : ''}
        </div>
        <div class="card-body">
          <div class="card-title">${v.t}</div>
          <div class="card-foot">${chip(v)}<span class="meta-tx">${metaText(v)}</span></div>
        </div>
      </article>`;
  }

  function rowHTML(v, i) {
    const pg = v.pg || 0;
    const progCls = v.st === 'done' ? 'done' : (v.st === 'proc' ? 'proc' : '');
    return `
      <div class="row" data-i="${i}" style="${tintVars(v)}">
        <div class="row-name">
          <div class="row-thumb"><span class="play">${I.playSm}</span></div>
          <div class="nm"><div class="t">${v.t}</div><div class="s">${metaText(v)}</div></div>
        </div>
        <div class="c-dur col-dur">${v.dur}</div>
        <div class="c-prog col-prog"><div class="prog ${progCls}"><i style="width:${pg}%"></i></div><span class="prog-tx">${pg}%</span></div>
        <div class="c-date col-date">${v.date}</div>
        <div class="c-status">${chip(v)}</div>
      </div>`;
  }

  function listHeadHTML() {
    if (state.dir === 'b') {
      return `<div class="list-head">
        <div class="h-name">名称</div>
        <div class="h-dur col-dur r">时长</div>
        <div class="h-prog col-prog">学习进度</div>
        <div class="h-date col-date r">更新时间</div>
        <div class="h-status">状态</div>
      </div>`;
    }
    return `<div class="list-head">
      <div class="h-name">名称</div>
      <div class="h-dur col-dur r">时长</div>
      <div class="h-prog col-prog">学习进度</div>
      <div class="h-status">状态</div>
    </div>`;
  }

  function renderContent() {
    const host = $('#contentArea');
    const arr = items();
    if (!arr.length) {
      host.innerHTML = `<div style="padding:60px 0;text-align:center;color:var(--text-3);font-size:14px">该筛选下暂无视频</div>`;
      return;
    }
    if (curView() === 'grid') {
      host.innerHTML = `<div class="grid">${arr.map(cardHTML).join('')}</div>`;
    } else {
      // direction B lists keep the date column; A drops it via --cols
      const rows = arr.map((v, i) => rowHTML(v, i)).join('');
      host.innerHTML = `<div class="list">${listHeadHTML()}${rows}</div>`;
    }
  }

  /* ----------------------------- render: chrome bits ----------------------------- */
  function renderSub() {
    const arr = DATA[state.folder] || [];
    $('#folderSub').textContent = FOLDERS[state.folder].name + ' · ' + arr.length + ' 个视频';
  }
  function renderFilters() {
    const arr = DATA[state.folder] || [];
    const counts = { all: arr.length };
    Object.keys(STATUS).forEach(k => counts[k] = arr.filter(v => v.st === k).length);
    const defs = [['all','全部'],['done','已处理'],['proc','处理中'],['ready','可学习'],['pend','待处理']];
    $('#filters').innerHTML = defs.map(([k, label]) =>
      `<button class="fchip ${state.filter === k ? 'on' : ''}" data-f="${k}">${label}<span class="ct">${counts[k] || 0}</span></button>`
    ).join('');
  }
  function syncViewToggle() {
    $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === curView()));
  }
  function syncNav() {
    $$('#nav .nav-item').forEach(n => n.classList.toggle('active', n.dataset.folder === state.folder));
    $$('#nav .count')[0]; // counts static
  }

  /* ----------------------------- full render ----------------------------- */
  function renderAll() {
    $('#app').setAttribute('data-dir', state.dir);
    $('#app').setAttribute('data-theme', state.theme);
    renderSub();
    renderFilters();
    renderHero();
    renderContent();
    syncViewToggle();
    syncNav();
    $('#darkSwitch').classList.toggle('on', state.theme === 'dark');
  }

  /* ----------------------------- device presets (shell) ----------------------------- */
  const DEVICES = {
    fit:     { w: null,  label: '自适应' },
    desktop: { w: 1440,  label: '桌面' },
    laptop:  { w: 1180,  label: '笔记本' },
    ipadL:   { w: 1024,  label: 'iPad 横屏' },
    ipadP:   { w: 834,   label: 'iPad 竖屏' },
    phone:   { w: 390,   label: '手机' },
  };
  function applyDevice() {
    const d = DEVICES[state.device] || DEVICES.fit;
    const frame = $('#frame');
    const stage = $('#stage');
    if (d.w == null) {
      frame.style.width = '100%';
      frame.style.maxWidth = 'none';
      frame.classList.remove('boxed');
      stage.classList.remove('padded');
    } else {
      frame.style.width = d.w + 'px';
      frame.style.maxWidth = '100%';
      frame.classList.add('boxed');
      stage.classList.add('padded');
    }
    // close drawer when resizing
    $('#app').classList.remove('drawer-open');
    $$('#deviceBar button').forEach(b => b.classList.toggle('on', b.dataset.device === state.device));
    updateReadout();
  }
  function updateReadout() {
    requestAnimationFrame(() => {
      const w = Math.round($('#app').getBoundingClientRect().width);
      const d = DEVICES[state.device];
      $('#readout').textContent = (d.w == null ? '自适应' : d.label) + ' · ' + w + 'px';
    });
  }

  /* ----------------------------- wire up ----------------------------- */
  function init() {
    // direction switch
    $$('#dirBar button').forEach(b => b.classList.toggle('on', b.dataset.dir === state.dir));
    $('#dirBar').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state.dir = b.dataset.dir;
      $$('#dirBar button').forEach(x => x.classList.toggle('on', x === b));
      persist(); renderAll();
    });

    // device presets
    $('#deviceBar').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state.device = b.dataset.device;
      persist(); applyDevice();
    });

    // view toggle
    $('#viewSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state.view = b.dataset.view;
      persist(); renderContent(); syncViewToggle();
    });

    // filters (delegated)
    $('#filters').addEventListener('click', e => {
      const b = e.target.closest('.fchip'); if (!b) return;
      state.filter = b.dataset.f;
      renderFilters(); renderContent();
    });

    // folder switch
    $('#nav').addEventListener('click', e => {
      const it = e.target.closest('.nav-item'); if (!it || !it.dataset.folder) return;
      state.folder = it.dataset.folder;
      state.filter = 'all';
      persist(); renderAll();
      $('#app').classList.remove('drawer-open');
    });

    // drawer
    $('#hamb').addEventListener('click', () => $('#app').classList.toggle('drawer-open'));
    $('#scrim').addEventListener('click', () => $('#app').classList.remove('drawer-open'));

    // dark toggle (inside app footer)
    $('#darkToggle').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      persist(); renderAll();
    });

    // re-measure readout on resize
    window.addEventListener('resize', updateReadout);

    renderAll();
    applyDevice();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
