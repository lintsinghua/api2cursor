#!/usr/bin/env node
// api2cursor (https://github.com/lintsinghua/api2cursor): 让 Cursor 通过 "Override OpenAI Base URL" 使用中转站 / 第三方模型
// 零依赖，只用 Node 内置模块。Node >= 18。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const argVal = (k) => { const i = ARGV.indexOf(k); return i >= 0 ? ARGV[i + 1] : undefined; };
const CONFIG_PATH = path.resolve(argVal('--config') || process.env.RELAY_CONFIG || path.join(DIR, 'config.json'));
const DEBUG = process.env.RELAY_DEBUG === '1';
const FORMATS = ['openai', 'openai-responses', 'anthropic', 'gemini', 'azure'];
const FORMAT_ALIASES = { ollama: 'openai', lmstudio: 'openai', 'openai-compatible': 'openai', compatible: 'openai', responses: 'openai-responses', claude: 'anthropic', google: 'gemini', 'azure-openai': 'azure' };
const EFFORT_RE = /^(.+)-(minimal|low|medium|high|xhigh)$/;

const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const now = () => new Date().toISOString();
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

// ---------------------------------------------------------------- config
let cfg;
let generatedPassword = null;
let runtimePort;

function normFormat(f) { f = String(f || 'openai').toLowerCase().trim(); return FORMAT_ALIASES[f] || f; }
function toList(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  return [];
}
function normHeaders(h) {
  const out = {};
  if (typeof h === 'string') {
    for (const line of h.split('\n')) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  } else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) if (k.trim()) out[k.trim()] = String(v);
  return out;
}
function normUpstream(u) {
  return {
    name: String(u.name || 'default').trim(),
    enabled: u.enabled !== false,
    format: normFormat(u.format),
    base_url: String(u.base_url || '').trim(),
    api_key: String(u.api_key || ''),
    api_key_env: String(u.api_key_env || ''),
    headers: normHeaders(u.headers),
    models: toList(u.models),
    fallback: toList(u.fallback),
    api_version: u.api_version ? String(u.api_version) : '',
    key_in_query: !!u.key_in_query,
    timeout_ms: Number(u.timeout_ms) || 0,
  };
}
function normModels(m) {
  const out = {};
  if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) {
    if (!k.trim()) continue;
    if (typeof v === 'string') out[k.trim()] = { upstream: '', model: v };
    else if (v && typeof v === 'object') out[k.trim()] = { upstream: String(v.upstream || ''), model: String(v.model || k) };
  }
  return out;
}
function hashPassword(pw) { const salt = rid(16); return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`; }
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function checkPassword(pw, stored) {
  if (process.env.ADMIN_PASSWORD) return safeEq(pw, process.env.ADMIN_PASSWORD);
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), salt, 32), Buffer.from(hash, 'hex'));
}

function loadConfig() {
  let raw = {}, existed = false;
  if (fs.existsSync(CONFIG_PATH)) {
    existed = true;
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { console.error(`配置文件解析失败 ${CONFIG_PATH}: ${e.message}`); process.exit(1); }
  }
  const c = {
    host: raw.host || '127.0.0.1',
    port: Number(raw.port) || 8787,
    proxy_token: raw.proxy_token || '',
    model_prefix: raw.model_prefix ?? 'relay-',
    admin_password_hash: raw.admin_password_hash || '',
    admin_remote: !!raw.admin_remote,
    timeout_ms: Number(raw.timeout_ms) || 120000,
    models: normModels(raw.models),
    upstreams: (raw.upstreams || []).map(normUpstream),
  };
  let dirty = !existed;
  if (raw.admin_password && !raw.admin_password_hash) { c.admin_password_hash = hashPassword(String(raw.admin_password)); dirty = true; }
  if (process.env.PORT) c.port = Number(process.env.PORT);
  if (process.env.HOST) c.host = process.env.HOST;
  if (process.env.PROXY_TOKEN) c.proxy_token = process.env.PROXY_TOKEN;
  if (process.env.MODEL_PREFIX !== undefined) c.model_prefix = process.env.MODEL_PREFIX;
  if (argVal('--port')) c.port = Number(argVal('--port'));
  if (process.env.RELAY_BASE_URL) {
    const envUp = normUpstream({
      name: 'env', format: process.env.RELAY_FORMAT || 'openai', base_url: process.env.RELAY_BASE_URL,
      api_key_env: 'RELAY_API_KEY', models: process.env.RELAY_MODELS || '',
    });
    const i = c.upstreams.findIndex(u => u.name === 'env');
    if (i >= 0) c.upstreams[i] = { ...c.upstreams[i], format: envUp.format, base_url: envUp.base_url, api_key_env: 'RELAY_API_KEY', models: envUp.models.length ? envUp.models : c.upstreams[i].models };
    else c.upstreams.unshift(envUp);
    dirty = true;
  }
  if (!c.proxy_token) { c.proxy_token = 'cr-' + rid(24); dirty = true; }
  if (!c.admin_password_hash && !process.env.ADMIN_PASSWORD) {
    generatedPassword = rid(8);
    c.admin_password_hash = hashPassword(generatedPassword); dirty = true;
  }
  cfg = c;
  if (dirty) saveConfig();
}
function saveConfig() {
  const out = { ...cfg };
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { }
}
function upstreamKey(u) {
  if (u.api_key.startsWith('env:')) return process.env[u.api_key.slice(4)] || '';
  return u.api_key || (u.api_key_env ? process.env[u.api_key_env] || '' : '');
}
const enabledUps = () => cfg.upstreams.filter(u => u.enabled);
const findUp = (n) => cfg.upstreams.find(u => u.name === n);

// ---------------------------------------------------------------- model lists & routing
const modelCache = new Map(); // name -> {t, list}
function knownModels(u) { return u.models.length ? u.models : (modelCache.get(u.name)?.list || []); }
const supportsEffort = (u) => ['openai', 'openai-responses', 'azure'].includes(u.format);

function resolveRoute(requested, forceUpstream) {
  let name = String(requested || '');
  if (cfg.model_prefix && name.startsWith(cfg.model_prefix)) name = name.slice(cfg.model_prefix.length);
  if (forceUpstream) {
    const u = findUp(forceUpstream); if (!u) return null;
    const m = EFFORT_RE.exec(name);
    if (m && supportsEffort(u) && !knownModels(u).includes(name)) return { u, model: m[1], effort: m[2], display: name };
    return { u, model: name, display: name };
  }
  const tryName = (n, depth = 0) => {
    const alias = cfg.models[n];
    if (alias && depth < 3) {
      const u = alias.upstream ? findUp(alias.upstream) : null;
      if (u && u.enabled) return { u, model: alias.model || n };
      const r = alias.model && alias.model !== n ? tryName(alias.model, depth + 1) : null;
      if (r) return r;
      const d = enabledUps()[0]; if (d) return { u: d, model: alias.model || n };
    }
    const i = n.indexOf('/');
    if (i > 0) { const u = findUp(n.slice(0, i)); if (u && u.enabled) return { u, model: n.slice(i + 1) }; }
    for (const u of enabledUps()) if (knownModels(u).includes(n)) return { u, model: n };
    return null;
  };
  let r = tryName(name), effort;
  if (!r) {
    const m = EFFORT_RE.exec(name);
    if (m) { const r2 = tryName(m[1]); if (r2 && supportsEffort(r2.u)) { r = r2; effort = m[2]; } }
  }
  if (!r) {
    const u = enabledUps()[0]; if (!u) return null;
    let model = name; const m = EFFORT_RE.exec(name);
    if (m && u.format === 'openai-responses') { model = m[1]; effort = m[2]; }
    r = { u, model };
  }
  return { ...r, effort, display: name };
}

// ---------------------------------------------------------------- upstream HTTP
function doRequest(urlStr, { method = 'POST', headers = {}, body, timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch { return reject(new Error('base_url 无效: ' + urlStr)); }
    const lib = url.protocol === 'https:' ? https : http;
    const h = { ...headers, 'accept-encoding': 'identity' };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = lib.request(url, { method, headers: h });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`等待上游响应超时 (${timeout}ms)`), { code: 'ETIMEOUT' })), timeout);
    req.on('response', res => { clearTimeout(timer); resolve(res); });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (signal) {
      if (signal.aborted) req.destroy(new Error('client closed'));
      else signal.addEventListener('abort', () => req.destroy(new Error('client closed')), { once: true });
    }
    if (body != null) req.write(body);
    req.end();
  });
}
function readAll(stream, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    stream.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); stream.destroy(); } else chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}
const DEFAULT_BASE = { openai: 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', azure: '' };
// base_url 规则：openai 系只写域名时补 /v1，写了路径(/v1、/api/paas/v4…)原样用；
// anthropic 与官方 SDK 一致：不以 /v1 结尾就补 /v1；gemini 不以 /v1beta 或 /v1 结尾就补 /v1beta
function upBase(u) {
  let b = (u.base_url || DEFAULT_BASE[u.format] || '').replace(/\/+$/, '');
  if (u.format === 'anthropic') return /\/v1$/.test(b) ? b : b + '/v1';
  if (u.format === 'gemini') return /\/v1(beta)?$/.test(b) ? b : b + '/v1beta';
  if (u.format === 'azure') return b;
  try { const p = new URL(b).pathname; if (!p || p === '/') b += '/v1'; } catch { }
  return b;
}
function azureIsV1(u) { return /\/openai\/v1$/.test(u.base_url.replace(/\/+$/, '')); }
function authHeaders(u) {
  const key = upstreamKey(u), h = {};
  if (u.format === 'anthropic') { if (key) h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01'; }
  else if (u.format === 'gemini') { if (key) h['x-goog-api-key'] = key; }
  else if (u.format === 'azure') { if (key) h['api-key'] = key; }
  else if (key) h.authorization = `Bearer ${key}`;
  return { ...h, ...u.headers };
}

async function fetchModels(u, force = false) {
  const c = modelCache.get(u.name);
  if (!force && c && Date.now() - c.t < 5 * 60e3) return c.list;
  const base = upBase(u); let url;
  if (u.format === 'openai' || u.format === 'openai-responses') url = base + '/models';
  else if (u.format === 'anthropic') url = base + '/models?limit=1000';
  else if (u.format === 'gemini') url = base + '/models?pageSize=1000' + (u.key_in_query && upstreamKey(u) ? '&key=' + encodeURIComponent(upstreamKey(u)) : '');
  else if (u.format === 'azure' && azureIsV1(u)) url = base + '/models';
  else throw new Error('Azure 经典部署接口无法列出模型，请在 models 中手动填写 deployment 名');
  const res = await doRequest(url, { method: 'GET', headers: { accept: 'application/json', ...authHeaders(u) }, timeout: 15000 });
  const text = await readAll(res);
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}: ${String(errMessage(text)).slice(0, 300)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('上游返回的不是 JSON'); }
  let list;
  if (u.format === 'gemini') list = (j.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
  else list = (j.data || j.models || []).map(m => typeof m === 'string' ? m : (m.id || m.name || m.model)).filter(Boolean);
  list = [...new Set(list)];
  modelCache.set(u.name, { t: Date.now(), list });
  return list;
}
async function listModelIds() {
  const out = new Map();
  for (const k of Object.keys(cfg.models)) out.set(cfg.model_prefix + k, 'alias');
  const lists = await Promise.all(enabledUps().map(async u => u.models.length ? u.models : fetchModels(u).catch(e => { if (DEBUG) log('fetch models failed', u.name, e.message); return []; })));
  enabledUps().forEach((u, i) => { for (const m of lists[i] || []) { const id = cfg.model_prefix + m; if (!out.has(id)) out.set(id, u.name); } });
  return [...out.entries()].map(([id, owned_by]) => ({ id, object: 'model', created: 0, owned_by }));
}

// ---------------------------------------------------------------- shared helpers for translation
function errMessage(text) {
  try {
    const j = JSON.parse(text); const e = Array.isArray(j) ? j[0]?.error : j.error;
    return (typeof e === 'string' ? e : e?.message) || j.message || j.detail || text;
  } catch { return text || ''; }
}
function partsOf(c) {
  if (c == null) return [];
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
  if (Array.isArray(c)) return c.map(p => typeof p === 'string' ? { type: 'text', text: p } : p).filter(Boolean);
  return [];
}
function textOf(c) { return partsOf(c).filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text || '').join(''); }
function toolText(c) { if (typeof c === 'string') return c; if (Array.isArray(c)) return textOf(c); return c == null ? '' : JSON.stringify(c); }
function imgUrl(p) { return typeof p.image_url === 'string' ? p.image_url : p.image_url?.url || ''; }
function parseDataUrl(u) {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(u || '');
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', data: m[3] ? m[4] : Buffer.from(decodeURIComponent(m[4])).toString('base64') };
}
function guessMime(url) { const e = (url.split('?')[0].split('.').pop() || '').toLowerCase(); return { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[e] || 'image/jpeg'; }
function safeJson(s) {
  if (s && typeof s === 'object') return s;
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }; } catch { return { _raw: String(s) }; }
}
function prep(r) {
  const msgs = (r.messages || []).map(m => {
    if (m.role === 'function') return { role: 'tool', tool_call_id: m.name, name: m.name, content: m.content };
    if (m.function_call && !m.tool_calls) return { ...m, tool_calls: [{ id: m.function_call.name, type: 'function', function: m.function_call }] };
    return m;
  });
  const tools = (r.tools || (r.functions || []).map(f => ({ type: 'function', function: f }))).filter(t => t && (t.type === 'function' || !t.type) && t.function);
  let tc = r.tool_choice;
  if (tc === undefined && r.function_call) tc = typeof r.function_call === 'string' ? r.function_call : { type: 'function', function: { name: r.function_call.name } };
  return { msgs, tools, toolChoice: tc, maxTokens: r.max_completion_tokens ?? r.max_tokens, stop: r.stop == null ? [] : [].concat(r.stop).filter(Boolean) };
}
const mkUsage = (p, c, extra) => ({ prompt_tokens: p || 0, completion_tokens: c || 0, total_tokens: (p || 0) + (c || 0), ...extra });
function chunk(ctx, delta, finish = null) {
  return { id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] };
}
function completion(ctx, message, finish, usage) {
  return { id: ctx.id, object: 'chat.completion', created: ctx.created, model: ctx.model, choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], usage: usage || undefined };
}

// ---------------------------------------------------------------- anthropic
const ANTH_FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'content_filter' };
function anthUsage(u = {}) { const p = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); return mkUsage(p, u.output_tokens, u.cache_read_input_tokens ? { prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens } } : undefined); }
function toAnthropic(r, model) {
  const P = prep(r), system = [], out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: [...blocks] });
  };
  for (const m of P.msgs) {
    if (m.role === 'system' || m.role === 'developer') { const t = textOf(m.content); if (t) system.push({ type: 'text', text: t }); continue; }
    if (m.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: toolText(m.content) || '(empty)' }]); continue; }
    const blocks = [];
    for (const p of partsOf(m.content)) {
      if (p.type === 'text' || p.type === 'input_text') { if (p.text) blocks.push({ type: 'text', text: p.text }); }
      else if (p.type === 'image_url') { const u = imgUrl(p), d = parseDataUrl(u); blocks.push(d ? { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } } : { type: 'image', source: { type: 'url', url: u } }); }
    }
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeJson(tc.function?.arguments) });
      push('assistant', blocks);
    } else push('user', blocks);
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
  const body = { model, max_tokens: P.maxTokens || 8192, messages: out };
  if (system.length) body.system = system;
  if (P.stop.length) body.stop_sequences = P.stop;
  if (r.temperature != null) body.temperature = Math.min(1, r.temperature);
  else if (r.top_p != null) body.top_p = r.top_p;
  if (P.tools.length && P.toolChoice !== 'none') {
    body.tools = P.tools.map(t => ({ name: t.function.name, description: t.function.description || undefined, input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    const tc = P.toolChoice;
    if (tc === 'required') body.tool_choice = { type: 'any' };
    else if (tc && typeof tc === 'object' && tc.function?.name) body.tool_choice = { type: 'tool', name: tc.function.name };
    else if (tc === 'auto') body.tool_choice = { type: 'auto' };
    if (r.parallel_tool_calls === false) body.tool_choice = { ...(body.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true };
  }
  if (r.stream) body.stream = true;
  return body;
}
function fromAnthropic(j, ctx) {
  let text = '', reasoning = ''; const tcs = [];
  for (const b of j.content || []) {
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'thinking') reasoning += b.thinking || '';
    else if (b.type === 'tool_use') tcs.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const msg = { role: 'assistant', content: text || (tcs.length ? null : '') };
  if (tcs.length) msg.tool_calls = tcs;
  if (reasoning) msg.reasoning_content = reasoning;
  ctx.usage = anthUsage(j.usage);
  return completion(ctx, msg, ANTH_FINISH[j.stop_reason] || (tcs.length ? 'tool_calls' : 'stop'), ctx.usage);
}
function anthStreamer(ctx, emit) {
  const blocks = {}; let tIdx = 0, usageIn = {}, outTok = 0;
  return (ev, d) => {
    switch (d.type) {
      case 'message_start': usageIn = d.message?.usage || {}; outTok = usageIn.output_tokens || 0; ctx.usage = anthUsage({ ...usageIn, output_tokens: outTok }); break;
      case 'content_block_start': {
        const b = d.content_block || {};
        if (b.type === 'tool_use') {
          const i = tIdx++; blocks[d.index] = i; ctx.hadTools = true;
          emit(chunk(ctx, { tool_calls: [{ index: i, id: b.id, type: 'function', function: { name: b.name, arguments: '' } }] }));
          if (b.input && Object.keys(b.input).length) emit(chunk(ctx, { tool_calls: [{ index: i, function: { arguments: JSON.stringify(b.input) } }] }));
        } else if (b.type === 'text' && b.text) emit(chunk(ctx, { content: b.text }));
        break;
      }
      case 'content_block_delta': {
        const dl = d.delta || {};
        if (dl.type === 'text_delta') emit(chunk(ctx, { content: dl.text }));
        else if (dl.type === 'input_json_delta') { const i = blocks[d.index]; if (i != null && dl.partial_json) emit(chunk(ctx, { tool_calls: [{ index: i, function: { arguments: dl.partial_json } }] })); }
        else if (dl.type === 'thinking_delta') emit(chunk(ctx, { reasoning_content: dl.thinking }));
        break;
      }
      case 'message_delta':
        if (d.usage?.output_tokens != null) outTok = d.usage.output_tokens;
        if (d.usage?.input_tokens) usageIn = { ...usageIn, ...d.usage };
        if (d.delta?.stop_reason) ctx.finish = ANTH_FINISH[d.delta.stop_reason] || 'stop';
        ctx.usage = anthUsage({ ...usageIn, output_tokens: outTok });
        break;
      case 'error': ctx.error = { message: d.error?.message || 'upstream error', type: d.error?.type || 'upstream_error' }; break;
    }
  };
}

// ---------------------------------------------------------------- openai responses
function toResponses(r, model, effort) {
  const P = prep(r), input = [];
  for (const m of P.msgs) {
    if (m.role === 'system' || m.role === 'developer') { const t = textOf(m.content); if (t) input.push({ role: m.role, content: t }); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: toolText(m.content) }); continue; }
    if (m.role === 'assistant') {
      const t = textOf(m.content); if (t) input.push({ role: 'assistant', content: t });
      for (const tc of m.tool_calls || []) { const a = tc.function?.arguments; input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: typeof a === 'string' ? a : JSON.stringify(a ?? {}) }); }
      continue;
    }
    const parts = partsOf(m.content).map(p => p.type === 'text' ? { type: 'input_text', text: p.text } : p.type === 'image_url' ? { type: 'input_image', image_url: imgUrl(p), detail: p.image_url?.detail || 'auto' } : null).filter(Boolean);
    if (parts.length) input.push({ role: 'user', content: parts });
  }
  const body = { model, input, store: false };
  if (r.stream) body.stream = true;
  if (P.maxTokens) body.max_output_tokens = Math.max(16, P.maxTokens);
  if (r.temperature != null) body.temperature = r.temperature;
  if (r.top_p != null) body.top_p = r.top_p;
  if (P.tools.length) body.tools = P.tools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description || undefined, parameters: t.function.parameters || { type: 'object', properties: {} }, strict: false }));
  const tc = P.toolChoice;
  if (typeof tc === 'string') body.tool_choice = tc;
  else if (tc?.function?.name) body.tool_choice = { type: 'function', name: tc.function.name };
  if (r.parallel_tool_calls != null) body.parallel_tool_calls = r.parallel_tool_calls;
  const eff = effort || r.reasoning_effort;
  if (eff) body.reasoning = { effort: eff };
  return body;
}
function respFinish(resp, hadTools) {
  if (resp?.status === 'incomplete') return resp.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'content_filter';
  return hadTools ? 'tool_calls' : 'stop';
}
const respUsage = (u = {}) => mkUsage(u.input_tokens, u.output_tokens, u.output_tokens_details?.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: u.output_tokens_details.reasoning_tokens } } : undefined);
function fromResponses(j, ctx) {
  let text = '', reasoning = ''; const tcs = [];
  for (const it of j.output || []) {
    if (it.type === 'message') for (const c of it.content || []) { if (c.type === 'output_text') text += c.text || ''; else if (c.type === 'refusal') text += c.refusal || ''; }
    else if (it.type === 'function_call') tcs.push({ id: it.call_id || it.id, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } });
    else if (it.type === 'reasoning') reasoning += (it.summary || []).map(s => s.text || '').join('\n');
  }
  if (!text && j.output_text) text = j.output_text;
  const msg = { role: 'assistant', content: text || (tcs.length ? null : '') };
  if (tcs.length) msg.tool_calls = tcs;
  if (reasoning) msg.reasoning_content = reasoning;
  ctx.usage = respUsage(j.usage);
  return completion(ctx, msg, respFinish(j, tcs.length > 0), ctx.usage);
}
function respStreamer(ctx, emit) {
  const map = {}, sent = {}; let tIdx = 0;
  const idxOf = (d) => map[d.item_id] ?? map['o' + d.output_index];
  const args = (i, a) => { emit(chunk(ctx, { tool_calls: [{ index: i, function: { arguments: a } }] })); sent[i] = (sent[i] || 0) + a.length; };
  return (ev, d) => {
    switch (d.type || ev) {
      case 'response.output_text.delta': case 'response.refusal.delta': if (d.delta) emit(chunk(ctx, { content: d.delta })); break;
      case 'response.reasoning_summary_text.delta': case 'response.reasoning_text.delta': if (d.delta) emit(chunk(ctx, { reasoning_content: d.delta })); break;
      case 'response.output_item.added': {
        const it = d.item || {};
        if (it.type === 'function_call') {
          const i = tIdx++; map[it.id] = i; map['o' + d.output_index] = i; sent[i] = 0; ctx.hadTools = true;
          emit(chunk(ctx, { tool_calls: [{ index: i, id: it.call_id || it.id, type: 'function', function: { name: it.name, arguments: '' } }] }));
          if (it.arguments) args(i, it.arguments);
        }
        break;
      }
      case 'response.function_call_arguments.delta': { const i = idxOf(d); if (i != null && d.delta) args(i, d.delta); break; }
      case 'response.function_call_arguments.done': { const i = idxOf(d); if (i != null && !sent[i] && d.arguments) args(i, d.arguments); break; }
      case 'response.output_item.done': { const it = d.item || {}; const i = map[it.id] ?? map['o' + d.output_index]; if (it.type === 'function_call' && i != null && !sent[i] && it.arguments) args(i, it.arguments); break; }
      case 'response.completed': case 'response.incomplete': ctx.finish = respFinish(d.response, ctx.hadTools); ctx.usage = respUsage(d.response?.usage); break;
      case 'response.failed': ctx.error = { message: d.response?.error?.message || 'response failed', type: d.response?.error?.code || 'upstream_error' }; break;
      case 'error': ctx.error = { message: d.message || d.error?.message || 'upstream error', type: d.code || 'upstream_error' }; break;
    }
  };
}

// ---------------------------------------------------------------- gemini
const sigCache = new Map(); // tool_call_id -> thoughtSignature（Gemini 3 多轮工具调用需要回传）
function cacheSig(id, sig) { if (!sig) return; sigCache.set(id, sig); if (sigCache.size > 5000) sigCache.delete(sigCache.keys().next().value); }
const GEM_FILTER = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
function toGemini(r, model) {
  const P = prep(r), sys = [], contents = [], idName = {};
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts: [...parts] });
  };
  for (const m of P.msgs) {
    if (m.role === 'system' || m.role === 'developer') { const t = textOf(m.content); if (t) sys.push({ text: t }); continue; }
    if (m.role === 'tool') {
      const name = idName[m.tool_call_id] || m.name || 'tool', txt = toolText(m.content);
      let resp; try { const v = JSON.parse(txt); resp = v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v }; } catch { resp = { result: txt }; }
      push('user', [{ functionResponse: { name, response: resp } }]); continue;
    }
    const parts = [];
    for (const p of partsOf(m.content)) {
      if (p.type === 'text' || p.type === 'input_text') { if (p.text) parts.push({ text: p.text }); }
      else if (p.type === 'image_url') { const u = imgUrl(p), d = parseDataUrl(u); parts.push(d ? { inlineData: { mimeType: d.mime, data: d.data } } : { fileData: { fileUri: u, mimeType: guessMime(u) } }); }
    }
    if (m.role === 'assistant') {
      let first = true;
      for (const tc of m.tool_calls || []) {
        const name = tc.function?.name; idName[tc.id] = name;
        const part = { functionCall: { name, args: safeJson(tc.function?.arguments) } };
        const sig = sigCache.get(tc.id) || (first ? 'skip_thought_signature_validator' : null);
        if (sig) part.thoughtSignature = sig;
        first = false; parts.push(part);
      }
      push('model', parts);
    } else push('user', parts);
  }
  const body = { contents };
  if (sys.length) body.systemInstruction = { parts: sys };
  const gc = {};
  if (P.maxTokens) gc.maxOutputTokens = P.maxTokens;
  if (r.temperature != null) gc.temperature = r.temperature;
  if (r.top_p != null) gc.topP = r.top_p;
  if (P.stop.length) gc.stopSequences = P.stop.slice(0, 5);
  if (Object.keys(gc).length) body.generationConfig = gc;
  if (P.tools.length) {
    body.tools = [{ functionDeclarations: P.tools.map(t => ({ name: t.function.name, description: t.function.description || '', parametersJsonSchema: t.function.parameters || { type: 'object', properties: {} } })) }];
    const tc = P.toolChoice;
    if (tc === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    else if (tc === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (tc?.function?.name) body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
  }
  return body;
}
function gemFinish(fr, hadTools, blocked) {
  if (blocked) return 'content_filter';
  if (hadTools) return 'tool_calls';
  if (fr === 'MAX_TOKENS') return 'length';
  if (GEM_FILTER.has(fr)) return 'content_filter';
  return 'stop';
}
const gemUsage = (u = {}) => mkUsage(u.promptTokenCount, (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0));
function gemParts(j) { const c = j.candidates?.[0]; return { parts: c?.content?.parts || [], fr: c?.finishReason, blocked: j.promptFeedback?.blockReason }; }
function fromGemini(j, ctx) {
  const { parts, fr, blocked } = gemParts(j);
  let text = '', reasoning = ''; const tcs = [];
  for (const p of parts) {
    if (p.functionCall) { const id = 'call_' + rid(12); cacheSig(id, p.thoughtSignature); tcs.push({ id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }); }
    else if (typeof p.text === 'string') { if (p.thought) reasoning += p.text; else text += p.text; }
  }
  const msg = { role: 'assistant', content: text || (tcs.length ? null : '') };
  if (tcs.length) msg.tool_calls = tcs;
  if (reasoning) msg.reasoning_content = reasoning;
  if (j.usageMetadata) ctx.usage = gemUsage(j.usageMetadata);
  return completion(ctx, msg, gemFinish(fr, tcs.length > 0, blocked), ctx.usage);
}
function gemStreamer(ctx, emit) {
  let tIdx = 0;
  return (ev, j) => {
    if (j.error) { ctx.error = { message: j.error.message || 'upstream error', type: j.error.status || 'upstream_error' }; return; }
    const { parts, fr, blocked } = gemParts(j);
    for (const p of parts) {
      if (p.functionCall) {
        const id = 'call_' + rid(12); cacheSig(id, p.thoughtSignature); ctx.hadTools = true;
        emit(chunk(ctx, { tool_calls: [{ index: tIdx++, id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }] }));
      } else if (typeof p.text === 'string' && p.text) emit(chunk(ctx, p.thought ? { reasoning_content: p.text } : { content: p.text }));
    }
    if (fr || blocked) ctx.finish = gemFinish(fr, ctx.hadTools, blocked);
    if (j.usageMetadata) ctx.usage = gemUsage(j.usageMetadata);
  };
}

// ---------------------------------------------------------------- request building
function buildRequest(u, r, model, effort, pathSuffix = '/chat/completions') {
  const base = upBase(u);
  const headers = { 'content-type': 'application/json', accept: r.stream ? 'text/event-stream' : 'application/json', ...authHeaders(u) };
  switch (u.format) {
    case 'openai': case 'azure': {
      const body = { ...r, model };
      if (effort && body.reasoning_effort == null) body.reasoning_effort = effort;
      let url;
      if (u.format === 'azure' && !azureIsV1(u)) url = `${base}/openai/deployments/${encodeURIComponent(model)}${pathSuffix}?api-version=${encodeURIComponent(u.api_version || '2024-10-21')}`;
      else url = base + pathSuffix;
      return { kind: 'pass', url, headers, body };
    }
    case 'openai-responses':
      if (pathSuffix !== '/chat/completions') return { kind: 'pass', url: base + pathSuffix, headers, body: { ...r, model } };
      return { kind: 'responses', url: base + '/responses', headers, body: toResponses(r, model, effort) };
    case 'anthropic':
      return { kind: 'anthropic', url: base + '/messages', headers, body: toAnthropic(r, model) };
    case 'gemini': {
      const m = model.replace(/^models\//, '');
      const q = [r.stream ? 'alt=sse' : '', u.key_in_query && upstreamKey(u) ? 'key=' + encodeURIComponent(upstreamKey(u)) : ''].filter(Boolean).join('&');
      return { kind: 'gemini', url: `${base}/models/${encodeURIComponent(m)}:${r.stream ? 'streamGenerateContent' : 'generateContent'}${q ? '?' + q : ''}`, headers, body: toGemini(r, m) };
    }
    default: throw new Error('不支持的格式: ' + u.format);
  }
}
const CONVERT = {
  anthropic: { full: fromAnthropic, stream: anthStreamer },
  responses: { full: fromResponses, stream: respStreamer },
  gemini: { full: fromGemini, stream: gemStreamer },
};
function sseParser(onEvent) {
  let buf = '';
  const handle = (raw) => {
    let ev = 'message'; const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    const s = data.join('\n');
    if (s.trim() === '[DONE]') return;
    let j; try { j = JSON.parse(s); } catch { return; }
    onEvent(ev, j);
  };
  return {
    push(c) { buf += c; let m; while ((m = /\r?\n\r?\n/.exec(buf))) { const raw = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length); handle(raw); } },
    end() { if (buf.trim()) handle(buf); buf = ''; },
  };
}

// ---------------------------------------------------------------- request log (never logs keys or bodies)
const reqLog = [];
function addLog(e) { reqLog.unshift(e); if (reqLog.length > 300) reqLog.length = 300; }

// ---------------------------------------------------------------- HTTP plumbing
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-api-key, *', 'access-control-max-age': '86400' };
function sendJson(res, status, obj, extra = {}) {
  if (res.headersSent) { try { res.end(); } catch { } return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
function sendErr(res, status, message, type = 'relay_error') { sendJson(res, status, { error: { message, type, code: type, param: null } }, CORS); }
function bearer(req) {
  const a = req.headers.authorization || '';
  if (/^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, '').trim();
  return req.headers['x-api-key'] || '';
}

// ---------------------------------------------------------------- chat proxy core
async function handleProxy(req, res, rawBody, pathSuffix) {
  let r;
  try { r = JSON.parse(rawBody || '{}'); } catch { return sendErr(res, 400, '请求体不是合法 JSON', 'invalid_request_error'); }
  const forced = req.headers['x-relay-upstream'];
  const route = resolveRoute(r.model, forced);
  if (!route) return sendErr(res, 503, forced ? `上游 ${forced} 不存在` : '没有已启用的上游，请先在管理页添加', 'no_upstream');
  const t0 = Date.now();
  const entry = { time: now(), path: pathSuffix, model: String(r.model || ''), upstream: route.u.name, real_model: route.model + (route.effort ? ` (effort=${route.effort})` : ''), stream: !!r.stream, status: 0, ms: 0, prompt_tokens: null, completion_tokens: null, error: '', source: req.headers['x-relay-source'] === 'test' ? 'test' : 'client' };
  let logged = false;
  const done = (status, extra = {}) => {
    if (logged) return; logged = true;
    Object.assign(entry, { status, ms: Date.now() - t0 }, extra);
    addLog(entry);
    log(`${pathSuffix} ${entry.model} -> ${entry.upstream}/${entry.real_model} ${status} ${entry.ms}ms` + (entry.prompt_tokens != null ? ` tok ${entry.prompt_tokens}/${entry.completion_tokens}` : '') + (entry.fallback_from ? ` (fallback from ${entry.fallback_from})` : '') + (entry.error ? ` ERR ${String(entry.error).slice(0, 160)}` : ''));
  };
  const noFallback = !!forced || req.headers['x-relay-no-fallback'] === '1';
  const chain = [route.u];
  if (!noFallback) for (const n of route.u.fallback) { const f = findUp(n); if (f && f.enabled && !chain.includes(f)) chain.push(f); }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let last = null;
  for (let i = 0; i < chain.length; i++) {
    const u = chain[i];
    if (i > 0) { entry.fallback_from = (entry.fallback_from ? entry.fallback_from + ',' : '') + chain[i - 1].name; entry.upstream = u.name; }
    let spec;
    try { spec = buildRequest(u, r, route.model, route.effort, pathSuffix); }
    catch (e) { last = { status: 400, message: e.message }; continue; }
    if (spec.kind !== 'pass' && pathSuffix !== '/chat/completions') { last = { status: 404, message: `${u.format} 上游只支持 /v1/chat/completions` }; continue; }
    if (DEBUG) log('-> upstream', u.name, spec.url.replace(/key=[^&]+/, 'key=***'), JSON.stringify(spec.body).slice(0, 2000));
    let up;
    try { up = await doRequest(spec.url, { headers: spec.headers, body: JSON.stringify(spec.body), timeout: u.timeout_ms || cfg.timeout_ms, signal: ac.signal }); }
    catch (e) {
      if (ac.signal.aborted) return done(499, { error: 'client closed' });
      last = { status: e.code === 'ETIMEOUT' ? 504 : 502, message: `上游 ${u.name} 连接失败: ${e.message}` };
      if (i < chain.length - 1) log(`fallback: ${u.name} -> ${chain[i + 1].name} (${last.message.slice(0, 120)})`);
      continue;
    }
    const retriable = up.statusCode >= 500 || up.statusCode === 429;
    if (retriable && i < chain.length - 1) {
      const t = await readAll(up).catch(() => '');
      last = { status: up.statusCode, message: `上游 ${u.name} HTTP ${up.statusCode}: ${String(errMessage(t)).slice(0, 300)}` };
      log(`fallback: ${u.name} -> ${chain[i + 1].name} (${last.message.slice(0, 120)})`);
      continue;
    }
    return deliver(res, r, u, spec, up, entry, done);
  }
  done(last?.status || 502, { error: last?.message || 'no upstream' });
  sendErr(res, last?.status || 502, last?.message || 'no upstream', 'upstream_error');
}

async function deliver(res, r, u, spec, up, entry, done) {
  const status = up.statusCode;
  const ctype = String(up.headers['content-type'] || '');
  if (status >= 400) {
    const text = await readAll(up).catch(() => '');
    const msg = String(errMessage(text));
    done(status, { error: msg.slice(0, 500) });
    if (spec.kind === 'pass') { res.writeHead(status, { 'content-type': ctype || 'application/json', ...CORS }); return res.end(text); }
    let type = 'upstream_error'; try { const j = JSON.parse(text); type = j.error?.type || j.error?.status || j.error?.code || type; } catch { }
    return sendErr(res, status, `[${u.name}] ${msg}`, String(type));
  }
  // ---- 直通（openai / azure / ollama / lmstudio）：逐块原样转发
  if (spec.kind === 'pass') {
    res.writeHead(status, { 'content-type': ctype || 'application/json', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', ...CORS });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const isSse = ctype.includes('event-stream');
    let tail = '', whole = '';
    up.on('data', c => {
      res.write(c);
      const s = c.toString('utf8');
      if (isSse) tail = (tail + s).slice(-8192); else if (whole.length < 4e6) whole += s;
    });
    up.on('end', () => {
      res.end();
      try {
        let usage;
        if (isSse) { for (const line of tail.split('\n')) if (line.startsWith('data:') && line.includes('"usage"')) { try { const j = JSON.parse(line.slice(5)); if (j.usage) usage = j.usage; } catch { } } }
        else usage = JSON.parse(whole).usage;
        if (usage) { entry.prompt_tokens = usage.prompt_tokens ?? usage.input_tokens ?? null; entry.completion_tokens = usage.completion_tokens ?? usage.output_tokens ?? null; }
      } catch { }
      done(status);
    });
    up.on('error', e => { res.destroy(); done(502, { error: e.message }); });
    return;
  }
  // ---- 需要翻译的格式
  const conv = CONVERT[spec.kind];
  const ctx = { id: 'chatcmpl-' + rid(12), created: Math.floor(Date.now() / 1000), model: String(r.model || ''), usage: null, finish: null, hadTools: false, error: null };
  const setTok = () => { if (ctx.usage) { entry.prompt_tokens = ctx.usage.prompt_tokens; entry.completion_tokens = ctx.usage.completion_tokens; } };
  if (!r.stream || !ctype.includes('event-stream')) {
    let text, out;
    try { text = await readAll(up); } catch (e) { done(502, { error: e.message }); return sendErr(res, 502, e.message); }
    try {
      const j = JSON.parse(text);
      if (spec.kind === 'gemini' && Array.isArray(j)) { // 部分中转站流式时返回 JSON 数组
        const all = { candidates: [{ content: { parts: [] } }] };
        for (const x of j) { const g = gemParts(x); all.candidates[0].content.parts.push(...g.parts); if (g.fr) all.candidates[0].finishReason = g.fr; if (x.usageMetadata) all.usageMetadata = x.usageMetadata; }
        out = fromGemini(all, ctx);
      } else out = conv.full(j, ctx);
    } catch (e) { done(502, { error: '无法解析上游响应: ' + e.message }); return sendErr(res, 502, `[${u.name}] 无法解析上游响应: ${e.message}: ${text.slice(0, 200)}`); }
    setTok(); done(status);
    if (!r.stream) return sendJson(res, 200, out, CORS);
    // 客户端要流式但上游返回了整段 JSON：转成 SSE
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...CORS });
    const m = out.choices[0].message, w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    w(chunk(ctx, { role: 'assistant', content: '' }));
    if (m.reasoning_content) w(chunk(ctx, { reasoning_content: m.reasoning_content }));
    if (m.content) w(chunk(ctx, { content: m.content }));
    if (m.tool_calls) w(chunk(ctx, { tool_calls: m.tool_calls.map((t, index) => ({ index, ...t })) }));
    w(chunk(ctx, {}, out.choices[0].finish_reason));
    if (r.stream_options?.include_usage && out.usage) w({ ...chunk(ctx, {}), choices: [], usage: out.usage });
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', ...CORS });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const emit = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  emit(chunk(ctx, { role: 'assistant', content: '' }));
  const handler = conv.stream(ctx, emit);
  const parser = sseParser((ev, d) => { try { handler(ev, d); } catch (e) { ctx.error = { message: 'translate error: ' + e.message, type: 'relay_error' }; } });
  up.setEncoding('utf8');
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    parser.end();
    if (ctx.error) emit({ error: { ...ctx.error, code: ctx.error.type } });
    else {
      emit(chunk(ctx, {}, ctx.finish || (ctx.hadTools ? 'tool_calls' : 'stop')));
      if (r.stream_options?.include_usage && ctx.usage) emit({ ...chunk(ctx, {}), choices: [], usage: ctx.usage });
    }
    if (!res.writableEnded) res.end('data: [DONE]\n\n');
    setTok(); done(ctx.error ? 502 : 200, ctx.error ? { error: ctx.error.message } : {});
  };
  up.on('data', c => parser.push(c));
  up.on('end', finish);
  up.on('error', e => { ctx.error = ctx.error || { message: e.message, type: 'upstream_error' }; finish(); });
  up.on('aborted', () => { ctx.error = ctx.error || { message: 'upstream aborted', type: 'upstream_error' }; finish(); });
}

// ---------------------------------------------------------------- tunnel (cloudflared quick tunnel)
const tunnel = { proc: null, state: 'stopped', url: '', error: '', log: [] };
function cloudflaredBin() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(DIR, 'bin', exe);
  return fs.existsSync(local) ? local : exe;
}
function startTunnel(onUrl) {
  if (tunnel.proc) return;
  Object.assign(tunnel, { state: 'starting', url: '', error: '', log: [] });
  let p;
  try { p = spawn(cloudflaredBin(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${runtimePort}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
  catch (e) { Object.assign(tunnel, { state: 'error', error: e.message }); return; }
  tunnel.proc = p;
  const onData = (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue;
      tunnel.log.push(line.replace(/\x1b\[[0-9;]*m/g, '')); if (tunnel.log.length > 60) tunnel.log.shift();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
      if (m && !m[0].startsWith('https://api.') && !tunnel.url) { tunnel.url = m[0]; tunnel.state = 'connecting'; }
      // 拿到 URL 只代表注册成功；要等到 "Registered tunnel connection" 才真正可用
      if (/Registered tunnel connection/i.test(line) && tunnel.url && tunnel.state !== 'running') { tunnel.state = 'running'; tunnel.error = ''; onUrl && onUrl(tunnel.url); }
      if (/port 7844/i.test(line) && tunnel.state !== 'running') tunnel.error = '当前网络阻止了 cloudflared 的出站 7844 端口（QUIC/TCP），隧道无法连通。请换个网络，或改用其它内网穿透工具（见 README）';
    }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', e => { if (tunnel.proc === p) tunnel.proc = null; Object.assign(tunnel, { state: 'error', url: '', error: e.code === 'ENOENT' ? '找不到 cloudflared：请先安装（见 README），或放到 bin/ 目录' : e.message }); });
  p.on('exit', (code) => {
    if (tunnel.proc !== p) return;
    tunnel.proc = null;
    if (tunnel.state !== 'stopped') Object.assign(tunnel, { state: 'error', url: '', error: tunnel.error || `cloudflared 已退出 (code ${code})` });
  });
}
function stopTunnel() { const p = tunnel.proc; tunnel.proc = null; Object.assign(tunnel, { state: 'stopped', url: '' }); if (p) p.kill(); }
async function cursorSettings() {
  let models = [];
  try { models = (await listModelIds()).map(m => m.id); } catch { }
  return { api_key: cfg.proxy_token, base_url: tunnel.url ? tunnel.url + '/v1' : '', tunnel_state: tunnel.state, local_base_url: `http://127.0.0.1:${runtimePort}/v1`, models };
}
async function printCursorSettings() {
  const s = await cursorSettings();
  console.log('\n================ 在 Cursor 里这样填 ================');
  console.log('Cursor Settings → Models → API Keys');
  console.log(`  OpenAI API Key           : ${s.api_key}`);
  console.log(`  Override OpenAI Base URL : ${s.base_url || '(先启动隧道，Cursor 不能访问 localhost)'}`);
  console.log('  再到 Models 列表点 "+ Add Custom Model"，逐个添加：');
  if (s.models.length) for (const m of s.models.slice(0, 40)) console.log('    ' + m); else console.log(`    ${cfg.model_prefix}<模型名>   (例如 ${cfg.model_prefix}claude-sonnet-4-5)`);
  if (s.models.length > 40) console.log(`    ... 共 ${s.models.length} 个，完整列表见管理页`);
  console.log('====================================================\n');
}

