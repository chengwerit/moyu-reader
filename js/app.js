/* ==========================================================================
   app.js — 界面逻辑：书架、阅读、目录、搜索、笔记、AI、设置
   ========================================================================== */

import * as db from './db.js';
import { parseBook, htmlToText } from './parsers.js';
import { Engine } from './engine.js';
import * as AI from './ai.js';
import * as updater from './updater.js';
import * as daily from './daily.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const state = {
  view: 'shelf',
  books: [],
  current: null,
  notes: [],
  bookmarks: [],
  searchHits: [],
  panel: null
};

let engine = null;

/* ================================================================ 启动 */

init();

async function init() {
  try {
    engine = new Engine($('#readerBody'));
    engine.bindScroll();
    engine.bindResize();
    bindEvents();
    daily.init({ toast }).catch(e => console.warn('每日一言初始化失败', e));
    await applySettings();
    await refreshShelf();
    await updateStorageInfo();
    registerSW();
    // 自动更新模块：只在服务器模式下真正工作，内部自行容错，不影响启动
    window.__updater = updater;
    updater.init({ toast }).catch(e => console.warn('更新模块初始化失败', e));
  } catch (e) {
    console.error('初始化失败', e);
    toast('初始化时出现问题：' + e.message, 'error');
  }
}

function registerSW() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/* ============================================================== 主题 */

const THEMES = {
  paper:   { name: '宣纸', bg: '#f5f0e6', fg: '#33302a', accent: '#8a6a4a' },
  white:   { name: '素白', bg: '#ffffff', fg: '#1f2328', accent: '#4a6fa5' },
  green:   { name: '护眼', bg: '#c8e6c9', fg: '#2b3a2e', accent: '#4a7c59' },
  night:   { name: '夜间', bg: '#16181d', fg: '#c9ccd4', accent: '#8aa4c8' },
  gray:    { name: '雅灰', bg: '#e8e8e6', fg: '#2a2a28', accent: '#5f5e5a' }
};

async function applySettings() {
  const theme = await db.getKV('theme', 'paper');
  const font = await db.getKV('fontFamily', 'serif');
  const size = await db.getKV('fontSize', 19);
  const lh = await db.getKV('lineHeight', 1.9);
  setTheme(theme);
  $('#fontSelect').value = font;
  $('#fontSize').value = size;
  $('#lineHeight').value = lh;
  applyFont(font, size, lh);
  updateFontLabel();
}

function setTheme(key) {
  const t = THEMES[key] || THEMES.paper;
  const r = document.documentElement;
  r.style.setProperty('--paper', t.bg);
  r.style.setProperty('--ink', t.fg);
  r.style.setProperty('--accent', t.accent);
  r.dataset.theme = key;
  // 深色主题下界面外壳同步压暗
  r.classList.toggle('is-dark', key === 'night');
  $$('.theme-dot').forEach(d => d.classList.toggle('on', d.dataset.theme === key));
}

function applyFont(family, size, lh) {
  const map = { serif: "'Noto Serif SC','Source Han Serif SC','Songti SC',SimSun,serif",
                sans: "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
                kai: "'Kaiti SC',KaiTi,STKaiti,serif" };
  $('#readerBody').style.fontFamily = map[family] || map.serif;
  $('#readerBody').style.fontSize = size + 'px';
  $('#readerBody').style.lineHeight = lh;
  $('#readerBody').classList.toggle('paged', true);
}

function updateFontLabel() {
  const map = { serif: '宋体', sans: '黑体', kai: '楷体' };
  $('#fontLabel').textContent = map[$('#fontSelect').value] || '宋体';
  $('#fontSizeLabel').textContent = $('#fontSize').value + 'px';
}

/* ============================================================== 书架 */

async function refreshShelf() {
  state.books = await db.allBooks();
  renderShelf();
}

