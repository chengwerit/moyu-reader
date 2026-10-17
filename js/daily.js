/* 每日一言：联网自动获取 + 点击换一句 + 断网本地句库兜底
 *
 * 数据源（均为公开、CORS 放行的接口，浏览器可直连）：
 *   DAILY_API  每日一句，当天固定 —— 打开应用时自动拉取
 *   RANDOM_API 随机一言，每次不同 —— 点击句子时拉取
 * 全部失败时回落内置句库，保证任何网络环境下都有动态手感。
 */
const DAILY_API = 'https://api.xygeng.cn/one';
const RANDOM_API = 'https://v.api.aa1.cn/api/yiyan/';
const KEY_QUOTE = 'moyu-quote';
const KEY_DATE = 'moyu-quote-date';
const KEY_HINT = 'moyu-quote-hint-shown';
const NET_TIMEOUT = 6000;

/* 本地兜底句库：断网或接口故障时随机展示 */
const FALLBACK = [
  '读书的目的，不在于占有知识，而在于让知识占有你。',
  '所谓阅读，是把一本书的时间偷过来据为己有。',
  '慢一点读，才能尝出字句里藏着的重量。',
  '书页翻动的声音，是最安静的掌声。',
  '我们读过的书，都会在某个瞬间替我们说话。',
  '真正的远方，是从第一行字开始的地方。',
  '不着急读完，才容易记住。',
  '纸上的灯火，照见比窗外更长的夜。',
  '一本书读完，某个部分的你就留在了书里。',
  '把手机扣在桌上，世界就安静了一半。',
  '读得慢不是缺点，是舍不得快。',
  '好的句子像路标，出现时你正好需要。',
  '书架上没读完的书，是留给未来的自己的信。',
  '深夜读书的人，都在偷偷延长这一天。',
  '一行好字能让人坐下来，坐一整个下午。',
  '合上书的那一刻，故事才真正开始发生。',
  '读过的字不会白读，它们只是来得迟一些。',
  '给一本书半小时，它还你一个安静的自己。',
  '书是随身携带的避难所，也是出口。',
  '读到共鸣处划的线，是自己和自己的暗号。',
  '别人的故事看多了，自己的路就清楚了一点。',
  '一页一页翻过去，时间就有了形状。',
  '读诗不必全懂，被击中一下就够了。',
  '今天读的这几页，是明天某句话的伏笔。'
];

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let current = '';        // 当前显示的句子（用于换句时避开重复）
let currentIsLocal = true; // 当前是否为本地兜底句（断线恢复时决定是否补拉）
let busy = false;        // 防止连点

function pickLocal(avoid) {
  const pool = FALLBACK.filter(q => q !== avoid);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : FALLBACK[0];
}

function render(text, from) {
  const el = $('#dailyQuote');
  const fromEl = $('#dailyQuoteFrom');
  if (!el) return;
  current = text;
  el.textContent = text;           // textContent 赋值，天然防注入
  if (fromEl) fromEl.textContent = from || '';
}

async function getJson(url, ms = NET_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* 每日一句：{code:200, data:{content, origin, ...}} */
async function fetchDaily() {
  const d = (await getJson(DAILY_API))?.data;
  const text = String(d?.content || '').trim();
  if (!text) throw new Error('一言内容为空');
  const origin = String(d?.origin || '').trim();
  return { text, from: origin ? '—— ' + origin : '' };
}

/* 随机一言：返回 <p>句子</p> 片段，剥标签取文本 */
async function fetchRandom() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT);
  try {
    const res = await fetch(RANDOM_API, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const text = (m ? m[1] : html).replace(/<[^>]+>/g, '').trim();
    if (!text) throw new Error('一言内容为空');
    return { text, from: '' };
  } finally { clearTimeout(timer); }
}

function loadCache() {
  try {
    if (localStorage.getItem(KEY_DATE) !== new Date().toDateString()) return null;
    const raw = localStorage.getItem(KEY_QUOTE);
    if (!raw) return null;
    try {
      const q = JSON.parse(raw);
      return q && q.text ? { text: q.text, from: q.from || '' } : null;
    } catch {
      return { text: raw, from: '' };   // 兼容旧版纯文本缓存
    }
  } catch { return null; }
}

function saveCache(q) {
  try {
    localStorage.setItem(KEY_DATE, new Date().toDateString());
    localStorage.setItem(KEY_QUOTE, JSON.stringify(q));
  } catch { /* 隐私模式等场景静默失败，不影响展示 */ }
}

function hintOnce(deps) {
  try {
    if (localStorage.getItem(KEY_HINT)) return;
    localStorage.setItem(KEY_HINT, '1');
  } catch { return; }
  if (deps.toast) deps.toast('每日一言已更新 · 点击句子可换一句');
}

export async function init(deps = {}) {
  const el = $('#dailyQuote');
  if (!el) return;
  el.title = '点击换一句';
  el.addEventListener('click', refresh);

  const cached = loadCache();
  if (cached) {
    currentIsLocal = false;
    render(cached.text, cached.from);
    return;
  }
  if (navigator.onLine === false) {
    currentIsLocal = true;
    render(pickLocal(''), '');
    return;
  }
  try {
    const q = await fetchDaily();
    currentIsLocal = false;
    saveCache(q);
    render(q.text, q.from);
    hintOnce(deps);
  } catch {
    currentIsLocal = true;
    render(pickLocal(''), '');   // 不写缓存，下次打开还会尝试联网
  }

  // 断线恢复：本次没拿到过网络句且今天没有缓存时，补拉一次
  window.addEventListener('online', async () => {
    if (!currentIsLocal || loadCache()) return;
    try {
      const q = await fetchDaily();
      currentIsLocal = false;
      saveCache(q);
      await sleep(0);
      render(q.text, q.from);
    } catch { /* 保持当前本地句 */ }
  });
}

/* 点击换一句：优先联网随机一句，失败回落本地句库 */
export async function refresh() {
  if (busy) return;
  const el = $('#dailyQuote');
  const fromEl = $('#dailyQuoteFrom');
  busy = true;
  if (el) el.classList.add('quote-fade');
  if (fromEl) fromEl.textContent = '寻找中…';
  try {
    let q;
    if (navigator.onLine === false) {
      q = { text: pickLocal(current), from: '当前离线 · 本地句库' };
      currentIsLocal = true;
    } else {
      q = await fetchRandom();
      currentIsLocal = false;
    }
    render(q.text, q.from);
  } catch {
    currentIsLocal = true;
    render(pickLocal(current), '当前离线 · 本地句库');
  } finally {
    busy = false;
    if (el) el.classList.remove('quote-fade');
  }
}
