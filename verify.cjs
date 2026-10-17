/* 端到端功能验证（通过 CDP 直连 Edge，无额外依赖）
 *
 * 用法：
 *   1. 启动静态服务：python -m http.server 8899
 *   2. 用调试端口启动 Edge：
 *      "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
 *        --remote-debugging-port=9222 ^
 *        --user-data-dir="%TEMP%\moyu-edge" http://127.0.0.1:8899/
 *   3. node verify.cjs
 *
 * 可用环境变量覆盖：CDP_PORT / APP_PORT
 *
 * 依赖：iconv-lite（仅用于把测试文本转成真正的 GBK 字节）
 *   npm i iconv-lite
 * 未安装时会降级为 UTF-8 测试，编码探测那一项将失去意义。
 */
let iconv = null;
try { iconv = require('iconv-lite'); } catch { console.warn('⚠ 未安装 iconv-lite，编码测试降级为 UTF-8（npm i iconv-lite 可修复）'); }

const BASE = 'http://127.0.0.1:' + (process.env.CDP_PORT || 9222);
const PAGE = 'http://127.0.0.1:' + (process.env.APP_PORT || 8899) + '/';

async function getTarget() {
  const r = await fetch(BASE + '/json/list');
  const list = await r.json();
  return list.find(t => t.type === 'page' && t.url.startsWith(PAGE));
}

let msgId = 0;
function mkConn(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++msgId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close()
    });
    ws.onerror = e => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 轮询等待条件成立，避免固定 sleep 在冷启动（CDN 依赖未缓存）时误判失败 */
async function waitFor(c, expr, timeout = 15000, step = 200) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(step);
  }
  return false;
}

async function evalJs(c, expr) {
  const r = await c.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
  return r.result.value;
}