function renderShelf() {
  const grid = $('#shelfGrid');
  if (!state.books.length) {
    grid.innerHTML = `<div class="empty">
      <div class="empty-art">书</div>
      <h3>书架还是空的</h3>
      <p>把 EPUB、PDF、TXT、Markdown、DOCX、FB2、MOBI 等文件拖进来即可开始阅读。<br>所有内容保存在你自己的浏览器里。</p>
      <button class="btn primary" id="emptyPick">选择文件</button>
    </div>`;
    $('#emptyPick').onclick = () => $('#fileInput').click();
    return;
  }

  const q = $('#shelfSearch').value.trim().toLowerCase();
  const filter = $('#shelfFilter').value;
  let list = state.books;
  if (q) list = list.filter(b => (b.title + ' ' + (b.author || '')).toLowerCase().includes(q));
  if (filter === 'reading') list = list.filter(b => b.readRatio > 0.01 && b.readRatio < 0.99);
  else if (filter === 'done') list = list.filter(b => b.readRatio >= 0.99);
  else if (filter === 'unread') list = list.filter(b => !b.lastRead);

  grid.className = 'shelf-grid' + (filter === 'list' ? ' as-list' : '');
  grid.innerHTML = list.map(b => {
    const pct = Math.round((b.readRatio || 0) * 100);
    return `<article class="book-card ${b.pinned ? 'pinned' : ''}" data-id="${b.id}">
      <div class="book-cover">
        ${b.cover ? `<img src="${b.cover}" alt="">` : `<div class="cover-fallback"><span>${escapeHtml((b.title || '?').slice(0, 2))}</span></div>`}
        <div class="cover-actions">
          <button class="icon-btn" data-act="pin" data-id="${b.id}" title="${b.pinned ? '取消置顶' : '置顶'}">${b.pinned ? '★' : '☆'}</button>
          <button class="icon-btn" data-act="del" data-id="${b.id}" title="删除">✕</button>
        </div>
        <div class="cover-progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="book-info">
        <h4 title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</h4>
        <p class="book-author">${escapeHtml(b.author || '佚名')}</p>
        <div class="book-meta">
          <span class="tag">${b.format}</span>
          <span class="tag">${b.chapterCount} 章</span>
          ${pct > 1 ? `<span class="tag read">已读 ${pct}%</span>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------------------------------- 导入书籍 */

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const box = $('#importOverlay');
  const bar = $('#importBar');
  const label = $('#importLabel');
  box.classList.add('show');
  let ok = 0, fail = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    label.textContent = `正在解析 ${f.name}`;
    bar.style.width = `${(i / files.length) * 100}%`;
    await new Promise(r => setTimeout(r, 16));
    try {
      const parsed = await parseBook(f);
      if (!parsed.chapters.length) throw new Error('没有解析到正文内容');
      const id = uid();
      const book = {
        id,
        title: parsed.title || f.name,
        author: parsed.author || '',
        cover: parsed.cover || null,
        format: parsed.format,
        fileName: f.name,
        size: f.size,
        addedAt: Date.now(),
        lastRead: 0,
        readRatio: 0,
        pinned: false,
        chapterCount: parsed.chapters.length,
        toc: parsed.toc || [],
        meta: parsed.meta || {}
      };
      await db.putBook(book);
      await db.putChapters(id, parsed.chapters, p => { bar.style.width = `${((i + p) / files.length) * 100}%`; });
      ok++;
    } catch (e) {
      fail++;
      console.error(f.name, e);
      toast(`《${f.name}》导入失败：${e.message}`, 'error');
    }
  }
  bar.style.width = '100%';
  box.classList.remove('show');
  await refreshShelf();
  await updateStorageInfo();
  if (ok) toast(`成功导入 ${ok} 本书${fail ? `，${fail} 本失败` : ''}`, 'success');
}

async function updateStorageInfo() {
  const s = await db.stats();
  const u = await db.usage();
  $('#shelfCount').textContent = `${s.books} 本书 · ${s.chapters} 章 · ${s.notes} 条笔记`;
  if (u) {
    const mb = u.used / 1048576;
    const used = mb < 1 ? `${Math.max(1, Math.round(u.used / 1024))} KB` : `${mb.toFixed(1)} MB`;
    const quota = u.quota ? (u.quota / 1048576 / 1024).toFixed(1) + ' GB' : '未知';
    $('#storageInfo').textContent = `已占用 ${used} / 可用 ${quota}`;
  }
  // 明确告诉用户数据实际落在哪，避免"以为在文件夹里其实在浏览器里"的误解
  const loc = await db.storageLocation();
  $('#storageWhere').textContent = loc;
}

/* ============================================================== 阅读 */

async function openBook(id) {
  const book = await db.getBook(id);
  if (!book) return;
  state.current = book;
  state.notes = await db.notesOf(id);
  state.bookmarks = await db.bookmarksOf(id);

  $('#shelfView').classList.remove('active');
  $('#readView').classList.add('active');
  state.view = 'read';
  document.body.classList.add('reading');

  $('#readTitle').textContent = book.title;
  $('#readAuthor').textContent = book.author || '';
  renderToc();

  await engine.open(book);
  await engine.applyNotes(state.notes);
  updateProgressUi();
  loadAiHistory();
}

async function closeBook() {
  // 书架状态下返回键也可能被触发，此时没有当前书，直接安全退出
  if (!state.current) return;
  engine.stopSpeak();
  await db.updateProgress(state.current.id, { lastRead: Date.now() });
  state.current = null;
  $('#readView').classList.remove('active');
  $('#shelfView').classList.add('active');
  document.body.classList.remove('reading');
  closePanel();
  state.view = 'shelf';
  await refreshShelf();
  await updateStorageInfo();
}

function updateProgressUi() {
  const r = engine.readRatio ?? ((engine.chapter + 0.001) / engine.book.chapterCount);
  $('#readProgress').style.width = (r * 100).toFixed(2) + '%';
  $('#pageIndicator').textContent = engine.pageCount > 1
    ? `${engine.page + 1} / ${engine.pageCount}`
    : `${Math.round(r * 100)}%`;
  const cur = engine.book.toc?.find(t => t.index === engine.chapter);
  $('#chapterIndicator').textContent = cur?.label || engine.book.title;
}

function renderToc() {
  const toc = state.current.toc || [];
  const list = $('#tocList');
  if (!toc.length) {
    list.innerHTML = `<div class="panel-empty">这本书没有目录结构，直接顺序阅读即可。</div>`;
    return;
  }
  list.innerHTML = toc.map(t => {
    const idx = t.index ?? 0;
    return `<a class="toc-item d${Math.min(t.depth || 0, 3)} ${idx === engine.chapter ? 'on' : ''}" data-idx="${idx}">${escapeHtml(t.label)}</a>`;
  }).join('');
}

/* ============================================================== 面板 */

function openPanel(name) {
  state.panel = name;
  $('#tocPanel').classList.toggle('open', name === 'toc');
  $('#notesPanel').classList.toggle('open', name === 'notes');
  $('#aiPanel').classList.toggle('open', name === 'ai');
  $('#searchPanel').classList.toggle('open', name === 'search');
  $$('.tool-btn').forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  if (name === 'notes') renderNotes();
  if (name === 'toc') {
    $$('.toc-item').forEach(a => a.classList.toggle('on', +a.dataset.idx === engine.chapter));
    const on = $('.toc-item.on');
    on && on.scrollIntoView({ block: 'center' });
  }
  if (name === 'search') setTimeout(() => $('#searchInput').focus(), 60);
}

function closePanel() {
  state.panel = null;
  $$('.panel').forEach(p => p.classList.remove('open'));
  $$('.tool-btn').forEach(b => b.classList.remove('on'));
}

function togglePanel(name) { state.panel === name ? closePanel() : openPanel(name); }

/* ------------------------------------------------------------- 笔记 */

function renderNotes() {
  const box = $('#notesList');
  if (!state.notes.length && !state.bookmarks.length) {
    box.innerHTML = `<div class="panel-empty">选中正文里的句子即可划线并写下想法。</div>`;
    return;
  }
  const noteHtml = state.notes.map(n => `<div class="note-item" data-id="${n.id}">
      <blockquote>${escapeHtml(n.text)}</blockquote>
      ${n.note ? `<p class="note-body">${escapeHtml(n.note)}</p>` : ''}
      <div class="note-foot">
        <span>${n.chapterTitle || ''}</span>
        <span class="dot">·</span>
        <button data-note-edit="${n.id}">${n.note ? '编辑' : '写笔记'}</button>
        <button data-note-del="${n.id}">删除</button>
      </div>
    </div>`).join('');
  const bmHtml = state.bookmarks.map(b => `<div class="note-item bm" data-id="${b.id}">
      <div class="bm-title">${escapeHtml(b.chapterTitle || '书签')}</div>
      <div class="bm-snippet">${escapeHtml(b.snippet || '')}</div>
      <div class="note-foot"><button data-bm-del="${b.id}">移除</button></div>
    </div>`).join('');
  box.innerHTML = (bmHtml ? `<h5 class="panel-sub">书签 · ${state.bookmarks.length}</h5>${bmHtml}` : '')
                 + (noteHtml ? `<h5 class="panel-sub">划线与笔记 · ${state.notes.length}</h5>${noteHtml}` : '');
}

async function addHighlight() {
  const info = engine.resolveSelection();
  if (!info) { toast('请先选中一段文字', 'warn'); return; }
  const note = await db.addNote({
    bookId: state.current.id,
    ...info,
    chapterTitle: engine.book.toc?.find(t => t.index === info.chapterIndex)?.label || '',
    color: 'yellow',
    note: ''
  });
  state.notes.push(note);
  engine.paintHighlight(note);
  window.getSelection().removeAllRanges();
  toast('已划线，可以在左侧写笔记', 'success');
  openPanel('notes');
  renderNotes();
}

async function deleteNote(id) {
  await db.removeNote(id);
  state.notes = state.notes.filter(n => n.id !== id);
  engine.clearHighlights();
  await engine.applyNotes(state.notes);
  renderNotes();
  await updateStorageInfo();
}

async function toggleBookmark() {
  const para = engine.currentPara();
  const rec = await db.getChapter(state.current.id, engine.chapter);
  const blocks = engine.blocks();
  const snippet = (blocks[para]?.textContent || '').trim().slice(0, 60);
  const exist = state.bookmarks.find(b => b.chapterIndex === engine.chapter && b.paraIdx === para);
  if (exist) {
    await db.removeBookmark(exist.id);
    state.bookmarks = state.bookmarks.filter(b => b.id !== exist.id);
    toast('已移除书签', 'info');
  } else {
    const bm = await db.addBookmark({
      bookId: state.current.id, chapterIndex: engine.chapter, paraIdx: para,
      chapterTitle: engine.book.toc?.find(t => t.index === engine.chapter)?.label || '',
      snippet
    });
    state.bookmarks.push(bm);
    toast('已添加书签', 'success');
  }
  renderNotes();
}

/* ============================================================== 搜索 */

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 320);
}

