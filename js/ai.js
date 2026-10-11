/* ==========================================================================
   ai.js — AI 伴读（自带 Key 模式）
   兼容任何 OpenAI 格式的接口，请求直接发往用户自己配置的服务，
   不经过任何第三方中转。
   ========================================================================== */

import * as db from './db.js';

const PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' }
];

export function presets() { return PRESETS; }

export async function getConfig() {
  return (await db.getKV('aiConfig', null)) || { baseUrl: '', apiKey: '', model: '' };
}

export async function setConfig(cfg) { await db.setKV('aiConfig', cfg); }
export function isConfigured(cfg) { return !!(cfg?.baseUrl && cfg?.apiKey && cfg?.model); }

/**
 * 流式对话。onDelta(textDelta) 逐段回调。
 */
export async function chat(messages, { onDelta, signal } = {}) {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) throw new Error('请先在设置里填写 AI 接口地址、Key 和模型名');

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.6 }),
    signal
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    throw new Error(`AI 服务返回 ${res.status}${detail ? '：' + detail : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta && onDelta(delta, full); }
      } catch { /* 忽略不完整的分片 */ }
    }
  }
  return full;
}

/** 预置任务：给一段文本一个明确指令 */
export const TASKS = {
  explain: { label: '解释这段', prompt: '请用通俗的语言解释下面这段文字，说明它的含义和背景，不要过度延伸。' },
  summary: { label: '总结要点', prompt: '请把下面这段文字压缩成 3 条以内的要点，用列表输出。' },
  keywords: { label: '提取关键词', prompt: '请提取下面这段文字中的关键词，输出为逗号分隔的列表。' },
  translate: { label: '翻译成英文', prompt: '请把下面这段文字翻译成英文，只输出译文。' },
  continue: { label: '接着往下想', prompt: '请基于下面这段文字，续写一个合理的下一段，保持同样的语气和风格，约 150 字。' }
};

export function systemPrompt(bookTitle) {
  return `你是一位中文阅读助手，正在陪同用户阅读《${bookTitle || '当前书籍'}》。回答要简洁、准确、有条理，直接给结论，不要客套。用户使用中文提问时用中文回答。`;
}