// ---------------------------------------------------------------- admin
const sessions = new Map(); // token -> expires
const loginFails = new Map(); // ip -> {n, t}
const SESSION_TTL = 7 * 24 * 3600e3;
function parseCookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function isAuthed(req) {
  const t = parseCookies(req).relay_admin; if (!t) return false;
  const exp = sessions.get(t); if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function isLoopback(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
// 默认只允许本机直接访问管理页；经隧道(cloudflared 会加 Cf-* 头)或其它反代来的请求一律 404
function adminReachable(req) {
  if (cfg.admin_remote) return true;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
  return isLoopback(req);
}
function maskKey(k) { if (!k) return ''; return k.length <= 10 ? `已设置(${k.length}位)` : k.slice(0, 4) + '…' + k.slice(-4); }
function maskUp(u) {
  const k = upstreamKey(u); const { api_key, ...rest } = u;
  return { ...rest, api_key_masked: maskKey(k), api_key_set: !!k, api_key_source: u.api_key ? (u.api_key.startsWith('env:') ? 'env' : 'config') : (k ? 'env' : '') };
}
let ADMIN_HTML_CACHE = null;
function adminHtml() {
  const f = path.join(DIR, 'admin.html');
  if (DEBUG || !ADMIN_HTML_CACHE) ADMIN_HTML_CACHE = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '<h1>admin.html 缺失</h1>';
  return ADMIN_HTML_CACHE;
}
const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#050506"><title>api2cursor · 登录</title>
<style>:root{--bg:#050506;--panel:#0b0c0e;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.14);--fg:#f4f5f7;--fg-2:rgba(244,245,247,.64);--fg-hint:rgba(244,245,247,.56);--accent:#37bdf8;--ease:cubic-bezier(.22,1,.36,1);
--sans:"Montserrat",-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:var(--sans);font-size:14px;line-height:1.5;color:var(--fg);-webkit-font-smoothing:antialiased;
background:radial-gradient(120% 55% at 50% -12%,rgba(47,120,168,.22),transparent 62%),radial-gradient(60% 40% at 50% 118%,rgba(55,189,248,.10),transparent 70%),var(--bg)}
form{width:min(380px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:28px;padding:36px;box-shadow:0 0 0 6px rgba(255,255,255,.02),0 60px 120px -60px rgba(0,0,0,.9)}
.b{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;letter-spacing:.06em}.b i{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px rgba(55,189,248,.7)}
h1{font-size:28px;line-height:36px;font-weight:500;letter-spacing:-.03em;margin:22px 0 20px}h1 span{display:block;color:rgba(244,245,247,.4)}
input{width:100%;padding:12px 16px;border:1px solid var(--line-2);border-radius:12px;background:rgba(255,255,255,.04);color:var(--fg);font:inherit}input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(55,189,248,.25)}
button{margin-top:14px;width:100%;height:48px;border:0;border-radius:999px;background:rgba(255,255,255,.88);color:#0a0a0b;font:inherit;font-weight:500;cursor:pointer;transition:transform .3s var(--ease),background .3s,box-shadow .3s}
button:hover{background:#fff;transform:translateY(-1px);box-shadow:0 0 0 1px rgba(255,255,255,.2),0 10px 30px -10px rgba(55,189,248,.55)}
#e{color:#f87171;font-size:13px;margin-top:10px;min-height:1.2em}p{color:var(--fg-hint);font-size:12px;margin:8px 0 0}
@media (prefers-reduced-motion:reduce){button{transition:none}button:hover{transform:none}}</style></head><body>
<form id="f"><div class="b"><i></i>api2cursor</div><h1>管理页登录<span>只对本机开放</span></h1><input id="p" type="password" placeholder="管理密码" aria-label="管理密码" autofocus autocomplete="current-password"><button>登录</button><div id="e" role="alert"></div>
<p>密码在首次启动时打印在终端里；也可以用环境变量 ADMIN_PASSWORD 指定。</p></form>
<script>document.getElementById('f').onsubmit=async function(ev){ev.preventDefault();var r=await fetch('/admin/api/login',{method:'POST',headers:{'content-type':'application/json','x-relay-admin':'1'},body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok)location.href='/admin';else{var j=await r.json().catch(function(){return{}});document.getElementById('e').textContent=(j.error&&j.error.message)||('登录失败 '+r.status);}};</script></body></html>`;
const SEC_HEADERS = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
const adminErr = (res, status, msg) => sendJson(res, status, { error: { message: msg } }, SEC_HEADERS);
const readJsonBody = async (req) => JSON.parse((await readAll(req, 1024 * 1024)) || '{}');

async function handleAdmin(req, res, url) {
  if (!adminReachable(req)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS }); return res.end('Not found'); }
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/admin' || p === '/admin/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", ...SEC_HEADERS });
    return res.end(isAuthed(req) ? adminHtml() : LOGIN_HTML);
  }
  if (!p.startsWith('/admin/api/')) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
  const api = p.slice('/admin/api/'.length);
  // 防 CSRF：要求自定义头 + JSON（跨站页面无法携带，且管理接口不响应 CORS 预检）
  if (req.headers['x-relay-admin'] !== '1') return adminErr(res, 403, 'missing x-relay-admin header');
  let body = {};
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').includes('application/json')) return adminErr(res, 415, 'content-type must be application/json');
    try { body = await readJsonBody(req); } catch { return adminErr(res, 400, 'invalid json'); }
  }
  if (api === 'login' && req.method === 'POST') {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
    const f = loginFails.get(ip);
    if (f && f.n >= 5 && Date.now() - f.t < 60e3) return adminErr(res, 429, '尝试次数过多，请 1 分钟后再试');
    if (!checkPassword(String(body.password || ''), cfg.admin_password_hash)) {
      loginFails.set(ip, { n: (f && Date.now() - f.t < 60e3 ? f.n : 0) + 1, t: Date.now() });
      return adminErr(res, 401, '密码错误');
    }
    loginFails.delete(ip);
    const t = rid(32); sessions.set(t, Date.now() + SESSION_TTL);
    const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-connecting-ip'];
    return sendJson(res, 200, { ok: true }, { ...SEC_HEADERS, 'set-cookie': `relay_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}` });
  }
  if (!isAuthed(req)) return adminErr(res, 401, '未登录');
  const ok = (o = {}) => sendJson(res, 200, { ok: true, ...o }, SEC_HEADERS);
  const POST = req.method === 'POST';

  if (api === 'logout' && POST) {
    sessions.delete(parseCookies(req).relay_admin);
    return sendJson(res, 200, { ok: true }, { ...SEC_HEADERS, 'set-cookie': 'relay_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (api === 'state' && req.method === 'GET') {
    return ok({
      version: VERSION, config_path: CONFIG_PATH, host: cfg.host, port: runtimePort, config_port: cfg.port,
      proxy_token: cfg.proxy_token, model_prefix: cfg.model_prefix, admin_remote: cfg.admin_remote, timeout_ms: cfg.timeout_ms,
      password_from_env: !!process.env.ADMIN_PASSWORD,
      models: cfg.models, upstreams: cfg.upstreams.map(maskUp), formats: FORMATS,
      tunnel: { state: tunnel.state, url: tunnel.url, error: tunnel.error, log: tunnel.log.slice(-15), binary: cloudflaredBin() },
      cursor: await cursorSettings(),
    });
  }
  if (api === 'settings' && POST) {
    if (body.model_prefix !== undefined) {
      const pf = String(body.model_prefix);
      if (/\s/.test(pf)) return adminErr(res, 400, '前缀不能包含空格');
      cfg.model_prefix = pf;
    }
    if (body.timeout_ms !== undefined) { const t = Number(body.timeout_ms); if (!(t >= 1000)) return adminErr(res, 400, 'timeout_ms 至少 1000'); cfg.timeout_ms = t; }
    if (body.admin_remote !== undefined) cfg.admin_remote = !!body.admin_remote;
    if (body.models !== undefined) cfg.models = normModels(body.models);
    if (body.port !== undefined) { const pn = Number(body.port); if (!(pn > 0 && pn < 65536)) return adminErr(res, 400, '端口无效'); cfg.port = pn; }
    saveConfig(); return ok({ restart_needed: cfg.port !== runtimePort });
  }
  if (api === 'token/regenerate' && POST) { cfg.proxy_token = 'cr-' + rid(24); saveConfig(); return ok({ proxy_token: cfg.proxy_token }); }
  if (api === 'password' && POST) {
    if (process.env.ADMIN_PASSWORD) return adminErr(res, 400, '密码由环境变量 ADMIN_PASSWORD 指定，无法在页面修改');
    const pw = String(body.password || ''); if (pw.length < 8) return adminErr(res, 400, '新密码至少 8 位');
    cfg.admin_password_hash = hashPassword(pw); saveConfig();
    const cur = parseCookies(req).relay_admin; for (const k of [...sessions.keys()]) if (k !== cur) sessions.delete(k);
    return ok();
  }
  if (api === 'upstream/save' && POST) {
    const d = body.upstream || {}, orig = body.original_name ? findUp(String(body.original_name)) : null;
    if (body.original_name && !orig) return adminErr(res, 404, '原上游不存在');
    const nu = normUpstream({ ...d, api_key: '' });
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(nu.name)) return adminErr(res, 400, '名称只能用字母、数字和 _ . -，最长 40 个字符');
    if (!FORMATS.includes(nu.format)) return adminErr(res, 400, '未知格式: ' + nu.format);
    if (nu.base_url) { try { const x = new URL(nu.base_url); if (!/^https?:$/.test(x.protocol)) throw 0; } catch { return adminErr(res, 400, 'base_url 必须是 http(s):// 开头的地址'); } }
    else if (nu.format === 'azure') return adminErr(res, 400, 'Azure 必须填写 base_url（https://<资源名>.openai.azure.com）');
    const clash = findUp(nu.name); if (clash && clash !== orig) return adminErr(res, 400, '已存在同名上游');
    if (typeof d.api_key === 'string' && d.api_key.trim()) nu.api_key = d.api_key.trim();
    else if (!d.clear_api_key && orig) nu.api_key = orig.api_key;
    if (orig) {
      cfg.upstreams[cfg.upstreams.indexOf(orig)] = nu;
      if (orig.name !== nu.name) {
        for (const u of cfg.upstreams) u.fallback = u.fallback.map(f => f === orig.name ? nu.name : f);
        for (const m of Object.values(cfg.models)) if (m.upstream === orig.name) m.upstream = nu.name;
      }
      modelCache.delete(orig.name);
    } else cfg.upstreams.push(nu);
    modelCache.delete(nu.name);
    saveConfig(); return ok({ upstream: maskUp(nu) });
  }
  if (api === 'upstream/delete' && POST) {
    const u = findUp(String(body.name)); if (!u) return adminErr(res, 404, '不存在');
    cfg.upstreams = cfg.upstreams.filter(x => x !== u);
    for (const x of cfg.upstreams) x.fallback = x.fallback.filter(f => f !== u.name);
    modelCache.delete(u.name); saveConfig(); return ok();
  }
  if (api === 'upstream/toggle' && POST) {
    const u = findUp(String(body.name)); if (!u) return adminErr(res, 404, '不存在');
    u.enabled = body.enabled !== undefined ? !!body.enabled : !u.enabled; saveConfig(); return ok({ enabled: u.enabled });
  }
  if (api === 'upstream/move' && POST) {
    const i = cfg.upstreams.findIndex(u => u.name === body.name), j = i + (body.dir === 'up' ? -1 : 1);
    if (i >= 0 && j >= 0 && j < cfg.upstreams.length) { [cfg.upstreams[i], cfg.upstreams[j]] = [cfg.upstreams[j], cfg.upstreams[i]]; saveConfig(); }
    return ok();
  }
  if (api === 'upstream/models' && POST) {
    let u;
    if (body.draft) { // 编辑框里尚未保存的配置，也能先拉模型
      const orig = body.original_name ? findUp(String(body.original_name)) : null;
      u = normUpstream({ ...body.draft, name: '__draft__' + rid(4), api_key: '' });
      u.api_key = (typeof body.draft.api_key === 'string' && body.draft.api_key.trim()) ? body.draft.api_key.trim() : (orig ? orig.api_key : '');
      if (!u.api_key_env && orig) u.api_key_env = orig.api_key_env;
    } else u = findUp(String(body.name));
    if (!u) return adminErr(res, 404, '不存在');
    try { const list = await fetchModels(u, true); if (u.name.startsWith('__draft__')) modelCache.delete(u.name); return ok({ models: list }); }
    catch (e) { if (u.name.startsWith('__draft__')) modelCache.delete(u.name); return adminErr(res, 502, e.message); }
  }
  if (api === 'test' && POST) {
    const u = findUp(String(body.upstream || '')); if (!u) return adminErr(res, 404, '上游不存在');
    let model = String(body.model || '').trim();
    if (!model) model = u.models[0] || (await fetchModels(u).catch(() => []))[0] || '';
    if (!model) return adminErr(res, 400, '请先填写要测试的模型名');
    const t0 = Date.now();
    try {
      const host = ['0.0.0.0', '::', ''].includes(cfg.host) ? '127.0.0.1' : cfg.host;
      const rr = await doRequest(`http://${host.includes(':') ? `[${host}]` : host}:${runtimePort}/v1/chat/completions`, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.proxy_token}`, 'x-relay-upstream': u.name, 'x-relay-source': 'test' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }], max_tokens: 64, stream: false }),
        timeout: (u.timeout_ms || cfg.timeout_ms) + 5000,
      });
      const text = await readAll(rr); const ms = Date.now() - t0;
      if (rr.statusCode >= 400) return ok({ success: false, status: rr.statusCode, ms, model, error: String(errMessage(text)).slice(0, 800) });
      const j = JSON.parse(text), m = j.choices?.[0]?.message || {};
      return ok({ success: true, status: rr.statusCode, ms, model, reply: String(m.content || (m.tool_calls ? '[tool_calls]' : '') || m.reasoning_content || '').slice(0, 500), usage: j.usage || null });
    } catch (e) { return ok({ success: false, status: 0, ms: Date.now() - t0, model, error: e.message }); }
  }
  if (api === 'tunnel/start' && POST) {
    startTunnel(u => log('隧道已就绪: ' + u));
    for (let i = 0; i < 120 && (tunnel.state === 'starting' || (tunnel.state === 'connecting' && !tunnel.error)); i++) await new Promise(r => setTimeout(r, 250));
    return ok({ tunnel: { state: tunnel.state, url: tunnel.url, error: tunnel.error } });
  }
  if (api === 'tunnel/stop' && POST) { stopTunnel(); return ok(); }
  if (api === 'logs' && req.method === 'GET') return ok({ logs: reqLog.slice(0, 200) });
  if (api === 'logs/clear' && POST) { reqLog.length = 0; return ok(); }
  return adminErr(res, 404, 'unknown api');
}