async function runSearch() {
  const kw = $('#searchInput').value.trim();
  const box = $('#searchResults');
  if (!kw) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="panel-empty">搜索中…</div>';
  const hits = await engine.search(kw);
  state.searchHits = hits;
  if (!hits.length) { box.innerHTML = `<div class="panel-empty">没有找到「${escapeHtml(kw)}」</div>`; return; }
  box.innerHTML = `<div class="search-count">共 ${hits.length} 处</div>` + hits.map((h, i) =>
    `<div class="hit" data-i="${i}">
      <div class="hit-chapter">${escapeHtml(h.chapterTitle)}</div>
      <div class="hit-text">…${escapeHtml(h.snippet)}…</div>
    </div>`).join('');
}

async function gotoHit(i) {
  const h = state.searchHits[i];
  if (!h) return;
  await engine.goChapter(h.chapterIndex);
  await engine.applyNotes(state.notes);
  // 滚动到匹配位置
  const blocks = engine.blocks();
  let acc = 0, target = null;
  for (const b of blocks) {
    const len = b.textContent.length;
    if (h.offset >= acc && h.offset < acc + len) { target = b; break; }
    acc += len;
  }
  if (target) {
    const { padL, step } = engine.getMetrics();
    const sc = engine.scroller();
    engine._programmatic = true;
    sc.scrollLeft = Math.max(0, target.offsetLeft - padL);
    engine.page = Math.round(sc.scrollLeft / step);
    target.classList.add('hit-flash');
    setTimeout(() => target.classList.remove('hit-flash'), 1800);
  }
  closePanel();
}

