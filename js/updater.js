/* ==========================================================================
   updater.js — 自动更新
   ----------------------------------------------------------------------------
   通过 启动墨语.bat 打开（本地服务器模式）且联网时，自动连接 GitHub 仓库
   检查新版本，用户确认后下载并交服务器落盘。file:// 直开时没有可写的程序
   目录，本模块自动禁用。

   通道：api.github.com。raw.githubusercontent.com 在国内网络多不通，
   git 协议的 github.com 也不稳，API 域稳定且允许浏览器跨域访问。

   版本判定：内容级比对。服务器按 git blob 算法算出每个程序文件的摘要，
   与远端 git tree 的 blob sha 逐一对比——不依赖版本号簿记，更新中断后
   重跑时已一致的文件自动跳过（自愈合）。

   安全边界（服务端强制）：只写包内相对路径；禁写 data/ 与 .git/；
   落盘前校验 sha；覆盖前备份；临时文件 + 移动原子写入。
   ========================================================================== */

import { isFileMode, getKV, setKV } from './db.js';

const CONFIG = {
  owner: 'chengwerit',
  repo: 'moyu-reader',
  branch: 'main',
  api: 'https://api.github.com',
  autoCheckDelay: 3000,          // 启动后多久做一次静默检查
  minCheckInterval: 6 * 3600e3   // 自动检查最小间隔（6 小时）
};

// 程序核心文件：本地没有但远端有的这类文件会补上下载；
// 文档类文件本地没有则不添加（使用版打包时本就不含它们）
const CORE_RE = /^(index\.html|manifest\.webmanifest|sw\.js|server\.ps1|启动墨语\.bat|css\/|js\/|lib\/)/;

const st = {
  checking: false,
  applying: false,
  diff: null,       // 最近一次检查的差异
  bannerEl: null,
  latestCommit: null
};

let toastFn = (msg, type) => console.log(`[updater:${type || 'info'}]`, msg);

const $ = s => document.querySelector(s);

/* ------------------------------------------------------------ GitHub 通道 */

