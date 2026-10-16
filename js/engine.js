/* ==========================================================================
   engine.js — 阅读引擎
   职责：分页排版、主题渲染、进度追踪、划线定位、逐句朗读高亮
   ========================================================================== */

import * as db from './db.js';

export class Engine {
  constructor(el, opts = {}) {
    this.el = el;                 // 承载正文的元素
    this.book = null;
    this.chapter = 0;             // 当前章节索引
    this.para = 0;                 // 当前段落索引（章内）
    this.page = 0;                 // 当前页（章内）
    this.pageCount = 1;
    this.double = false;           // 双页
    this.listeners = {};
    this._raf = null;
    this._tts = null;
    this.on('progress', () => this._saveProgress());
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return this; }
  emit(evt, ...args) { (this.listeners[evt] || []).forEach(f => f(...args)); }

  /* ------------------------------------------------------------ 打开书 */

  async open(book) {
    this.book = book;
    this.chapter = book.progress?.chapter ?? 0;
    this.para = book.progress?.para ?? 0;
    this.double = (await db.getKV('pageMode', 'single')) === 'double';
    await this.render();
    if (book.progress?.para) this.jumpToPara(this.para, false);
    this.emit('book', book);
  }

  /* ------------------------------------------------------------ 渲染章 */

  async render() {
    const rec = await db.getChapter(this.book.id, this.chapter);
    const content = rec?.html || '<p style="text-align:center;opacity:.5">本章没有内容</p>';
    // 多栏属性放在内层，外层只负责横向滚动
    this.el.innerHTML = `<div class="page-inner">${content}</div>`;
    this.el.classList.add('is-rendering');
    await this.paginate();
    this.el.classList.remove('is-rendering');
    this.emit('rendered');
  }

  /* ------------------------------------------------- 分页（CSS 多栏） */

  /** 实际的横向滚动容器（排版内层） */
  scroller() {
    return this.el.querySelector('.page-inner') || this.el;
  }

  /**
   * 排版容器（.page-inner）同时承载左右留白与多栏排版，并负责横向滚动。
   * 多栏必须作用在可横向滚动的元素上，否则溢出的栏无法被滚动到。
   * 滚动步长需与「栏宽 + 栏间距」精确对齐，否则会出现半截文字。
   */
  getMetrics() {
    const inner = this.scroller();
    const cs = getComputedStyle(inner);
    const colGap = 44;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // 栏宽取「滚动视口宽 - 左右留白」，保证一栏正好占满可视区，
    // 不会出现上一页末尾漏出下一栏开头的情况
    const avail = inner.clientWidth - padL - padR;
    const colW = this.double ? (avail - colGap) / 2 : avail;
    return { colGap, padL, padR, colW, step: colW + colGap, inner };
  }

  async paginate() {
    const { colW, step, padL, padR, inner } = this.getMetrics();
    inner.style.columnWidth = `${colW}px`;
    inner.style.columnGap = `${44}px`;
    inner.style.columnFill = 'auto';
    // 强制回流后再测量，保证拿到最终布局结果
    void inner.offsetHeight;
    const totalW = inner.scrollWidth;
    const contentW = Math.max(0, totalW - padL - padR);
    this.pageCount = Math.max(1, Math.ceil(contentW / step));
    this.page = Math.min(this.page, this.pageCount - 1);
    this.scrollToPage(this.page);
    this.emit('paginated', { pageCount: this.pageCount, page: this.page });
  }

  scrollToPage(p) {
    const { step } = this.getMetrics();
    this._programmatic = true;
    this.scroller().scrollLeft = p * step;
    this.page = p;
  }

  /** 当前处于第几栏（用于对齐判断） */
  currentColumn() {
    const { step } = this.getMetrics();
    return Math.round(this.scroller().scrollLeft / step);
  }

  /* --------------------------------------------------------- 页码导航 */

  nextPage() {
    if (this.page < this.pageCount - 1) {
      // 越界保护：最后一页可能不足一屏，钳制到实际可滚动上限
      const { step } = this.getMetrics();
      const maxLeft = Math.max(0, this.scroller().scrollWidth - this.scroller().clientWidth);
      const target = Math.min((this.page + 1) * step, maxLeft);
      this._programmatic = true;
      this.scroller().scrollLeft = target;
      this.page = Math.min(this.page + 1, this.pageCount - 1);
      this.afterMove();
      return;
    }
    this.nextChapter();
  }

  prevPage() {
    if (this.page > 0) { this.scrollToPage(this.page - 1); this.afterMove(); return; }
    this.prevChapter();
  }