/* ================================================================ AI */

let aiHistory = [];

async function loadAiHistory() {
  aiHistory = (await db.getKV(`aiHistory:${state.current.id}`, [])) || [];
  renderAi();
}

async function saveAiHistory() {
  await db.setKV(`aiHistory:${state.current.id}`, aiHistory.slice(-40));
}

function renderAi() {
  const box = $('#aiMessages');
  if (!aiHistory.length) {
    box.innerHTML = `<div class="panel-empty">选中正文里的句子，配合下面的任务按钮提问。<br>所有请求直接发往你自己配置的 AI 服务。</div>`;
    return;
  }
  box.innerHTML = aiHistory.map(m => `<div class="msg ${m.role}">
      <div class="msg-role">${m.role === 'user' ? '我' : 'AI 伴读'}</div>
      <div class="msg-body">${formatAiText(m.content)}</div>
    </div>`).join('');
  box.scrollTop = box.scrollHeight;
}

function formatAiText(t) {
  return escapeHtml(t)
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,4}\s*(.+)$/gm, '<h5>$1</h5>')
    .replace(/^[-*]\s*(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\n/g, '<br/>');
}

async function askAi(task = null, extra = '') {
  if (!AI.isConfigured(await AI.getConfig())) { openSettings(); toast('请先配置 AI 接口', 'warn'); return; }
  const sel = window.getSelection()?.toString().trim();
  const input = $('#aiInput').value.trim();
  const question = extra || input || (sel ? '这段话是什么意思？' : '帮我梳理一下这一章讲了什么。');
  if (!question) return;

  const context = sel ? `\n\n【选中的原文】\n${sel.slice(0, 2000)}` : '';
  const prompt = task ? `${AI.TASKS[task].prompt}${context}` : `${question}${context}`;

  aiHistory.push({ role: 'user', content: prompt });
  $('#aiInput').value = '';
  renderAi();

  const msg = { role: 'assistant', content: '' };
  aiHistory.push(msg);
  renderAi();
  const node = $('#aiMessages .msg:last-child .msg-body');
  const ctrl = new AbortController();
  window.__aiAbort = ctrl;

  try {
    await AI.chat([
      { role: 'system', content: AI.systemPrompt(state.current.title) },
      ...aiHistory.slice(-9, -1).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: prompt }
    ], {
      signal: ctrl.signal,
      onDelta: (_, full) => { node.innerHTML = formatAiText(full) + '<span class="cursor"></span>'; $('#aiMessages').scrollTop = $('#aiMessages').scrollHeight; }
    });
  } catch (e) {
    msg.content = msg.content || `⚠️ ${e.message}`;
  } finally {
    node.innerHTML = formatAiText(msg.content);
    await saveAiHistory();
  }
}