async function ghFetch(path) {
  const res = await fetch(CONFIG.api + path, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store'
  });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub 接口访问太频繁（未登录每小时 60 次），请稍后再试');
  }
  if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}`);
  return res.json();
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** git blob 摘要：sha1("blob <长度>\0" + 内容)，与 GitHub 算法一致 */
async function blobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const full = new Uint8Array(header.length + bytes.length);
  full.set(header);
  full.set(bytes, header.length);
  const digest = await crypto.subtle.digest('SHA-1', full);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------ 检查与更新 */

/**
 * 检查更新。force=true 跳过冷却时间。
 * 返回 null 表示不适用（非服务器模式 / 冷却中），否则返回差异对象：
 *   { treeSha, toWrite: [{path, sha, size, status}], skipped, extraLocal }
 */
export async function checkUpdates(force = false) {
  if (st.checking) return st.diff;
  if (!(await isFileMode())) return null;
  if (!force) {
    const last = await getKV('update:lastCheckAt', 0);
    if (Date.now() - last < CONFIG.minCheckInterval) return null;
  }
  st.checking = true;
  try {
    const [pkg, tree] = await Promise.all([
      fetch('./api/package', { cache: 'no-store' }).then(r => r.json()),
      ghFetch(`/repos/${CONFIG.owner}/${CONFIG.repo}/git/trees/${CONFIG.branch}?recursive=1`)
    ]);
    // 检查成功才记时间：失败（如断网）不该让下次自动检查等 6 小时
    await setKV('update:lastCheckAt', Date.now());

    const local = new Map((pkg.files || []).map(f => [f.path, f.sha]));
    const remotePaths = new Set();
    const toWrite = [];
    const skipped = [];
    for (const t of tree.tree || []) {
      if (t.type !== 'blob') continue;
      remotePaths.add(t.path);
      const localSha = local.get(t.path);
      if (localSha === t.sha) continue;
      // 本地没有且非核心文件的（文档、脚本等），使用版不强行添加
      if (localSha === undefined && !CORE_RE.test(t.path)) { skipped.push(t.path); continue; }
      toWrite.push({ path: t.path, sha: t.sha, size: t.size || 0, status: localSha === undefined ? 'add' : 'update' });
    }
    // 本地有、远端没有的文件只提示，绝不自动删除（防止误删开发中的文件）
    const extraLocal = [...local.keys()].filter(p => !remotePaths.has(p));
    st.diff = { treeSha: tree.sha, toWrite, skipped, extraLocal };

    if (toWrite.length) {
      // 有更新时才多取一次最新提交信息，用于展示「最近更新」
      try {
        const c = await ghFetch(`/repos/${CONFIG.owner}/${CONFIG.repo}/commits/${CONFIG.branch}`);
        st.latestCommit = {
          message: (c.commit && c.commit.message || '').split('\n')[0],
          date: (c.commit && c.commit.author && c.commit.author.date) || ''
        };
      } catch { st.latestCommit = null; }
    }
    return st.diff;
  } finally {
    st.checking = false;
  }
}

/** 执行更新：逐个下载 blob → 交服务器落盘。返回 { files, needsRestart } */
export async function applyUpdates(diff, onProgress) {
  if (st.applying) throw new Error('更新已在进行中');
  if (!diff || !diff.toWrite.length) return { files: [], needsRestart: false };
  st.applying = true;
  const done = [];
  try {
    for (let i = 0; i < diff.toWrite.length; i++) {
      const f = diff.toWrite[i];
      onProgress && onProgress(i / diff.toWrite.length, f.path);
      const blob = await ghFetch(`/repos/${CONFIG.owner}/${CONFIG.repo}/git/blobs/${f.sha}`);
      if (blob.encoding !== 'base64') throw new Error(`${f.path} 返回内容编码异常`);
      const bytes = base64ToBytes(blob.content);
      // 落盘前本地再验一次摘要，双保险
      if (await blobSha(bytes) !== f.sha) throw new Error(`${f.path} 下载内容校验失败`);
      const res = await fetch('./api/update/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: f.path, sha: f.sha, content: blob.content })
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(`${f.path} 写入失败：${j.error || res.status}`);
      done.push(f.path);
      onProgress && onProgress((i + 1) / diff.toWrite.length, f.path);
    }
    // 收尾日志，失败不影响更新结果
    fetch('./api/update/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: done })
    }).catch(() => {});
    const needsRestart = done.some(p => p === 'server.ps1' || p === '启动墨语.bat');
    st.diff = null;
    return { files: done, needsRestart };
  } finally {
    st.applying = false;
  }
}

/* ------------------------------------------------------------ 界面 */

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 初始化：接线设置区与弹窗，并按设置做一次静默检查 */
export async function init(deps) {
  if (deps && deps.toast) toastFn = deps.toast;
  if (!(await isFileMode())) {
    const el = $('#updateStatus');
    if (el) el.textContent = '网页直开模式没有可更新的程序目录，请用 启动墨语.bat 打开。';
    return;
  }
  wireUi();
  const auto = await getKV('update:auto', true);
  const toggle = $('#autoUpdateToggle');
  if (toggle) toggle.checked = !!auto;
  await refreshStatus();
  if (auto && navigator.onLine) setTimeout(silentCheck, CONFIG.autoCheckDelay);
  window.addEventListener('online', () => silentCheck());
}

/** 供设置弹窗打开时刷新状态行 */
export async function refreshStatus() {
  const el = $('#updateStatus');
  if (!el) return;
  if (st.checking) { el.textContent = '正在检查…'; return; }
  const last = await getKV('update:lastCheckAt', 0);
  const lastText = last
    ? ` · 上次检查 ${new Date(last).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : '';
  el.textContent = (st.diff && st.diff.toWrite.length)
    ? `发现新版本：${st.diff.toWrite.length} 个文件待更新${lastText}`
    : `已是最新版本${lastText}`;
}

function wireUi() {
  $('#btnCheckUpdate').onclick = manualCheck;
  $('#autoUpdateToggle').onchange = async e => {
    await setKV('update:auto', e.target.checked);
    toastFn(e.target.checked ? '已开启自动检查更新' : '已关闭自动检查更新', 'info');
  };
  $('#updateClose').onclick = () => $('#updateModal').classList.remove('show');
  $('#btnUpdateLater').onclick = async () => {
    if (st.diff) await setKV('update:dismissedTree', st.diff.treeSha);
    hideBanner();
    $('#updateModal').classList.remove('show');
  };
  $('#btnUpdateNow').onclick = doUpdate;
}