  async nextChapter() {
    if (this.chapter >= this.book.chapterCount - 1) { this.emit('end'); return; }
    this.chapter++; this.para = 0; this.page = 0;
    await this.render();
    this.afterMove();
    this.emit('chapter', this.chapter);
  }

  async prevChapter() {
    if (this.chapter <= 0) return;
    this.chapter--; this.page = 0;
    await this.render();
    this.afterMove();
    this.emit('chapter', this.chapter);
  }

  async goChapter(i) {
    if (i < 0 || i >= this.book.chapterCount) return;
    this.chapter = i; this.page = 0;
    await this.render();
    this.afterMove();
    this.emit('chapter', this.chapter);
  }

  async setDouble(on) {
    this.double = on;
    await db.setKV('pageMode', on ? 'double' : 'single');
    this.para = this.currentPara();
    this.page = 0;
    await this.paginate();
  }

  /** 统一的正文块查询：始终在排版内层里找 */
  blocks() {
    const inner = this.el.querySelector('.page-inner') || this.el;
    return [...inner.querySelectorAll('p, h1, h2, h3, h4, blockquote, li, div[data-para]')];
  }

  /* --------------------------------------------- 段落定位与进度同步 */

  currentPara() {
    const blocks = this.blocks();
    if (!blocks.length) return 0;
    // 块的 offsetLeft 相对滚动容器，内含左留白；视口左边缘即 scrollLeft
    const colStart = this.scroller().scrollLeft;
    let best = 0, bestDist = Infinity;
    blocks.forEach((b, i) => {
      const d = Math.abs(b.offsetLeft - colStart);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  async jumpToPara(idx, record = true) {
    const blocks = this.blocks();
    if (!blocks[idx]) return;
    const { step, padL } = this.getMetrics();
    this._programmatic = true;
    this.scroller().scrollLeft = Math.max(0, blocks[idx].offsetLeft - padL);
    this.page = Math.round(this.scroller().scrollLeft / step);
    this.para = idx;
    if (record) this.emit('progress');
  }

  afterMove() {
    this.para = this.currentPara();
    this.emit('progress');
    this.emit('page', this.page);
  }

  async _saveProgress() {
    if (!this.book) return;
    const total = this.book.chapterCount;
    const ratio = (this.chapter + (this.page + 1) / Math.max(this.pageCount, 1)) / Math.max(total, 1);
    this.readRatio = Math.min(1, Math.max(0, ratio));
    await db.updateProgress(this.book.id, {
      progress: { chapter: this.chapter, para: this.para, page: this.page, updatedAt: Date.now() },
      readRatio: this.readRatio
    });
    this.emit('saved', this.readRatio);
  }

  /* -------------------------------------------------------- 滚动监听 */

  bindScroll() {
    let timer = null;
    // 程序化滚动期间不吸附，避免与翻页逻辑互相打架
    this._programmatic = false;
    this.scroller().addEventListener('scroll', () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        const { step } = this.getMetrics();
        const col = Math.round(this.scroller().scrollLeft / step);
        if (!this._programmatic) {
          // 触控/滚轮造成的滚动：吸附到最近的栏
          const target = col * step;
          if (Math.abs(this.scroller().scrollLeft - target) > 2) {
            this.scroller().scrollLeft = target;
            return;
          }
        } else {
          this._programmatic = false;
        }
        this.page = col;
        this.emit('page', this.page);
        clearTimeout(timer);
        timer = setTimeout(() => this.afterMove(), 220);
      });
    }, { passive: true });
  }

  /* ---------------------------------------------------------- 划线 */