// ---------------------------------------------------------------- main router
async function onRequest(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  let p = url.pathname.replace(/\/{2,}/g, '/');
  try {
    if (p === '/' || p === '/admin' || p.startsWith('/admin/')) return await handleAdmin(req, res, url);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (p === '/health' || p === '/v1/health') return sendJson(res, 200, { ok: true, name: 'api2cursor', version: VERSION, upstreams: enabledUps().length }, CORS);
    if (p.startsWith('/v1/')) p = p.slice(3);
    const tok = bearer(req);
    if (!tok || !safeEq(tok, cfg.proxy_token)) return sendErr(res, 401, '代理口令错误：请在 Cursor 的 OpenAI API Key 中填写 proxy_token', 'invalid_api_key');
    if (req.method === 'GET' && p === '/models') return sendJson(res, 200, { object: 'list', data: await listModelIds() }, CORS);
    if (req.method === 'GET' && p.startsWith('/models/')) { const id = decodeURIComponent(p.slice(8)); return sendJson(res, 200, { id, object: 'model', created: 0, owned_by: resolveRoute(id)?.u.name || 'relay' }, CORS); }
    if (req.method === 'POST' && p === '/chat/completions') return await handleProxy(req, res, await readAll(req), '/chat/completions');
    if (req.method === 'POST' && ['/responses', '/completions', '/embeddings'].includes(p)) return await handleProxy(req, res, await readAll(req), p);
    return sendErr(res, 404, `不支持的路径 ${req.method} ${url.pathname}`, 'not_found');
  } catch (e) {
    log('ERROR', e.stack || e.message);
    if (!res.headersSent) sendErr(res, 500, 'relay internal error: ' + e.message);
    else try { res.end(); } catch { }
  }
}