(async () => {
  const target = await getTarget();
  if (!target) { console.log('未找到应用标签页'); process.exit(1); }
  const c = await mkConn(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');

  // 注销 Service Worker 并清空缓存，确保测的是最新代码
  await evalJs(c, `(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(rs.map(r => r.unregister()));
    const ks = await caches.keys();
    await Promise.all(ks.map(k => caches.delete(k)));
    return 'cleared';
  })()`);
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Page.reload', { ignoreCache: true });

  // 冷启动要等 CDN 依赖（JSZip / marked / PDF.js）加载完，固定 sleep 不够
  const depsReady = await waitFor(c,
    `typeof window.JSZip !== 'undefined' && typeof window.marked !== 'undefined' && typeof window.pdfjsLib !== 'undefined'`,
    30000, 300);
  if (!depsReady) console.log('⚠ 依赖库等待超时（CDN 可能不可达），后续依赖解析的项会失败');

  console.log('=== 0. 关键元素存在性 ===');
  const dom = await evalJs(c, `JSON.stringify({
    fileInput: !!document.querySelector('#fileInput'),
    backupInput: !!document.querySelector('#backupInput'),
    accept: document.querySelector('#fileInput')?.accept?.slice(0, 40)
  })`);
  console.log(dom);

  // 清空旧数据，保证每次验证从干净状态开始
  await evalJs(c, `(async () => {
    await new Promise(r => { const q = indexedDB.deleteDatabase('moyu-reader'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
    return 'cleared';
  })()`);
  await c.send('Page.reload', { ignoreCache: true });
  // reload 后依赖要重新加载（网络缓存已禁用），同样轮询等待
  await waitFor(c,
    `typeof window.JSZip !== 'undefined' && typeof window.marked !== 'undefined' && typeof window.pdfjsLib !== 'undefined'`,
    30000, 300);

  console.log('=== 1. 依赖库加载 ===');
  const deps = await evalJs(c, `JSON.stringify({
    jszip: typeof window.JSZip,
    marked: typeof window.marked,
    pdfjs: typeof window.pdfjsLib
  })`);
  console.log(deps);

  console.log('=== 2. 初始界面状态 ===');
  const init = await evalJs(c, `JSON.stringify({
    shelfActive: document.querySelector('#shelfView').classList.contains('active'),
    readActive: document.querySelector('#readView').classList.contains('active'),
    quote: document.querySelector('#dailyQuote').textContent.slice(0, 20),
    storage: document.querySelector('#storageInfo').textContent,
    emptyShown: !!document.querySelector('.empty')
  })`);
  console.log(init);

  console.log('=== 3. 导入 GBK 中文 TXT 并解析 ===');
  // 浏览器 TextEncoder 只支持 UTF-8，无法生成 GBK 字节。
  // 这里在 Node 侧用 iconv 转成真正的 GBK，再以字节传入页面，
  // 才能真正验证解码器的 GBK/GB18030 探测分支。
  const lines = [];
  for (let c = 1; c <= 3; c++) {
    lines.push('第' + '一二三'[c - 1] + '章测试章节' + c, '');
    for (let i = 1; i <= 8; i++) {
      lines.push(`这是第${c}章第${i}段正文内容。少年握紧手中的长剑，剑光掠过群山之巅，远处传来若有若无的钟声。他知道，从推开这扇门的那一刻起，一切都将不同。他默默记下了这句话。`, '');
    }
  }
  const gbkBytes = iconv ? iconv.encode(lines.join('\n'), 'gbk') : Buffer.from(lines.join('\n'), 'utf8');
  const gbkB64 = Buffer.from(gbkBytes).toString('base64');

  const importResult = await evalJs(c, `(async () => {
    const bin = atob('${gbkB64}');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: 'text/plain' });
    const file = new File([blob], '测试书籍.txt', { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 等待导入完成
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (!document.querySelector('#importOverlay').classList.contains('show')) break;
    }
    await new Promise(r => setTimeout(r, 900));
    const books = await new Promise((resolve, reject) => {
      const req = indexedDB.open('moyu-reader');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('books', 'readonly');
        const all = tx.objectStore('books').getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
    return JSON.stringify(books.map(b => ({
      title: b.title, format: b.format, chapters: b.chapterCount,
      encoding: b.meta?.encoding, toc: b.toc?.length
    })));
  })()`);
  console.log(importResult);

  console.log('=== 4. 章节正文（验证 GBK 解码是否正确）===');
  const chapterText = await evalJs(c, `(async () => {
    const req = indexedDB.open('moyu-reader');
    const db = await new Promise(r => req.onsuccess = () => r(req.result));
    const tx = db.transaction(['books','content'], 'readonly');
    const books = await new Promise(r => { const q = tx.objectStore('books').getAll(); q.onsuccess = () => r(q.result); });
    const id = books[0].id;
    const chs = await new Promise(r => { const q = tx.objectStore('content').index('bookId').getAll(id); q.onsuccess = () => r(q.result); });
    return JSON.stringify({
      chapterCount: chs.length,
      titles: chs.map(c => c.index),
      firstText: chs[0]?.text?.slice(0, 60),
      hasGarble: /[�]/.test(chs.map(c => c.text).join(''))
    });
  })()`);
  console.log(chapterText);

  console.log('=== 5. 打开书籍并进入阅读视图 ===');
  const readState = await evalJs(c, `(async () => {
    const card = document.querySelector('.book-card');
    card.click();
    await new Promise(r => setTimeout(r, 1600));
    return JSON.stringify({
      readActive: document.querySelector('#readView').classList.contains('active'),
      title: document.querySelector('#readTitle').textContent,
      tocItems: document.querySelectorAll('.toc-item').length,
      paragraphs: document.querySelectorAll('#readerBody p').length,
      columnWidth: document.querySelector('#readerBody').style.columnWidth,
      bg: getComputedStyle(document.querySelector('#readerBody')).backgroundColor
    });
  })()`);
  console.log(readState);

  console.log('=== 6. 翻页与分页计算 ===');
  const paging = await evalJs(c, `(async () => {
    const body = document.querySelector('#readerBody');
    const sc = body.querySelector('.page-inner') || body;
    const before = sc.scrollLeft;
    document.querySelector('#btnNext').click();
    await new Promise(r => setTimeout(r, 500));
    const after = sc.scrollLeft;
    document.querySelector('#btnPrev').click();
    await new Promise(r => setTimeout(r, 500));
    return JSON.stringify({
      scrolledForward: after > before,
      from: before, to: after,
      pageIndicator: document.querySelector('#pageIndicator').textContent,
      chapterIndicator: document.querySelector('#chapterIndicator').textContent
    });
  })()`);
  console.log(paging);

  console.log('=== 7. 目录跳转 ===');
  const tocNav = await evalJs(c, `(async () => {
    const items = document.querySelectorAll('.toc-item');
    if (items.length > 1) {
      items[1].click();
      await new Promise(r => setTimeout(r, 900));
    }
    return JSON.stringify({
      tocCount: items.length,
      currentChapter: document.querySelector('#chapterIndicator').textContent
    });
  })()`);
  console.log(tocNav);

  console.log('=== 8. 划线功能 ===');
  const highlight = await evalJs(c, `(async () => {
    // 找到有实际文本的段落，用 TreeWalker 定位首个文本节点
    const ps = [...document.querySelectorAll('#readerBody p')];
    const p = ps.find(x => x.textContent.trim().length > 12) || ps[0];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const tn = walker.nextNode();
    const len = Math.min(8, tn.nodeValue.length);
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, len);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await new Promise(r => setTimeout(r, 350));
    const selected = sel.toString();
    document.querySelector('#btnHighlight').click();
    await new Promise(r => setTimeout(r, 800));
    const req = indexedDB.open('moyu-reader');
    const db = await new Promise(r => req.onsuccess = () => r(req.result));
    const tx = db.transaction('notes', 'readonly');
    const notes = await new Promise(r => { const q = tx.objectStore('notes').getAll(); q.onsuccess = () => r(q.result); });
    return JSON.stringify({
      selectedText: selected,
      markedInDom: document.querySelectorAll('#readerBody mark.hl').length,
      noteCount: notes.length,
      sample: notes[0] ? { text: notes[0].text, paraIdx: notes[0].paraIdx, chapterIndex: notes[0].chapterIndex } : null
    });
  })()`);
  console.log(highlight);

  console.log('=== 9. 全文搜索 ===');
  const search = await evalJs(c, `(async () => {
    document.querySelector('[data-panel="search"]').click();
    await new Promise(r => setTimeout(r, 400));
    const inp = document.querySelector('#searchInput');
    inp.value = '钟声';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1800));
    return JSON.stringify({
      hits: document.querySelectorAll('.hit').length,
      countLabel: document.querySelector('.search-count')?.textContent,
      firstHit: document.querySelector('.hit-text')?.textContent?.slice(0, 50)
    });
  })()`);
  console.log(search);

  console.log('=== 10. 主题切换 ===');
  const theme = await evalJs(c, `(async () => {
    document.querySelector('.panel-close')?.click();
    document.querySelector('#btnSettings').click();
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('.theme-dot[data-theme="night"]').click();
    await new Promise(r => setTimeout(r, 500));
    return JSON.stringify({
      modalShown: document.querySelector('#settingsModal').classList.contains('show'),
      theme: document.documentElement.dataset.theme,
      paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
    });
  })()`);
  console.log(theme);

  console.log('=== 11. 数据持久化（刷新后仍在）===');
  await evalJs(c, `document.querySelector('#settingsClose').click()`);
  await c.send('Page.reload');
  // 等书架真正渲染完成，而不是死等固定时长——首次访问要等 CDN 依赖，冷启动明显更慢
  const ready = await waitFor(c, `document.querySelectorAll('.book-card').length > 0`);
  if (!ready) console.log('⚠ 等待书架渲染超时，下面结果可能不完整');
  const persisted = await evalJs(c, `JSON.stringify({
    cards: document.querySelectorAll('.book-card').length,
    count: document.querySelector('#shelfCount').textContent,
    theme: document.documentElement.dataset.theme
  })`);
  console.log(persisted);

  console.log('=== 12. 截图 ===');
  await evalJs(c, `document.querySelector('.book-card')?.click()`);
  await waitFor(c, `document.querySelector('#readView').classList.contains('active') && document.querySelectorAll('#readerBody p').length > 0`, 10000);
  await sleep(600);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  require('fs').mkdirSync('screenshots', { recursive: true });
  require('fs').writeFileSync('screenshots/reading.png', Buffer.from(shot.data, 'base64'));
  console.log('阅读界面截图已保存到 screenshots/reading.png');

  await evalJs(c, `document.querySelector('#btnBack')?.click()`);
  await waitFor(c, `document.querySelector('#shelfView').classList.contains('active') && document.querySelectorAll('.book-card').length > 0`, 10000);
  await sleep(500);
  const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('screenshots/shelf.png', Buffer.from(shot2.data, 'base64'));
  console.log('书架界面截图已保存到 screenshots/shelf.png');

  console.log('\n全部验证步骤执行完毕');
  c.close();
  // 用 exitCode 而非 exit()：stdout 重定向到文件时是异步写，
  // process.exit 会丢掉还没 flush 的输出
  process.exitCode = 0;
})().catch(e => { console.error('验证出错:', e.message); process.exitCode = 1; });