function stopAi() {
  window.__aiAbort?.abort();
  window.__aiAbort = null;
}

async function aiFixPage() {
  const rec = await db.getChapter(state.current.id, engine.chapter);
  const text = (rec?.text || '').slice(0, 6000);
  if (!text) { toast('本章没有可修正的文本', 'warn'); return; }
  await askAi(null, `请找出下面原文中的错别字、明显乱码或 OCR 错误，输出修正后的完整文本。如果原文没有错误，就直接说“未发现明显错误”。\n\n${text}`);
}

/* ============================================================== 设置 */

async function openSettings() {
  updater.refreshStatus().catch(() => {});
  const cfg = await AI.getConfig();
  $('#aiBaseUrl').value = cfg.baseUrl || '';
  $('#aiApiKey').value = cfg.apiKey || '';
  $('#aiModel').value = cfg.model || '';
  $('#aiPreset').value = '';

  // 展示数据实际存放位置，并在检测到旧版浏览器数据时给出迁移入口
  const loc = await db.storageLocation();
  const hint = $('#storageLocationHint');
  if (hint) {
    hint.innerHTML = await db.isFileMode()
      ? `书籍、笔记与设置保存在本文件夹的 <code>data</code> 目录。<br>当前实际路径：<br><code>${escapeHtml(loc)}</code>`
      : `当前以网页方式打开，数据存在本机浏览器里（<code>${escapeHtml(loc)}</code>）。<br>用 <code>启动墨语.bat</code> 打开即可改为保存在文件夹中，换电脑时直接复制整个文件夹。`;
  }
  const legacy = await db.detectLegacyData();
  const box = $('#migrateBox');
  if (box) box.style.display = legacy ? 'block' : 'none';
  if (legacy) state.legacy = legacy;

  $('#settingsModal').classList.add('show');
}