// ---------------------------------------------------------------- start
loadConfig();
const server = http.createServer(onRequest);
server.requestTimeout = 0; server.headersTimeout = 60000; server.keepAliveTimeout = 65000;
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${cfg.port} 已被占用，换一个：PORT=8788 node server.mjs` : e.message); process.exit(1); });
server.listen(cfg.port, cfg.host, () => {
  runtimePort = server.address().port;
  const shown = ['0.0.0.0', '::'].includes(cfg.host) ? '127.0.0.1' : cfg.host;
  console.log(`\napi2cursor ${VERSION} 已启动: http://${shown}:${runtimePort}`);
  console.log(`配置文件  : ${CONFIG_PATH}`);
  console.log(`管理页    : http://${shown}:${runtimePort}/admin  (${cfg.admin_remote ? '已允许远程访问' : '仅本机可访问，隧道访问会返回 404'})`);
  if (generatedPassword) console.log(`管理密码  : ${generatedPassword}   ← 首次自动生成，请记下（可在管理页修改）`);
  else if (process.env.ADMIN_PASSWORD) console.log('管理密码  : 使用环境变量 ADMIN_PASSWORD');
  console.log(`代理口令  : ${cfg.proxy_token}`);
  console.log(`上游      : ${cfg.upstreams.map(u => `${u.name}[${u.format}${u.enabled ? '' : ',停用'}${upstreamKey(u) ? '' : ',无key'}]`).join('  ') || '(无，请到管理页添加)'}`);
  if (ARGV.includes('--tunnel') || process.env.RELAY_TUNNEL === '1') {
    console.log('正在启动 cloudflared 快速隧道 ...');
    startTunnel(async (u) => { console.log(`隧道地址  : ${u}`); await printCursorSettings(); });
    setTimeout(() => { if (tunnel.state !== 'running') console.log('隧道未就绪：' + (tunnel.error || tunnel.log.slice(-3).join(' | '))); }, 30000);
  } else console.log('提示：加 --tunnel 参数（或在管理页点“启动隧道”）获得 Cursor 能访问的公网地址');
});
const shutdown = () => { stopTunnel(); server.close(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('exit', () => { if (tunnel.proc) tunnel.proc.kill(); });
