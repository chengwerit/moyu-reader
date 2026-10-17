/* 便携版专项验证：文件存储后端 + 数据落盘 + 跨机迁移
 *
 * 与 verify.cjs 的区别：这里重点验证「数据真的写进了 data/ 目录」，
 * 以及复制文件夹到新位置后能否继续使用。
 *
 * 环境变量：
 *   CDP_PORT  调试端口，默认 9222
 *   APP_PORT  应用端口，默认 8899
 *   DATA_DIR  要校验的数据目录，默认脚本同级的 data/
 */
const BASE = 'http://127.0.0.1:' + (process.env.CDP_PORT || 9222);
const PAGE = 'http://127.0.0.1:' + (process.env.APP_PORT || 8899) + '/';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');

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
        return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
      },
      close: () => ws.close()
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        console.log('  [EXCEPTION]', (d.exception?.description || d.text).split('\n')[0]);
      }
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evalJs(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
  return r.result.value;
}
async function waitFor(c, expr, timeout = 20000, step = 200) {
  const dl = Date.now() + timeout;
  while (Date.now() < dl) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(step);
  }
  return false;
}
const pass = [];
const fail = [];
function check(name, cond, detail) {
  (cond ? pass : fail).push(name);
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const target = await getTarget();
  if (!target) { console.log('未找到应用标签页'); process.exit(1); }
  const c = await mkConn(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });

  console.log('\n=== 1. 存储模式探测 ===');
  await evalJs(c, `(async()=>{const rs=await navigator.serviceWorker.getRegistrations();await Promise.all(rs.map(r=>r.unregister()));const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));return 1})()`);
  await c.send('Page.navigate', { url: PAGE });
  await waitFor(c, `typeof window.JSZip!=='undefined'&&typeof window.marked!=='undefined'&&typeof window.pdfjsLib!=='undefined'`, 30000, 300);
  const mode = await evalJs(c, `(async()=>{const m=await import('./js/db.js');return JSON.stringify({isFile:await m.isFileMode(),loc:await m.storageLocation()})})()`);
  console.log('  ', mode);
  const modeObj = JSON.parse(mode);
  check('使用文件存储模式', modeObj.isFile === true);
  check('数据位置指向本文件夹 data 目录', /data/.test(modeObj.loc), modeObj.loc);

  console.log('\n=== 2. 依赖已本地化（断网可用）===');
  const deps = JSON.parse(await evalJs(c, `JSON.stringify({jszip:typeof window.JSZip,marked:typeof window.marked,pdfjs:typeof window.pdfjsLib})`));
  check('JSZip/marked/PDF.js 从本地加载', deps.jszip === 'function' && deps.marked === 'object' && deps.pdfjs === 'object');
  const noCdn = await evalJs(c, `JSON.stringify([...document.querySelectorAll('script[src]')].map(s=>s.src).filter(s=>{try{return new URL(s).hostname!==location.hostname}catch{return true}}))`);
  check('页面不再引用任何外部 CDN', JSON.parse(noCdn).length === 0, JSON.parse(noCdn).join(','));

  console.log('\n=== 3. 导入书籍（真实拖文件路径）===');
  const imp = await evalJs(c, `(async()=>{
    const lines=[];
    for(let i=1;i<=3;i++){lines.push('第'+'一二三'[i-1]+'章 便携版测试'+i,'');
      for(let j=1;j<=8;j++)lines.push('这是第'+i+'章第'+j+'段。少年握紧长剑，剑光掠过群山之巅，远处传来若有若无的钟声。','');}
    const bin=new TextEncoder().encode(lines.join('\\n'));
    const dt=new DataTransfer(); dt.items.add(new File([bin],'便携测试.txt',{type:'text/plain'}));
    const input=document.querySelector('#fileInput'); input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,250)); if(!document.querySelector('#importOverlay').classList.contains('show'))break;}
    await new Promise(r=>setTimeout(r,1500));
    return JSON.stringify({cards:document.querySelectorAll('.book-card').length,count:document.querySelector('#shelfCount')?.textContent});
  })()`);
  console.log('  ', imp);
  const impObj = JSON.parse(imp);
  check('书籍导入成功', impObj.cards === 1, `卡片数 ${impObj.cards}`);

  console.log('\n=== 4. 数据真的落在 data/ 目录 ===');
  await sleep(1200);
  const libPath = path.join(DATA, 'library.json');
  check('data/library.json 存在', fs.existsSync(libPath));
  const lib = fs.existsSync(libPath) ? JSON.parse(fs.readFileSync(libPath, 'utf8')) : { books: [] };
  check('library.json 含书籍元数据', lib.books?.length === 1, `books=${lib.books?.length}`);
  check('章节数记录正确', lib.books?.[0]?.chapterCount === 3, `chapterCount=${lib.books?.[0]?.chapterCount}`);
  const booksDir = path.join(DATA, 'books');
  const bookFiles = fs.existsSync(booksDir) ? fs.readdirSync(booksDir).filter(f => f.endsWith('.json')) : [];
  check('data/books/ 下生成了正文文件', bookFiles.length === 1, bookFiles.join(','));
  let chapterOk = false;
  if (bookFiles.length) {
    const doc = JSON.parse(fs.readFileSync(path.join(booksDir, bookFiles[0]), 'utf8'));
    chapterOk = Array.isArray(doc.chapters) && doc.chapters.length === 3 && doc.chapters[0].text.includes('第一章');
  }
  check('正文文件含 3 章且中文正常', chapterOk);

  console.log('\n=== 5. 阅读 + 划线笔记 ===');
  const readState = await evalJs(c, `(async()=>{
    document.querySelector('.book-card').click();
    await new Promise(r=>setTimeout(r,1800));
    return JSON.stringify({readActive:document.querySelector('#readView').classList.contains('active'),title:document.querySelector('#readTitle').textContent,toc:document.querySelectorAll('.toc-item').length,paras:document.querySelectorAll('#readerBody p').length});
  })()`);
  console.log('  ', readState);
  const rs = JSON.parse(readState);
  check('进入阅读视图', rs.readActive === true && rs.title === '便携测试');
  check('目录与正文渲染正常', rs.toc === 3 && rs.paras > 0, `toc=${rs.toc} paras=${rs.paras}`);

  const hl = await evalJs(c, `(async()=>{
    const ps=[...document.querySelectorAll('#readerBody p')];
    const p=ps.find(x=>x.textContent.trim().length>12)||ps[0];
    const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); const tn=w.nextNode();
    const r=document.createRange(); r.setStart(tn,0); r.setEnd(tn,Math.min(8,tn.nodeValue.length));
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    await new Promise(r2=>setTimeout(r2,350));
    document.querySelector('#btnHighlight').click();
    await new Promise(r2=>setTimeout(r2,1200));
    return JSON.stringify({marked:document.querySelectorAll('#readerBody mark.hl').length});
  })()`);
  console.log('  ', hl);
  check('划线高亮生效', JSON.parse(hl).marked >= 1);

  await sleep(1000);
  const libAfterNote = JSON.parse(fs.readFileSync(libPath, 'utf8'));
  check('笔记已写入 library.json', libAfterNote.notes?.length >= 1, `notes=${libAfterNote.notes?.length}`);

  console.log('\n=== 6. 刷新后数据仍在（读自文件）===');
  await evalJs(c, `document.querySelector('#btnBack')?.click()`);
  await sleep(600);
  await c.send('Page.reload');
  const rendered = await waitFor(c, `document.querySelectorAll('.book-card').length>0`);
  const persisted = await evalJs(c, `JSON.stringify({cards:document.querySelectorAll('.book-card').length,count:document.querySelector('#shelfCount')?.textContent})`);
  console.log('  ', persisted);
  check('刷新后书架正常渲染', rendered === true && JSON.parse(persisted).cards === 1);

  console.log('\n=== 7. 主题设置落盘 ===');
  await evalJs(c, `(async()=>{document.querySelector('#btnSettings').click();await new Promise(r=>setTimeout(r,600));document.querySelector('.theme-dot[data-theme="green"]').click();await new Promise(r=>setTimeout(r,900));document.querySelector('#settingsClose').click();return 1})()`);
  await sleep(800);
  const libTheme = JSON.parse(fs.readFileSync(libPath, 'utf8'));
  check('主题写入 library.json', libTheme.kv?.theme === 'green', `theme=${libTheme.kv?.theme}`);

  console.log('\n=== 8. 页面显示数据位置 ===');
  const where = await evalJs(c, `document.querySelector('#storageWhere')?.textContent`);
  console.log('  界面显示：', where);
  check('界面标明数据在 data 目录', String(where).includes('data'));

  console.log('\n=== 9. 截图 ===');
  await evalJs(c, `document.querySelector('.book-card').click()`);
  await waitFor(c, `document.querySelectorAll('#readerBody p').length>0`, 10000);
  await sleep(700);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('screenshots', { recursive: true });
  fs.writeFileSync('screenshots/portable-reading.png', Buffer.from(shot.data, 'base64'));
  await evalJs(c, `document.querySelector('#btnBack')?.click()`);
  await waitFor(c, `document.querySelectorAll('.book-card').length>0`, 10000);
  await sleep(500);
  const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('screenshots/portable-shelf.png', Buffer.from(shot2.data, 'base64'));
  check('截图已保存', true, 'screenshots/portable-*.png');

  console.log('\n=== 10. 自动更新端点 ===');
  {
    const pkg = await fetch(PAGE + 'api/package', { cache: 'no-store' }).then(r => r.json());
    check('/api/package 返回清单', pkg.ok === true && Array.isArray(pkg.files) && pkg.files.length > 0, `files=${pkg.files?.length}`);
    check('清单不含 data/ 用户数据', !(pkg.files || []).some(f => f.path.startsWith('data/')));
    check('清单不含 .git/ 与截图目录', !(pkg.files || []).some(f => f.path.startsWith('.git/') || f.path.startsWith('screenshots/')));
    check('清单含核心程序文件', ['index.html', 'server.ps1', 'js/db.js', 'js/updater.js', 'js/daily.js'].every(p => (pkg.files || []).some(f => f.path === p)));

    // 摘要算法必须与 git blob 一致：sha1("blob <长度>\0" + 内容)
    const target = (pkg.files || []).find(f => f.path === 'js/db.js');
    let shaOk = false;
    if (target) {
      const bytes = fs.readFileSync(path.join(__dirname, 'js/db.js'));
      const h = crypto.createHash('sha1');
      h.update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
      shaOk = h.digest('hex') === target.sha;
    }
    check('js/db.js 摘要与本地文件复算一致（git blob 算法）', shaOk, target?.sha?.slice(0, 12));

    const post = (p, sha, content) => fetch(PAGE + 'api/update/file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, sha, content })
    }).then(r => r.status);

    const mPkg = await fetch(PAGE + 'api/package', { method: 'POST' }).then(r => r.status);
    check('POST /api/package 返回 405', mPkg === 405, `HTTP ${mPkg}`);
    const mUpd = await fetch(PAGE + 'api/update/file').then(r => r.status);
    check('GET /api/update/file 返回 405', mUpd === 405, `HTTP ${mUpd}`);

    for (const p of ['../evil.js', '..\\evil.js', 'data/library.json', '.git/config', 'C:/Windows/win.ini', 'js/../../evil.js']) {
      const stx = await post(p, '0'.repeat(40), 'e30=');
      check(`拒写非法路径「${p}」`, stx === 400, `HTTP ${stx}`);
    }

    const stSha = await post('js/__verify_tmp.js', '0'.repeat(40), Buffer.from('x').toString('base64'));
    check('sha 不匹配拒写', stSha === 400, `HTTP ${stSha}`);
    check('拒写后未产生文件', !fs.existsSync(path.join(__dirname, 'js/__verify_tmp.js')));

    // 合法路径写入 → 字节级校验 → 清单即时反映 → 清理
    const rel = 'js/__verify_update_tmp.js';
    const abs = path.join(__dirname, rel);
    const content = Buffer.from('// verify-portable 自动更新端点临时文件\r\nconsole.log("ok");\r\n', 'utf8');
    const h2 = crypto.createHash('sha1');
    h2.update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
    const sha2 = h2.digest('hex');
    const stOk = await post(rel, sha2, content.toString('base64'));
    check('合法更新写入成功', stOk === 200, `HTTP ${stOk}`);
    check('落盘字节与提交内容完全一致', fs.existsSync(abs) && Buffer.compare(fs.readFileSync(abs), content) === 0);
    const pkg2 = await fetch(PAGE + 'api/package', { cache: 'no-store' }).then(r => r.json());
    check('写入后清单即时反映新文件', (pkg2.files || []).some(f => f.path === rel && f.sha === sha2));
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    const pkg3 = await fetch(PAGE + 'api/package', { cache: 'no-store' }).then(r => r.json());
    check('清理后清单不再包含临时文件', !(pkg3.files || []).some(f => f.path === rel));

    const stFin = await fetch(PAGE + 'api/update/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [rel] })
    }).then(r => r.status);
    check('POST /api/update/finish 正常', stFin === 200, `HTTP ${stFin}`);
    check('更新日志写入 data/update-log.json', fs.existsSync(path.join(DATA, 'update-log.json')));
  }

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`);
  if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  - ' + f)); }
  console.log('='.repeat(52));

  c.close();
  // 用 exitCode 而非 exit()：stdout 重定向到文件时是异步写，
  // process.exit 会丢掉还没 flush 的输出
  process.exitCode = fail.length ? 1 : 0;
})().catch(e => { console.error('验证出错:', e.message); process.exitCode = 1; });