async function doMigrate() {
  const legacy = state.legacy || await db.detectLegacyData();
  if (!legacy) { toast('没有可迁移的旧数据', 'warn'); return; }
  const btn = $('#btnMigrate');
  btn.disabled = true;
  try {
    const n = await db.migrateLegacy(legacy);
    toast(`已迁移 ${n} 本书到本文件夹`, 'success');
    $('#migrateBox').style.display = 'none';
    await refreshShelf();
    await updateStorageInfo();
  } catch (e) {
    toast('迁移失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function saveAiConfig() {
  await AI.setConfig({
    baseUrl: $('#aiBaseUrl').value.trim(),
    apiKey: $('#aiApiKey').value.trim(),
    model: $('#aiModel').value.trim()
  });
  toast('AI 配置已保存到本地', 'success');
}

async function testAi() {
  const cfg = { baseUrl: $('#aiBaseUrl').value.trim(), apiKey: $('#aiApiKey').value.trim(), model: $('#aiModel').value.trim() };
  if (!AI.isConfigured(cfg)) { toast('请填写完整的接口信息', 'warn'); return; }
  const btn = $('#btnTestAi');
  btn.disabled = true; btn.textContent = '测试中…';
  await AI.setConfig(cfg);
  try {
    const r = await AI.chat([
      { role: 'system', content: '只回复两个字：正常' },
      { role: 'user', content: '测试' }
    ], {});
    toast('连接成功：' + r.trim().slice(0, 30), 'success');
  } catch (e) { toast('连接失败：' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '测试连接'; }
}

async function exportBackup() {
  toast('正在打包…');
  const payload = await db.exportAll(p => { $('#backupBar').style.width = (p * 100) + '%'; });
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `墨语备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('#backupBar').style.width = '0%';
  toast(`已导出 ${payload.books.length} 本书`, 'success');
}

async function importBackup(file) {
  try {
    const payload = JSON.parse(await file.text());
    const n = await db.importAll(payload, p => { $('#backupBar').style.width = (p * 100) + '%'; });
    $('#backupBar').style.width = '0%';
    await applySettings();
    await refreshShelf();
    await updateStorageInfo();
    toast(`已恢复 ${n} 本书`, 'success');
  } catch (e) { toast('恢复失败：' + e.message, 'error'); }
}

async function requestPersist() {
  if (!navigator.storage?.persist) { toast('当前浏览器不支持持久化', 'warn'); return; }
  const ok = await navigator.storage.persist();
  toast(ok ? '已申请持久化存储，数据不会被自动清理' : '浏览器未授予持久化权限', ok ? 'success' : 'warn');
}

/* ============================================================== 提示 */

let toastTimer = null;
function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast', 3400);
}

/* ============================================================== 事件 */

function bindEvents() {
  /* 导入 */
  $('#fileInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#btnImportEmpty').onclick = () => $('#fileInput').click();
  $('#btnRestore').onclick = () => $('#backupInput').click();
  $('#backupInput').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

  /* 拖拽导入 */
  let dragDepth = 0;
  document.addEventListener('dragenter', e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++; $('#dropZone').classList.add('show');
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropZone').classList.remove('show'); } });
  document.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('#dropZone').classList.remove('show');
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  /* 书架 */
  $('#shelfSearch').addEventListener('input', renderShelf);
  $('#shelfFilter').addEventListener('change', renderShelf);
  $('#shelfGrid').addEventListener('click', async e => {
    const card = e.target.closest('.book-card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.dataset.act;
    if (act === 'del') {
      const b = state.books.find(x => x.id === id);
      if (!confirm(`确定从书架移除《${b.title}》？\n书籍正文、笔记和书签会一并删除，此操作不可撤销。`)) return;
      await db.deleteBook(id);
      await refreshShelf(); await updateStorageInfo();
      toast('已移除', 'info');
      return;
    }
    if (act === 'pin') {
      const b = await db.getBook(id);
      await db.putBook({ ...b, pinned: !b.pinned });
      await refreshShelf();
      return;
    }
    openBook(id);
  });
  $('#shelfGrid').addEventListener('contextmenu', async e => {
    const card = e.target.closest('.book-card');
    if (!card) return;
    e.preventDefault();
    const b = await db.getBook(card.dataset.id);
    await db.putBook({ ...b, read: !b.read });
    await refreshShelf();
  });

  /* 阅读 */
  $('#btnBack').onclick = closeBook;
  $('#btnPrev').onclick = () => { engine.prevPage(); updateProgressUi(); };
  $('#btnNext').onclick = () => { engine.nextPage(); updateProgressUi(); };
  $('#btnHighlight').onclick = addHighlight;
  $('#btnBookmark').onclick = toggleBookmark;
  $('#btnSpeak').onclick = () => {
    engine._tts ? engine.stopSpeak() : (engine.speak(), toast('开始朗读，点击停止', 'info'));
  };
  $('#btnZen').onclick = () => document.body.classList.toggle('zen');
  $('#btnDouble').onclick = async () => {
    const on = !engine.double;
    await engine.setDouble(on);
    $('#btnDouble').classList.toggle('on', on);
  };
  $('#btnDouble').classList.toggle('on', engine.double);

  $$('.tool-btn[data-panel]').forEach(b => b.onclick = () => togglePanel(b.dataset.panel));
  $$('.panel-close').forEach(b => b.onclick = closePanel);

  $('#tocList').addEventListener('click', async e => {
    const item = e.target.closest('.toc-item');
    if (!item) return;
    await engine.goChapter(+item.dataset.idx);
    await engine.applyNotes(state.notes);
    updateProgressUi();
    if (window.innerWidth < 900) closePanel();
  });

  $('#searchInput').addEventListener('input', onSearchInput);
  $('#searchResults').addEventListener('click', e => {
    const hit = e.target.closest('.hit');
    if (hit) gotoHit(+hit.dataset.i);
  });

  $('#notesList').addEventListener('click', async e => {
    const del = e.target.dataset.noteDel;
    if (del) return deleteNote(del);
    const bdel = e.target.dataset.bmDel;
    if (bdel) {
      await db.removeBookmark(bdel);
      state.bookmarks = state.bookmarks.filter(b => b.id !== bdel);
      renderNotes();
      return;
    }
    const edit = e.target.dataset.noteEdit;
    if (edit) {
      const n = state.notes.find(x => x.id === edit);
      const v = prompt('写下你的想法：', n.note || '');
      if (v === null) return;
      await db.updateNote(edit, { note: v });
      n.note = v;
      renderNotes();
    }
  });

  /* 引擎事件 */
  engine.on('progress', () => { updateProgressUi(); renderToc(); });
  engine.on('page', () => updateProgressUi());
  engine.on('speak', on => $('#btnSpeak').classList.toggle('on', on));
  engine.on('chapter', () => { renderToc(); });

  /* AI */
  $('#aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAi(); }
  });
  $('#aiSend').onclick = () => askAi();
  $('#aiStop').onclick = stopAi;
  $$('[data-task]').forEach(b => b.onclick = () => askAi(b.dataset.task));
  $('#btnFix').onclick = aiFixPage;
  $('#btnClearAi').onclick = async () => { aiHistory = []; await saveAiHistory(); renderAi(); };

  /* 设置 */
  $('#btnSettings').onclick = openSettings;
  $('#settingsClose').onclick = () => $('#settingsModal').classList.remove('show');
  $('#settingsModal').addEventListener('click', e => {
    if (e.target.id === 'settingsModal') e.currentTarget.classList.remove('show');
  });
  $$('.theme-dot').forEach(d => d.onclick = async () => {
    await db.setKV('theme', d.dataset.theme);
    setTheme(d.dataset.theme);
    if (state.current) { await engine.paginate(); }
  });
  $('#fontSelect').onchange = e => { db.setKV('fontFamily', e.target.value); applyFont(e.target.value, +$('#fontSize').value, +$('#lineHeight').value); updateFontLabel(); engine.paginate(); };
  $('#fontSize').oninput = e => { db.setKV('fontSize', e.target.value); applyFont($('#fontSelect').value, +e.target.value, +$('#lineHeight').value); updateFontLabel(); };
  $('#fontSize').onchange = () => engine.paginate();
  $('#lineHeight').oninput = e => { db.setKV('lineHeight', e.target.value); applyFont($('#fontSelect').value, +$('#fontSize').value, e.target.value); };
  $('#lineHeight').onchange = () => engine.paginate();

  $('#aiPreset').onchange = e => {
    const p = AI.presets().find(x => x.name === e.target.value);
    if (!p) return;
    $('#aiBaseUrl').value = p.baseUrl;
    $('#aiModel').value = p.model;
    $('#aiApiKey').focus();
  };
  $('#btnSaveAi').onclick = saveAiConfig;
  $('#btnTestAi').onclick = testAi;
  $('#btnExport').onclick = exportBackup;
  $('#btnPersist').onclick = requestPersist;
  $('#btnMigrate').onclick = doMigrate;

  /* 键盘 */
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (state.view !== 'read') return;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ': e.preventDefault(); engine.nextPage(); updateProgressUi(); break;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); engine.prevPage(); updateProgressUi(); break;
      case 'ArrowDown': e.preventDefault(); engine.scrollBy({ top: 80, behavior: 'smooth' }); break;
      case 'ArrowUp': e.preventDefault(); engine.scrollBy({ top: -80, behavior: 'smooth' }); break;
      case 'Escape': closePanel(); document.body.classList.remove('zen'); break;
      case 'f': case 'F': openPanel('search'); break;
      case 't': case 'T': openPanel('toc'); break;
      case 'n': case 'N': openPanel('notes'); break;
      case 'a': case 'A': openPanel('ai'); break;
      case 'z': case 'Z': document.body.classList.toggle('zen'); break;
    }
  });

  /* 点击正文空白处收起选区气泡 */
  $('#readerBody').addEventListener('mouseup', () => setTimeout(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) showSelBubble(sel);
    else hideSelBubble();
  }, 10));

  window.addEventListener('resize', () => {
    if (window.innerWidth < 900 && state.panel) closePanel();
  });
}

/* ------------------------------------------------------- 选中气泡 */

async function highlightAndWriteNote() {
  await addHighlight();
  const id = state.notes[state.notes.length - 1]?.id;
  if (!id) return;
  const v = prompt('写下你的想法：', '');
  if (v === null) return;
  await db.updateNote(id, { note: v });
  const n = state.notes.find(x => x.id === id);
  if (n) n.note = v;
  renderNotes();
}

let bubbleEl = null;
function showSelBubble(sel) {
  hideSelBubble();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  bubbleEl = document.createElement('div');
  bubbleEl.className = 'sel-bubble';
  bubbleEl.innerHTML = `<button data-b="hl">划线</button><button data-b="note">写笔记</button><button data-b="ai">问 AI</button><button data-b="copy">复制</button>`;
  document.body.appendChild(bubbleEl);
  const top = Math.max(10, rect.top - 46);
  bubbleEl.style.top = top + 'px';
  bubbleEl.style.left = Math.min(window.innerWidth - bubbleEl.offsetWidth - 12, Math.max(12, rect.left + rect.width / 2 - bubbleEl.offsetWidth / 2)) + 'px';
  bubbleEl.onclick = (e) => {
    const b = e.target.dataset.b;
    if (b === 'hl') addHighlight();
    else if (b === 'note') highlightAndWriteNote();
    else if (b === 'ai') { openPanel('ai'); setTimeout(() => askAi(null, '解释一下这段话'), 120); }
    else if (b === 'copy') { navigator.clipboard.writeText(sel.toString()); toast('已复制', 'success'); }
    hideSelBubble();
  };
}
function hideSelBubble() { bubbleEl?.remove(); bubbleEl = null; }
