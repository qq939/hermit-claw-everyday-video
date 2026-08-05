/* Hermit-Claw Storyboard — console.html tab embed
 *
 * This script is appended to console.html at serve-time by server.js.
 * On DOM ready it:
 *   1) inserts a new nav-item "🗂 库" into the sidebar,
 *   2) inserts a new page #page-storyboard with the full library UI,
 *   3) hooks into the existing nav-item click handler so the new page
 *      becomes active when its nav-item is clicked.
 *
 * The UI is identical to /studio/storyboard but inline in the console.
 * Data still flows through /api/storyboard/* endpoints on 8082.
 *
 * All IDs and class names that the original console.html uses are
 * preserved. We only ADD new ones.
 */

(function () {
  'use strict';

  // ----- style block for storyboard UI (scoped under #page-storyboard) -----
  const STYLE_ID = 'sb-console-style';
  if (document.getElementById(STYLE_ID)) return; // already injected
  const css = `
    #page-storyboard { padding: 18px; }
    #page-storyboard h2.page-title { font-size: 18px; margin: 0 0 4px 0; }
    #page-storyboard p.page-sub { color: #6b7280; font-size: 13px; margin: 0 0 14px 0; }
    #sb-layout { display: grid; grid-template-rows: auto 1fr auto; gap: 14px; height: calc(100vh - 130px); }
    #sb-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line, #2a2f3a); padding: 0 0 6px 0; }
    #sb-tabs .tab { padding: 6px 12px; cursor: pointer; border-radius: 6px 6px 0 0; color: #9aa3b2; font-size: 13px; }
    #sb-tabs .tab.active { background: #161b22; color: #e6edf3; border: 1px solid var(--line, #2a2f3a); border-bottom-color: #161b22; margin-bottom: -1px; }
    #sb-strip { display: flex; gap: 10px; overflow-x: auto; padding: 10px 4px; align-items: center; min-height: 180px; }
    .sb-card { flex: 0 0 120px; background: #161b22; border: 1px solid #2a2f3a; border-radius: 8px; padding: 8px; cursor: pointer; position: relative; }
    .sb-card.selected { outline: 2px solid #58a6ff; }
    .sb-card .face { width: 100%; aspect-ratio: 1/1; background: #0a0d13; border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 11px; }
    .sb-card .face img { width: 100%; height: 100%; object-fit: cover; }
    .sb-card .name { font-size: 12px; margin-top: 6px; font-weight: 600; color: #e6edf3; }
    .sb-card .meta { font-size: 10px; color: #6b7280; margin-top: 2px; display: flex; justify-content: space-between; }
    .sb-add-card { flex: 0 0 120px; height: 160px; display: flex; align-items: center; justify-content: center; border: 1.5px dashed #2a2f3a; border-radius: 8px; color: #6b7280; cursor: pointer; }
    .sb-add-card:hover { color: #58a6ff; border-color: #58a6ff; }
    #sb-shots-wrap { overflow: auto; background: #161b22; border: 1px solid #2a2f3a; border-radius: 8px; }
    table.sb-shots { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }
    table.sb-shots th, table.sb-shots td { padding: 8px 10px; border-bottom: 1px solid #2a2f3a; text-align: left; vertical-align: top; }
    table.sb-shots th { background: #11151d; position: sticky; top: 0; z-index: 1; font-weight: 600; color: #9aa3b2; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
    table.sb-shots tr.selected td { background: rgba(88,166,255,0.06); }
    table.sb-shots td.idx { width: 40px; color: #6b7280; }
    table.sb-shots td.times input { width: 62px; background: #0a0d13; color: #e6edf3; border: 1px solid #2a2f3a; border-radius: 4px; padding: 4px 6px; }
    table.sb-shots td.cast { min-width: 220px; }
    table.sb-shots td.desc textarea, table.sb-shots td.notes textarea { width: 100%; background: #0a0d13; color: #e6edf3; border: 1px solid #2a2f3a; border-radius: 4px; padding: 6px 8px; resize: vertical; }
    table.sb-shots td.desc textarea { min-height: 48px; }
    table.sb-shots td.notes textarea { min-height: 32px; font-size: 11px; }
    table.sb-shots td.ver { color: #7ee787; font-size: 11px; width: 40px; }
    table.sb-shots td.actions { width: 90px; }
    .sb-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid #2a2f3a; border-radius: 99px; background: #0a0d13; margin: 2px 4px 2px 0; font-size: 11px; color: #e6edf3; }
    .sb-chip.scene { border-color: #3b5d6e; }
    .sb-chip.prop { border-color: #5d4b6e; }
    .sb-chip .x { cursor: pointer; color: #6b7280; padding: 0 4px; font-weight: 700; }
    .sb-chip .x:hover { color: #ff7b72; }
    .sb-cast-empty { color: #6b7280; font-style: italic; font-size: 11px; }
    .sb-version-badge { background: #0a0d13; color: #9aa3b2; padding: 0 6px; border-radius: 99px; font-size: 10px; border: 1px solid #2a2f3a; }
    #sb-bottom { padding: 12px; background: #11151d; border: 1px solid #2a2f3a; border-radius: 8px; }
    #sb-bottom .row { display: flex; gap: 10px; align-items: center; }
    #sb-bottom input { background: #0a0d13; color: #e6edf3; border: 1px solid #2a2f3a; border-radius: 4px; padding: 6px 8px; }
    #sb-bottom .exports { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
    #sb-bottom .export-chip { background: #0a0d13; border: 1px solid #2a2f3a; border-radius: 4px; padding: 4px 8px; font-size: 11px; }
    .sb-btn { background: #161b22; color: #e6edf3; border: 1px solid #2a2f3a; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
    .sb-btn:hover { border-color: #58a6ff; }
    .sb-btn.primary { background: #58a6ff; color: #0b0e14; border-color: #58a6ff; font-weight: 600; }
    .sb-btn.danger { color: #ff7b72; border-color: #5d2a2a; }
    .sb-muted { color: #6b7280; }
    .sb-toast { position: fixed; bottom: 14px; right: 14px; background: #161b22; border: 1px solid #2a2f3a; border-radius: 6px; padding: 8px 12px; font-size: 12px; z-index: 1000; }
    .sb-toast.err { border-color: #ff7b72; color: #ff7b72; }

    /* Modal */
    .sb-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 999; }
    .sb-modal-bg.show { display: flex; }
    .sb-modal { background: #11151d; border: 1px solid #2a2f3a; border-radius: 12px; padding: 18px; min-width: 720px; max-width: 90vw; max-height: 90vh; overflow: auto; }
    .sb-modal h2 { margin: 0 0 8px; font-size: 14px; color: #e6edf3; }
    .sb-modal .row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
    .sb-modal label { color: #9aa3b2; font-size: 12px; display: flex; align-items: center; gap: 6px; }
    .sb-modal input, .sb-modal textarea { background: #0a0d13; color: #e6edf3; border: 1px solid #2a2f3a; border-radius: 4px; padding: 6px 8px; font-size: 13px; }
    .sb-modal textarea { width: 100%; min-height: 60px; resize: vertical; }
    .sb-modal .view-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 8px; }
    .sb-modal .view { background: #161b22; border: 1px solid #2a2f3a; border-radius: 8px; padding: 8px; }
    .sb-modal .view .preview { aspect-ratio: 1/1; background: #0a0d13; border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 11px; }
    .sb-modal .view .preview img { width: 100%; height: 100%; object-fit: cover; }
    .sb-modal .view .actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .sb-modal .view h3 { margin: 0 0 4px; font-size: 11px; color: #9aa3b2; text-transform: uppercase; letter-spacing: 0.5px; }
    .sb-modal .versions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .sb-modal .versions .ver { padding: 3px 8px; border: 1px solid #2a2f3a; border-radius: 99px; font-size: 11px; cursor: pointer; color: #e6edf3; }
    .sb-modal .versions .ver.current { background: #58a6ff; color: #0b0e14; border-color: #58a6ff; }
    .sb-modal hr { border: 0; border-top: 1px solid #2a2f3a; margin: 12px 0; }

    /* Project selector */
    #sb-projects { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 0 0 6px 0; }
    #sb-projects .proj { padding: 4px 10px; border: 1px solid #2a2f3a; border-radius: 99px; font-size: 12px; cursor: pointer; color: #e6edf3; background: #11151d; }
    #sb-projects .proj.active { background: #58a6ff; color: #0b0e14; border-color: #58a6ff; font-weight: 600; }
    #sb-projects .proj .del { margin-left: 6px; color: #ff7b72; font-weight: 700; cursor: pointer; }
    #sb-projects .add { padding: 4px 10px; border: 1px dashed #2a2f3a; border-radius: 99px; font-size: 12px; cursor: pointer; color: #9aa3b2; background: transparent; }
    #sb-projects .add:hover { color: #58a6ff; border-color: #58a6ff; }
  `;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = css;
  document.head.appendChild(s);

  // ----- add nav item + page -----
  const nav = document.querySelector('nav.nav');
  if (!nav) return;
  const navItem = document.createElement('div');
  navItem.className = 'nav-item';
  navItem.dataset.page = 'storyboard';
  navItem.innerHTML = '<span class="icon">🗂</span><span class="txt">库</span>';
  nav.appendChild(navItem);

  const main = document.querySelector('main.main');
  if (!main) return;
  const page = document.createElement('div');
  page.className = 'page';
  page.id = 'page-storyboard';
  page.innerHTML = `
    <h2 class="page-title">🗂 库 · Storyboard Library</h2>
    <p class="page-sub">人物 / 场景 / 道具 形象库（多项目隔离 · 多版本 · 三视图 · 可上传 / OBS 选择 / 自动生成） + 镜头表 + PDF 导出</p>
    <div id="sb-projects">
      <span class="sb-muted" style="font-size:11px;">项目：</span>
      <span id="sb-projects-list"></span>
      <span class="add" id="sb-proj-add">+ 新项目</span>
    </div>
    <div id="sb-layout">
      <div>
        <div id="sb-tabs">
          <div class="tab active" data-kind="character">角色</div>
          <div class="tab" data-kind="scene">场景</div>
          <div class="tab" data-kind="prop">道具</div>
          <span style="flex:1"></span>
          <div class="sb-muted" style="font-size:11px;align-self:center;">单击选中 · 双击编辑 · 上方点 + 新增</div>
        </div>
        <div id="sb-strip"><div class="sb-add-card" id="sb-add-card">+ 新增</div></div>
      </div>
      <div id="sb-shots-wrap">
        <table class="sb-shots" id="sb-shots-table">
          <thead><tr><th>#</th><th>时间码 (in→out)</th><th>人物/场景/道具</th><th>描述</th><th>备注</th><th>v</th><th></th></tr></thead>
          <tbody id="sb-shots-body"></tbody>
        </table>
        <div style="padding:10px;"><button class="sb-btn" id="sb-add-shot">+ 新增镜头</button></div>
      </div>
      <div id="sb-bottom">
        <div class="row">
          <input id="sb-pdf-title" placeholder="PDF 标题（默认自动生成日期）" style="flex:1;max-width:380px;">
          <button class="sb-btn primary" id="sb-export-btn">⬇ 导出 PDF → 上传 OBS</button>
          <span class="sb-muted" id="sb-export-status"></span>
          <span style="flex:1"></span>
          <button class="sb-btn" id="sb-cfg-btn">⚙ OBS 设置</button>
        </div>
        <div class="exports" id="sb-exports-list"></div>
      </div>
    </div>

    <!-- editor modal -->
    <div class="sb-modal-bg" id="sb-modal-bg">
      <div class="sb-modal" id="sb-modal">
        <h2 id="sb-modal-title">编辑</h2>
        <div class="row">
          <label>名称 <input id="sb-m-name" style="width:240px;"></label>
          <label>主题 <input id="sb-m-theme" style="width:280px;"></label>
          <span style="flex:1"></span>
          <span class="sb-muted" id="sb-m-kind"></span>
        </div>
        <hr>
        <div class="row" style="flex-wrap:wrap;">
          <span class="sb-muted" style="font-size:11px;">基于版本（双击 chip 切换为 current，后续版本丢弃）：</span>
          <div class="versions" id="sb-m-versions"></div>
        </div>
        <hr>
        <div class="view-grid" id="sb-m-views"></div>
        <hr>
        <div class="row" style="justify-content:flex-end;gap:8px;">
          <button class="sb-btn danger" id="sb-m-delete">删除整个形象</button>
          <span style="flex:1"></span>
          <button class="sb-btn" id="sb-m-cancel">取消</button>
          <button class="sb-btn primary" id="sb-m-save">生成下一版本</button>
        </div>
      </div>
    </div>
  `;
  main.appendChild(page);

  // Hook the new nav item into the existing nav handler.
  navItem.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    navItem.classList.add('active');
    page.classList.add('active');
    if (typeof refreshPage === 'function') refreshPage('storyboard');
    sbLoadState();
  });

  // Refresh on tab switch
  function sbLoadState() { if (window.SB && SB.refresh) SB.refresh(); }

  // ===== SB module =====
  const SB = {
    state: { items: [], versions: [], shots: [], config: {}, projects: [], currentProjectId: null },
    selectedKind: 'character',
    selectedItemId: null,
    selectedShotId: null,
    editItemId: null,
    editParentVersionId: null,
    pickerTarget: null,

    KIND_LABEL: { character: '角色', scene: '场景', prop: '道具' },

    api(method, path, body, isForm) {
      const opts = { method, headers: {} };
      if (body !== undefined && !isForm) {
        opts.headers['Content-Type'] = 'application/json; charset=utf-8';
        opts.body = JSON.stringify(body);
      } else if (isForm) {
        opts.body = body;
      }
      return fetch(path, opts).then(async (r) => {
        const txt = await r.text();
        let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
        if (!r.ok) throw new Error((j && j.error) || `${r.status}`);
        return j;
      });
    },

    el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; },
    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },

    imgUrl(src) {
      if (!src) return '';
      if (src.kind === 'upload' && src.path) {
        const m = src.path.match(/uploads\/([^/]+)$/);
        if (m) return '/api/storyboard/asset/uploads/' + m[1];
      }
      return src.url || src.sourceUrl || '';
    },

    toast(msg, isErr) {
      const t = this.el(`<div class="sb-toast ${isErr ? 'err' : ''}">${this.esc(msg)}</div>`);
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    },

    async refresh() {
      // Default to the current project's ?projectId= param if any.
      const params = this.state.currentProjectId ? `?projectId=${encodeURIComponent(this.state.currentProjectId)}` : '';
      const s = await this.api('GET', '/api/storyboard/state' + params);
      this.state.items = s.items || [];
      this.state.versions = s.versions || [];
      this.state.shots = (s.shots || []).sort((a, b) => (a.index || 0) - (b.index || 0));
      this.state.config = s.config || {};
      this.state.projects = s.projects || [];
      this.state.currentProjectId = s.currentProjectId || (this.state.projects[0] && this.state.projects[0].id) || null;
      this.renderProjects(); this.renderTabs(); this.renderStrip(); this.renderShots(); this.renderExports();
    },

    renderProjects() {
      const wrap = document.getElementById('sb-projects-list');
      if (!wrap) return;
      wrap.innerHTML = '';
      this.state.projects.forEach((p) => {
        const c = this.el(`<span class="proj ${p.id === this.state.currentProjectId ? 'active' : ''}" data-id="${p.id}">${this.esc(p.name)} <span class="del" title="删除项目（级联删除该项目的素材 / 版本 / 镜头）">×</span></span>`);
        c.onclick = (e) => {
          if (e.target.classList.contains('del')) return;
          this.state.currentProjectId = p.id;
          this.refresh();
        };
        c.querySelector('.del').onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`删除项目「${p.name}」？该项目的所有素材 / 版本 / 镜头会被一并删除。`)) return;
          try {
            await this.api('DELETE', `/api/storyboard/projects/${encodeURIComponent(p.id)}`);
            this.toast(`已删除「${p.name}」`);
            if (this.state.currentProjectId === p.id) this.state.currentProjectId = null;
            this.refresh();
          } catch (err) { this.toast('删除失败：' + err.message, true); }
        };
        wrap.appendChild(c);
      });
    },

    renderTabs() {
      document.querySelectorAll('#sb-tabs .tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.kind === this.selectedKind);
      });
    },

    renderStrip() {
      const strip = document.getElementById('sb-strip');
      strip.innerHTML = '';
      const items = this.state.items.filter((x) => x.kind === this.selectedKind);
      items.forEach((it) => strip.appendChild(this.renderCard(it)));
      const add = this.el(`<div class="sb-add-card">+ 新增${this.KIND_LABEL[this.selectedKind]}</div>`);
      add.onclick = () => this.openCreateItem(this.selectedKind);
      strip.appendChild(add);
    },

    renderCard(it) {
      const cur = this.state.versions.find((v) => v.id === it.currentVersionId);
      const src = cur && cur.sources && cur.sources.front;
      const face = src
        ? `<img src="${this.esc(this.imgUrl(src))}" alt="">`
        : `<span>${it.versionCount ? 'v' + (cur ? cur.versionNo : '?') : '未生成'}</span>`;
      const c = this.el(`
        <div class="sb-card ${it.id === this.selectedItemId ? 'selected' : ''}" data-id="${it.id}">
          <div class="face">${face}</div>
          <div class="name">${this.esc(it.name)}</div>
          <div class="meta"><span>${this.esc(it.theme || '')}</span><span>v${cur ? cur.versionNo : 0}</span></div>
        </div>`);
      c.onclick = () => {
        this.selectedItemId = it.id;
        this.renderStrip();
        // Auto-add to selected shot if any.
        if (this.selectedShotId && it.currentVersionId) {
          this.addToSelectedShot(it);
        }
      };
      c.ondblclick = () => this.openEditor(it.id);
      return c;
    },

    async addToSelectedShot(item) {
      if (!this.selectedShotId) return;
      const slot = item.kind === 'scene' ? 'scene' : (item.kind === 'prop' ? 'prop' : 'cast');
      try {
        const r = await this.api('POST', `/api/storyboard/shots/${encodeURIComponent(this.selectedShotId)}/add`, { versionId: item.currentVersionId, slot });
        const i = this.state.shots.findIndex((x) => x.id === r.shot.id);
        if (i >= 0) this.state.shots[i] = r.shot;
        this.renderShots();
      } catch (e) { this.toast('加入失败：' + e.message, true); }
    },

    renderShots() {
      const body = document.getElementById('sb-shots-body');
      body.innerHTML = '';
      if (!this.state.shots.length) {
        body.appendChild(this.el(`<tr><td colspan="7" class="sb-muted" style="padding:24px;text-align:center;">还没有镜头，点下方新增。</td></tr>`));
        return;
      }
      this.state.shots.forEach((s) => body.appendChild(this.renderShot(s)));
    },

    renderShot(s) {
      const tr = this.el(`
        <tr class="${s.id === this.selectedShotId ? 'selected' : ''}" data-id="${s.id}">
          <td class="idx">${s.index || '?'}</td>
          <td class="times">
            <input class="t-in" value="${this.esc(s.tIn || '')}">→
            <input class="t-out" value="${this.esc(s.tOut || '')}">
          </td>
          <td class="cast"></td>
          <td class="desc"><textarea>${this.esc(s.description || '')}</textarea></td>
          <td class="notes"><textarea>${this.esc(s.notes || '')}</textarea></td>
          <td class="ver"><span class="sb-version-badge">v${s.versionNo || 1}</span></td>
          <td class="actions"><button class="sb-btn danger del">✕</button></td>
        </tr>`);
      const cast = tr.querySelector('.cast');
      const slots = [
        ...(s.castVersionIds || []).map((vid) => ({ slot: 'cast', vid })),
        ...(s.sceneVersionIds || []).map((vid) => ({ slot: 'scene', vid })),
        ...(s.propVersionIds || []).map((vid) => ({ slot: 'prop', vid })),
      ];
      if (!slots.length) cast.appendChild(this.el(`<span class="sb-cast-empty">点击上方卡片可加入</span>`));
      slots.forEach(({ slot, vid }) => {
        const v = this.state.versions.find((x) => x.id === vid);
        if (!v) return;
        const it = this.state.items.find((x) => x.id === v.itemId);
        const label = `${it ? it.name : '?'} v${v.versionNo || '?'}`;
        const chip = this.el(`<span class="sb-chip ${slot}" data-vid="${vid}" data-slot="${slot}">${slot === 'cast' ? '👤' : slot === 'scene' ? '🏞' : '🎁'} ${this.esc(label)} <span class="x">×</span></span>`);
        chip.querySelector('.x').onclick = async (e) => {
          e.stopPropagation();
          const r = await this.api('POST', `/api/storyboard/shots/${encodeURIComponent(s.id)}/remove`, { versionId: vid, slot });
          const i = this.state.shots.findIndex((x) => x.id === r.shot.id);
          if (i >= 0) this.state.shots[i] = r.shot;
          this.renderShots();
        };
        cast.appendChild(chip);
      });
      tr.onclick = (e) => {
        if (['INPUT','TEXTAREA','BUTTON'].includes(e.target.tagName)) return;
        this.selectedShotId = s.id;
        this.renderShots();
      };
      tr.querySelector('.t-in').onchange = async (e) => await this.patchShot(s.id, { tIn: e.target.value });
      tr.querySelector('.t-out').onchange = async (e) => await this.patchShot(s.id, { tOut: e.target.value });
      tr.querySelector('.desc textarea').onchange = async (e) => await this.patchShot(s.id, { description: e.target.value });
      tr.querySelector('.notes textarea').onchange = async (e) => await this.patchShot(s.id, { notes: e.target.value });
      tr.querySelector('.del').onclick = async () => {
        if (!confirm(`删除镜头 #${s.index}？`)) return;
        await this.api('DELETE', `/api/storyboard/shots/${encodeURIComponent(s.id)}`);
        this.state.shots = this.state.shots.filter((x) => x.id !== s.id);
        this.renderShots();
      };
      return tr;
    },

    async patchShot(id, patch) {
      const r = await this.api('PATCH', `/api/storyboard/shots/${encodeURIComponent(id)}`, patch);
      const i = this.state.shots.findIndex((x) => x.id === r.shot.id);
      if (i >= 0) this.state.shots[i] = r.shot;
    },

    renderExports() {
      const list = document.getElementById('sb-exports-list');
      list.innerHTML = '';
      const exps = (this.state.config && this.state.config.exports) || [];
      if (!exps.length) { list.appendChild(this.el(`<span class="sb-muted">还没有导出记录</span>`)); return; }
      exps.slice(0, 8).forEach((e) => {
        const fname = (e.localPath || '').split('/').pop();
        const a = this.el(`<a class="export-chip" href="/api/storyboard/exports/${encodeURIComponent(fname)}">${this.esc((e.at || '').slice(0,19))} · ${e.status} · ${(e.bytes||0).toLocaleString()}B${e.obsKey ? ' · ' + this.esc(e.obsKey) : ''}</a>`);
        list.appendChild(a);
      });
    },

    openCreateItem(kind) {
      if (!this.state.currentProjectId) { this.toast('请先在顶部选择一个项目', true); return; }
      const name = prompt(`新增${this.KIND_LABEL[kind]}名称（项目：${(this.state.projects.find((x) => x.id === this.state.currentProjectId) || {}).name || '?'}）：`);
      if (!name) return;
      this.api('POST', '/api/storyboard/items', { name, kind, projectId: this.state.currentProjectId }).then((r) => {
        this.state.items.push(r.item);
        this.selectedItemId = r.item.id;
        this.renderStrip();
        this.openEditor(r.item.id);
      }).catch((e) => this.toast('创建失败：' + e.message, true));
    },

    openEditor(itemId) {
      this.editItemId = itemId;
      this.editParentVersionId = null;
      const it = this.state.items.find((x) => x.id === itemId);
      if (!it) return;
      document.getElementById('sb-modal-title').textContent = `编辑：${it.name}`;
      document.getElementById('sb-m-name').value = it.name;
      document.getElementById('sb-m-theme').value = it.theme || '';
      document.getElementById('sb-m-kind').textContent = this.KIND_LABEL[it.kind] + ' · ' + it.id;
      this.renderEditorVersions();
      this.renderEditorViews();
      document.getElementById('sb-modal-bg').classList.add('show');
    },

    closeEditor() {
      document.getElementById('sb-modal-bg').classList.remove('show');
      this.editItemId = null;
    },

    renderEditorVersions() {
      const it = this.state.items.find((x) => x.id === this.editItemId);
      const vs = this.state.versions.filter((v) => v.itemId === it.id).sort((a, b) => (a.versionNo || 0) - (b.versionNo || 0));
      const box = document.getElementById('sb-m-versions');
      box.innerHTML = '';
      if (!vs.length) { box.appendChild(this.el(`<span class="sb-muted">还没有任何版本。下次保存时基于自身创建 v1。</span>`)); return; }
      vs.forEach((v) => {
        const c = this.el(`<span class="ver ${v.id === it.currentVersionId ? 'current' : ''}" data-id="${v.id}">v${v.versionNo}${v.id === it.currentVersionId ? ' ★' : ''}</span>`);
        c.onclick = () => {
          this.editParentVersionId = v.id;
          box.querySelectorAll('.ver').forEach((x) => x.classList.toggle('current', x.dataset.id === v.id));
          this.renderEditorViews();
        };
        c.ondblclick = async () => {
          if (!confirm(`把 v${v.versionNo} 设为 current？之后的版本会丢弃。`)) return;
          const r = await this.api('POST', `/api/storyboard/items/${encodeURIComponent(it.id)}/set-current`, { versionId: v.id });
          if (r.ok) {
            Object.assign(it, r.item);
            this.state.versions = this.state.versions.filter((x) => x.itemId !== it.id || (x.versionNo || 0) <= v.versionNo);
            this.renderEditorVersions(); this.renderStrip(); this.renderShots();
            this.toast(`已设为 current（v${v.versionNo} 之后的版本已丢弃）`);
          }
        };
        box.appendChild(c);
      });
      if (!this.editParentVersionId) this.editParentVersionId = it.currentVersionId || vs[vs.length - 1].id;
    },

    renderEditorViews() {
      const it = this.state.items.find((x) => x.id === this.editItemId);
      const parent = this.state.versions.find((v) => v.id === this.editParentVersionId) ||
        this.state.versions.filter((v) => v.itemId === it.id).sort((a, b) => (a.versionNo || 0) - (b.versionNo || 0)).pop();
      const slots = it.kind === 'scene'
        ? [['front', '正/全景'], ['side', '侧/中景'], ['back', '后/逆光']]
        : it.kind === 'prop'
        ? [['front', '正面'], ['side', '侧面'], ['top', '俯视']]
        : [['front', '正视图'], ['side', '侧视图'], ['back', '后视图']];
      const box = document.getElementById('sb-m-views');
      box.innerHTML = '';
      slots.forEach(([view, label]) => {
        const src = parent && parent.sources && parent.sources[view];
        const card = this.el(`
          <div class="view" data-view="${view}">
            <h3>${label}</h3>
            <div class="preview">${src ? `<img src="${this.esc(this.imgUrl(src))}">` : '<span class="sb-muted">无</span>'}</div>
            <div class="actions">
              <button class="sb-btn" data-act="upload">📁 上传</button>
              <button class="sb-btn" data-act="obs">☁️ OBS</button>
              <button class="sb-btn" data-act="auto">✨ 自动</button>
            </div>
            <textarea class="fb" placeholder="改进意见 / 反馈..."></textarea>
          </div>`);
        card._sources = {};
        card.querySelectorAll('button[data-act]').forEach((b) => {
          b.onclick = async () => {
            const act = b.dataset.act;
            if (act === 'upload') {
              const inp = document.createElement('input');
              inp.type = 'file'; inp.accept = 'image/*';
              inp.onchange = async () => {
                const f = inp.files[0]; if (!f) return;
                const fd = new FormData(); fd.append('file', f);
                try {
                  const r = await this.api('POST', '/api/storyboard/upload', fd, true);
                  card._sources[view] = r;
                  card.querySelector('.preview').innerHTML = `<img src="${this.esc(r.url)}">`;
                } catch (e) { this.toast('上传失败：' + e.message, true); }
              };
              inp.click();
            } else if (act === 'obs') {
              // obs.dimond.top has no list endpoint. Master pastes a
              // filename or full URL.
              const hint = (this.state.config && this.state.config.obsEndpoint) || 'http://obs.dimond.top';
              const bucket = (this.state.config && this.state.config.obsBucket) || 'hermit-claw';
              const v = prompt(`输入 OBS 文件名 / 完整 URL（endpoint: ${hint}, bucket: ${bucket}）`);
              if (!v) return;
              const obsKey = /^https?:\/\//i.test(v) ? v : `${bucket}/${v.replace(/^\/+/, '')}`;
              try {
                const d = await this.api('POST', '/api/storyboard/obs/fetch', { obsKey });
                card._sources[view] = d;
                card.querySelector('.preview').innerHTML = `<img src="${this.esc(d.url)}">`;
              } catch (e) { this.toast('OBS 拉取失败：' + e.message, true); }
            } else if (act === 'auto') {
              const prompt = `${it.name}, ${view} view, ${it.theme || ''}, soft light, ASMR`;
              try {
                const r = await this.api('POST', '/api/storyboard/auto-render', { prompt, size: 'square_hd' });
                if (r.ok) {
                  card._sources[view] = r;
                  if (r.url) card.querySelector('.preview').innerHTML = `<img src="${this.esc(r.url)}">`;
                  this.toast('已生成');
                } else this.toast('生成失败：' + r.error, true);
              } catch (e) { this.toast('生成失败：' + e.message, true); }
            }
          };
        });
        box.appendChild(card);
      });
    },
  };
  window.SB = SB;

  // ---- wire UI events ----
  document.querySelectorAll('#sb-tabs .tab').forEach((t) => {
    t.onclick = () => {
      SB.selectedKind = t.dataset.kind;
      SB.selectedItemId = null;
      SB.renderTabs(); SB.renderStrip();
    };
  });

  document.getElementById('sb-add-shot').onclick = async () => {
    if (!SB.state.currentProjectId) { SB.toast('请先选择一个项目', true); return; }
    const r = await SB.api('POST', '/api/storyboard/shots', { projectId: SB.state.currentProjectId });
    SB.state.shots.push(r.shot);
    SB.state.shots.sort((a, b) => (a.index || 0) - (b.index || 0));
    SB.selectedShotId = r.shot.id;
    SB.renderShots();
  };

  document.getElementById('sb-export-btn').onclick = async () => {
    const status = document.getElementById('sb-export-status');
    status.textContent = '生成中…';
    try {
      const r = await SB.api('POST', '/api/storyboard/export-pdf', {
        title: document.getElementById('sb-pdf-title').value || undefined,
        projectId: SB.state.currentProjectId,
      });
      const tag = r.file.projectSlug ? `（项目 ${r.file.projectSlug}）` : '';
      status.textContent = r.file.status + ' · ' + (r.file.obsKey || '本地') + ' ' + tag;
      SB.state.config.exports = [r.file, ...(SB.state.config.exports || [])].slice(0, 50);
      SB.renderExports();
      SB.toast(r.file.status === 'uploaded' ? `已上传 OBS · ${r.file.obsKey}` : '本地已保存（OBS 不可达）');
    } catch (e) { status.textContent = ''; SB.toast('导出失败：' + e.message, true); }
  };

  document.getElementById('sb-proj-add').onclick = async () => {
    const name = prompt('新项目名称：');
    if (!name) return;
    try {
      const r = await SB.api('POST', '/api/storyboard/projects', { name });
      SB.state.projects.push(r.project);
      SB.state.currentProjectId = r.project.id;
      SB.toast(`已创建项目「${r.project.name}」`);
      SB.refresh();
    } catch (e) { SB.toast('创建失败：' + e.message, true); }
  };

  document.getElementById('sb-cfg-btn').onclick = async () => {
    const cfg = SB.state.config || {};
    const ep = prompt('OBS endpoint', cfg.obsEndpoint || 'http://obs.dimond.top');
    if (ep === null) return;
    const bk = prompt('OBS bucket', cfg.obsBucket || 'hermit-claw');
    if (bk === null) return;
    const key = prompt('OBS API key (可选)', cfg.obsApiKey || '');
    if (key === null) return;
    const r = await SB.api('POST', '/api/storyboard/config', { obsEndpoint: ep.trim(), obsBucket: bk.trim(), obsApiKey: key.trim() });
    SB.state.config = r.config;
    SB.toast('OBS 设置已保存');
  };

  document.getElementById('sb-m-cancel').onclick = () => SB.closeEditor();
  document.getElementById('sb-m-save').onclick = async () => {
    const it = SB.state.items.find((x) => x.id === SB.editItemId);
    if (!it) return;
    const nm = document.getElementById('sb-m-name').value.trim() || it.name;
    const th = document.getElementById('sb-m-theme').value.trim() || it.theme;
    if (nm !== it.name || th !== it.theme) {
      try {
        const u = await SB.api('PATCH', `/api/storyboard/items/${encodeURIComponent(it.id)}`, { name: nm, theme: th });
        Object.assign(it, u);
      } catch (_) {}
    }
    const sources = {};
    let feedback = '';
    document.querySelectorAll('#sb-m-views .view').forEach((v) => {
      const view = v.dataset.view;
      if (v._sources && v._sources[view]) sources[view] = v._sources[view];
      const fb = v.querySelector('.fb').value.trim();
      if (fb) feedback += `[${view}] ${fb}\n`;
    });
    try {
      const r = await SB.api('POST', `/api/storyboard/items/${encodeURIComponent(it.id)}/versions`, {
        parentVersionId: SB.editParentVersionId,
        sources,
        feedback,
        prompt: `${it.name} · ${it.theme || ''}`,
        createdBy: 'master',
      });
      if (r.ok) {
        SB.state.versions.push(r.version);
        Object.assign(it, { currentVersionId: r.version.id, versionCount: (it.versionCount || 0) + 1 });
        SB.editParentVersionId = r.version.id;
        SB.renderEditorVersions(); SB.renderEditorViews(); SB.renderStrip();
        SB.toast(`已生成 v${r.version.versionNo}`);
      } else SB.toast('保存失败：' + r.error, true);
    } catch (e) { SB.toast('保存失败：' + e.message, true); }
  };
  document.getElementById('sb-m-delete').onclick = async () => {
    const it = SB.state.items.find((x) => x.id === SB.editItemId);
    if (!it || !confirm(`删除「${it.name}」及其全部版本？`)) return;
    await SB.api('DELETE', `/api/storyboard/items/${encodeURIComponent(it.id)}`);
    SB.state.items = SB.state.items.filter((x) => x.id !== it.id);
    SB.state.versions = SB.state.versions.filter((v) => v.itemId !== it.id);
    SB.renderStrip(); SB.closeEditor();
  };

  // Auto-load when the page becomes active.
  if (typeof refreshPage === 'function') {
    const orig = refreshPage;
    window.refreshPage = function (p) {
      orig(p);
      if (p === 'storyboard') SB.refresh();
    };
  }
})();