  /** 选区 → 段落定位信息，用于跨渲染稳定回填 */
  resolveSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.commonAncestorContainer)) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    // 找到起点所在块
    let node = range.startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    const blocks = this.blocks();
    const bi = blocks.findIndex(b => b.contains(node));
    if (bi < 0) return null;

    // 块内字符偏移
    const before = range.cloneRange();
    before.selectNodeContents(blocks[bi]);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;

    return {
      chapterIndex: this.chapter,
      paraIdx: bi,
      start,
      end: start + text.length,
      text,
      preview: text.slice(0, 120)
    };
  }

  /** 在正文中回填高亮（不破坏已有 DOM 结构） */
  paintHighlight(note) {
    const blocks = this.blocks();
    const block = blocks[note.paraIdx];
    if (!block) return;
    // 整块命中：直接套层
    if (note.start === 0 && note.end >= block.textContent.length) {
      block.innerHTML = `<mark class="hl" data-note="${note.id}" style="--hl:${note.color || 'yellow'}">${block.innerHTML}</mark>`;
      return;
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let acc = 0, nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (acc + len > note.start && acc < note.end) nodes.push({ node: n, from: Math.max(0, note.start - acc), to: Math.min(len, note.end - acc) });
      acc += len;
    }
    for (const seg of nodes) {
      const range = document.createRange();
      range.setStart(seg.node, seg.from);
      range.setEnd(seg.node, seg.to);
      const mark = document.createElement('mark');
      mark.className = 'hl';
      mark.dataset.note = note.id;
      mark.style.setProperty('--hl', note.color || 'yellow');
      try { range.surroundContents(mark); } catch { mark.appendChild(range.extractContents()); range.insertNode(mark); }
    }
  }

  /** 清除所有高亮标记（保留文本） */
  clearHighlights() {
    this.el.querySelectorAll('mark.hl').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  /** 应用某章的全部笔记 */
  async applyNotes(notes) {
    this.clearHighlights();
    for (const n of notes.filter(x => x.chapterIndex === this.chapter)) this.paintHighlight(n);
  }

  /* ------------------------------------------------------ 全文搜索 */

  async search(keyword, { onHit, limit = 300 } = {}) {
    const kw = keyword.trim();
    if (!kw) return [];
    const lower = kw.toLowerCase();
    const hits = [];
    for (let i = 0; i < this.book.chapterCount; i++) {
      const rec = await db.getChapter(this.book.id, i);
      if (!rec) continue;
      const text = rec.text || rec.html.replace(/<[^>]+>/g, '');
      let idx = text.toLowerCase().indexOf(lower);
      let guard = 0;
      while (idx >= 0 && hits.length < limit && guard++ < 500) {
        hits.push({
          chapterIndex: i,
          chapterTitle: this.book.toc?.find(t => t.index === i)?.label || `第 ${i + 1} 节`,
          snippet: text.slice(Math.max(0, idx - 30), idx + kw.length + 50),
          offset: idx
        });
        idx = text.toLowerCase().indexOf(lower, idx + kw.length);
      }
      if (hits.length >= limit) break;
      onHit && onHit(i, this.book.chapterCount);
    }
    return hits;
  }

  /* ---------------------------------------------------------- 朗读 */

  /**
   * 逐句朗读，句首元素加 .speaking 以实现高亮跟随
   */
  async speak(fromPara = null) {
    if (!('speechSynthesis' in window)) return false;
    this.stopSpeak();
    const rate = (await db.getKV('speechRate', 1)) || 1;
    const start = fromPara ?? this.currentPara();
    const blocks = this.blocks().slice(start);
    const sentences = [];
    for (const b of blocks) {
      const t = b.textContent.trim();
      if (!t) continue;
      for (const s of t.split(/(?<=[。！？；…\n.!?;])\s*/)) {
        if (s.trim()) sentences.push({ text: s.trim(), el: b });
      }
      if (sentences.length > 2000) break;
    }
    if (!sentences.length) return false;

    const voice = pickVoice();
    let i = 0;
    const step = () => {
      if (i >= sentences.length) { this.stopSpeak(); return; }
      const cur = sentences[i];
      const u = new SpeechSynthesisUtterance(cur.text);
      u.lang = 'zh-CN';
      if (voice) u.voice = voice;
      u.rate = rate;
      u.onstart = () => {
        this.el.querySelectorAll('.speaking').forEach(e => e.classList.remove('speaking'));
        cur.el.classList.add('speaking');
        // 跟随滚动：若当前栏已越过该句，则跳到它所在的那一栏
        const { padL, step } = this.getMetrics();
        const target = Math.max(0, cur.el.offsetLeft - padL);
        if (Math.abs(target - this.scroller().scrollLeft) > this.scroller().clientWidth * 0.5) {
          this._programmatic = true;
          this.scroller().scrollLeft = Math.round(target / step) * step;
        }
      };
      u.onend = () => { i++; step(); };
      u.onerror = () => { i++; step(); };
      speechSynthesis.speak(u);
    };
    step();
    this._tts = true;
    this.emit('speak', true);
    return true;
  }

  stopSpeak() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.el?.querySelectorAll('.speaking').forEach(e => e.classList.remove('speaking'));
    this._tts = null;
    this.emit('speak', false);
  }

  /* ------------------------------------------------------ 窗口自适应 */

  bindResize() {
    let t = null;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        if (!this.book) return;
        this.scroller().scrollLeft = 0;
        await this.paginate();
      }, 180);
    });
  }
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices();
  return vs.find(v => /zh[-_]CN|zh[-_]Hans|Chinese/i.test(v.lang + v.name))
      || vs.find(v => /^zh/i.test(v.lang)) || null;
}