/** 启动后的静默检查：不打扰，只在有更新时出横幅 */
async function silentCheck() {
  try {
    const diff = await checkUpdates(false);
    if (!diff || !diff.toWrite.length) return;
    const dismissed = await getKV('update:dismissedTree', '');
    if (dismissed === diff.treeSha) return;
    showBanner(diff);
  } catch (e) {
    console.debug('自动检查更新失败（不影响使用）', e);
  }
}

async function manualCheck() {
  const btn = $('#btnCheckUpdate');
  const statusEl = $('#updateStatus');
  btn.disabled = true;
  statusEl.textContent = '正在检查…';
  try {
    const diff = await checkUpdates(true);
    if (!diff) { statusEl.textContent = '当前模式不支持更新'; return; }
    if (!diff.toWrite.length) {
      await refreshStatus();
      toastFn('已是最新版本', 'success');
      return;
    }
    await refreshStatus();
    openModal(diff);
  } catch (e) {
    statusEl.textContent = '检查失败：' + e.message;
    toastFn('检查更新失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function showBanner(diff) {
  hideBanner();
  const el = document.createElement('div');
  el.className = 'update-banner';
  el.innerHTML = `<span class="dot"></span><span>发现新版本（${diff.toWrite.length} 个文件）</span><button type="button">查看并更新</button>`;
  el.querySelector('button').onclick = () => openModal(diff);
  document.body.appendChild(el);
  st.bannerEl = el;
}

function hideBanner() {
  if (st.bannerEl) { st.bannerEl.remove(); st.bannerEl = null; }
}

function openModal(diff) {
  hideBanner();
  $('#updateFileList').innerHTML = diff.toWrite.map(f =>
    `<div class="row"><span class="badge ${f.status}">${f.status === 'add' ? '新增' : '更新'}</span><span class="p">${esc(f.path)}</span><span class="s">${fmtSize(f.size)}</span></div>`
  ).join('');
  const c = st.latestCommit;
  $('#updateSummary').textContent = c
    ? `最近更新：${c.message}${c.date ? '（' + c.date.slice(0, 10) + '）' : ''}`
    : `远端有 ${diff.toWrite.length} 个文件与本地不同。`;
  $('#updateHint').textContent = '更新只替换程序文件，你的书籍、笔记与设置不受影响。';
  $('#updateBar').style.width = '0%';
  const btn = $('#btnUpdateNow');
  btn.disabled = false;
  btn.textContent = '立即更新';
  btn.onclick = doUpdate;
  $('#btnUpdateLater').style.display = '';
  $('#updateModal').classList.add('show');
}

async function doUpdate() {
  const diff = st.diff;
  if (!diff) return;
  const btn = $('#btnUpdateNow');
  btn.disabled = true;
  $('#btnUpdateLater').style.display = 'none';
  btn.textContent = '更新中…';
  $('#updateHint').textContent = '正在下载并写入文件，请勿关闭窗口…';
  try {
    const r = await applyUpdates(diff, (p, path) => {
      $('#updateBar').style.width = (p * 100).toFixed(1) + '%';
      $('#updateSummary').textContent = `正在更新：${path}`;
    });
    $('#updateBar').style.width = '100%';
    $('#updateSummary').textContent = `更新完成（${r.files.length} 个文件）。`;
    await refreshStatus();
    // 清掉 Service Worker 壳层缓存，避免刷新后还是旧文件
    try {
      const rs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map(x => x.unregister()));
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
    } catch {}
    if (r.needsRestart) {
      $('#updateHint').textContent = '服务器程序已更新，请关闭这个黑色窗口，重新双击「启动墨语.bat」后生效。';
      btn.textContent = '完成';
      btn.onclick = () => $('#updateModal').classList.remove('show');
    } else {
      $('#updateHint').textContent = '刷新页面后即可使用新版本。';
      btn.textContent = '刷新页面';
      btn.onclick = () => location.reload();
    }
    btn.disabled = false;
    toastFn(`更新完成，共 ${r.files.length} 个文件`, 'success');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '重试';
    $('#updateHint').textContent = `更新失败：${e.message}。已写入的文件不受影响，可重试继续。`;
    toastFn('更新失败：' + e.message, 'error');
  }
}
