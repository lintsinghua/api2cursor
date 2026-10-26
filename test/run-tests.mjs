// 端到端测试：启动 mock 上游 + api2cursor，用 HTTP 请求逐项验证。用法：node test/run-tests.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK = 19901, PORT = 18787, M = `http://127.0.0.1:${MOCK}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2c-test-'));
const CONFIG = path.join(tmp, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  port: PORT, model_prefix: 'relay-', timeout_ms: 8000,
  models: {
    'my-claude': { upstream: 'an', model: 'claude-mock-1' },
    'fb-test': { upstream: 'bad', model: 'gpt-mock' },
    'dead-test': { upstream: 'dead', model: 'gpt-mock' },
    'slow-test': { upstream: 'slow', model: 'gpt-mock' },
  },
  upstreams: [
    { name: 'oa', format: 'openai', base_url: `${M}/oa/v1`, api_key: 'sk-oa', headers: { 'X-Custom': 'hello' }, models: ['gpt-mock', 'fail500'] },
    { name: 'rs', format: 'openai-responses', base_url: `${M}/rs/v1`, api_key: 'sk-rs', models: ['gpt-5-mock'] },
    { name: 'an', format: 'anthropic', base_url: `${M}/an`, api_key: 'sk-an', models: ['claude-mock-1'] },
    { name: 'gm', format: 'gemini', base_url: `${M}/gm`, api_key: 'sk-gm', models: ['gemini-mock'] },
    { name: 'az', format: 'azure', base_url: `${M}/az`, api_key: 'sk-az', api_version: '2024-10-21', models: ['gpt4o-deploy'] },
    { name: 'local', format: 'ollama', base_url: `${M}/local/v1`, models: ['llama3'] },
    { name: 'bad', format: 'openai', base_url: `${M}/bad/v1`, api_key: 'x', fallback: ['oa'] },
    { name: 'dead', format: 'openai', base_url: 'http://127.0.0.1:9', api_key: 'x', fallback: ['oa'] },
    { name: 'slow', format: 'openai', base_url: `${M}/slow/v1`, api_key: 'x', timeout_ms: 1000, fallback: ['oa'] },
    { name: 'auto', format: 'openai', base_url: `${M}/rs/v1`, api_key: 'sk-oa' },
    { name: 'off', format: 'openai', base_url: `${M}/oa/v1`, api_key: 'sk-oa', enabled: false, models: ['ghost'] },
  ],
}, null, 2));

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, extra = '') { if (cond) { pass++; console.log('  ✔ ' + name); } else { fail++; failures.push(name); console.log('  ✘ ' + name + (extra ? '  → ' + String(extra).slice(0, 300) : '')); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, p, { body, headers = {}, port = PORT, host = '127.0.0.1', raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host, port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      const chunks = []; const times = [];
      res.on('data', c => { chunks.push(c); times.push(Date.now()); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(text); } catch { }
        resolve({ status: res.statusCode, headers: res.headers, text, json, chunkTimes: times });
      });
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}
let TOKEN = '', PASSWORD = '', COOKIE = '';
const auth = () => ({ authorization: `Bearer ${TOKEN}` });
const chat = (body, h = {}) => req('POST', '/v1/chat/completions', { body, headers: { ...auth(), ...h } });
const adminH = (extra = {}) => ({ 'x-relay-admin': '1', cookie: COOKIE, ...extra });
const admin = (p, body) => req(body === undefined ? 'GET' : 'POST', '/admin/api/' + p, { body, headers: adminH() });
const last = async (tag) => (await req('GET', '/_last/' + tag, { port: MOCK })).json;
const hits = async (tag) => (await req('GET', '/_hits/' + tag, { port: MOCK })).json;
function parseSse(text) {
  const out = []; let done = false;
  for (const block of text.split('\n\n')) { const l = block.trim(); if (!l.startsWith('data:')) continue; const d = l.slice(5).trim(); if (d === '[DONE]') { done = true; continue; } try { out.push(JSON.parse(d)); } catch { } }
  return { chunks: out, done };
}
function assemble(chunks) {
  let content = '', reasoning = '', finish = null, usage = null, role = null; const tools = [];
  for (const c of chunks) {
    if (c.usage) usage = c.usage;
    for (const ch of c.choices || []) {
      const d = ch.delta || {};
      if (d.role) role = d.role;
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      for (const t of d.tool_calls || []) { tools[t.index] = tools[t.index] || { id: '', name: '', arguments: '' }; if (t.id) tools[t.index].id = t.id; if (t.function?.name) tools[t.index].name = t.function.name; if (t.function?.arguments) tools[t.index].arguments += t.function.arguments; }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { content, reasoning, finish, usage, tools, role };
}
const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const USER = [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'weather in Beijing?' }];

async function toolRoundTrip(model, label) {
  // 非流式：拿到 tool_calls
  const r1 = await chat({ model, messages: USER, tools: TOOLS });
  const tc = r1.json?.choices?.[0]?.message?.tool_calls?.[0];
  ok(r1.status === 200 && tc?.function?.name === 'get_weather' && JSON.parse(tc.function.arguments).city === 'Beijing' && r1.json.choices[0].finish_reason === 'tool_calls', `${label} 非流式 tool_call`, r1.text);
  // 流式：tool_calls delta 拼接
  const r2 = await chat({ model, messages: USER, tools: TOOLS, stream: true, stream_options: { include_usage: true } });
  const s2 = parseSse(r2.text), a2 = assemble(s2.chunks);
  ok(r2.status === 200 && s2.done && a2.tools[0]?.name === 'get_weather' && a2.tools[0].id && JSON.parse(a2.tools[0].arguments || '{}').city === 'Beijing' && a2.finish === 'tool_calls', `${label} 流式 tool_call delta（index/id/name/arguments）`, r2.text.slice(0, 600));
  ok(!!a2.usage && a2.usage.prompt_tokens > 0, `${label} 流式 include_usage`, JSON.stringify(a2.usage));
  // 回传 tool 结果
  const msgs = [...USER, { role: 'assistant', content: null, tool_calls: [{ id: a2.tools[0].id, type: 'function', function: { name: 'get_weather', arguments: a2.tools[0].arguments } }] }, { role: 'tool', tool_call_id: a2.tools[0].id, content: 'sunny 25C' }];
  const r3 = await chat({ model, messages: msgs, tools: TOOLS, stream: true });
  const a3 = assemble(parseSse(r3.text).chunks);
  ok(r3.status === 200 && a3.content.includes('sunny 25C') && a3.finish === 'stop', `${label} tool 结果回传后得到最终回答`, r3.text.slice(0, 400));
  return { r1, a2 };
}

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if ((n.family === 'IPv4' || n.family === 4) && !n.internal) return n.address;
  }
  return '';
}
async function withServer(port, cfgExtra, envExtra, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2c-remote-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port, model_prefix: 'relay-', timeout_ms: 8000, upstreams: [], ...cfgExtra }));
  const out = [];
  const child = spawn(process.execPath, [path.join(DIR, '..', 'server.mjs')], {
    env: { ...process.env, RELAY_CONFIG: configPath, PORT: String(port), ADMIN_PASSWORD: 'remote-test-pw', RELAY_BASE_URL: '', HOST: '0.0.0.0', ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => out.push(String(d)));
  child.stderr.on('data', d => out.push(String(d)));
  const kill = () => { try { child.kill(); } catch { } };
  try {
    for (let i = 0; i < 50; i++) { await sleep(100); if (/已启动/.test(out.join(''))) break; }
    if (!/已启动/.test(out.join(''))) throw new Error('remote server did not start: ' + out.join('').slice(0, 400));
    await fn({ port, configPath, out });
  } finally { kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}
async function remoteMatrix() {
  const ip = lanIP();
  ok(!!ip, '存在非回环 IPv4，用于管理页来源检查', ip);
  if (!ip) return;
  await withServer(18790, {}, {}, async ({ port, configPath }) => {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    ok(saved.admin_remote === false, '监听 0.0.0.0 时 admin_remote 仍默认 false');
    let r = await req('GET', '/admin', { port }); ok(r.status === 200 && /type="password"/.test(r.text), '回环访问管理页得到登录页');
    r = await req('GET', '/admin', { port, host: ip }); ok(r.status === 404, '非回环访问 /admin → 404', r.status + ' ' + ip);
    r = await req('GET', '/admin/api/state', { port, host: ip, headers: { 'x-relay-admin': '1' } }); ok(r.status === 404, '非回环访问管理 API → 404');
    r = await req('GET', '/admin', { port, headers: { 'cf-connecting-ip': '8.8.8.8' } }); ok(r.status === 404, '回环但带隧道头仍 404');
    r = await req('POST', '/admin/api/login', { port, body: { password: 'remote-test-pw' }, headers: { 'x-relay-admin': '1' } });
    ok(r.status === 200, '回环可以登录');
    const cookie = String(r.headers['set-cookie'] || '').split(';')[0];
    const call = (p, body) => req(body === undefined ? 'GET' : 'POST', '/admin/api/' + p, { port, body, headers: { 'x-relay-admin': '1', cookie, ...(body === undefined ? {} : {}) } });
    r = await call('settings', { admin_remote: true });
    ok(r.status === 400, '侧车服务未确认不能开启远程管理');
    r = await req('GET', '/admin', { port, host: ip }); ok(r.status === 404, '拒绝开启后非回环仍 404');
    r = await call('settings', { admin_remote: true, confirm_admin_remote: true });
    ok(r.status === 200 && (await call('state')).json.admin_remote === true, '确认后才打开远程管理');
    r = await req('GET', '/admin', { port, host: ip }); ok(r.status === 200 && /type="password"/.test(r.text), '开启后非回环得到登录页而不是管理接口数据', r.status);
    r = await req('GET', '/admin', { port, host: ip, headers: { 'cf-connecting-ip': '8.8.8.8' } }); ok(r.status === 200, '开启后隧道头不再 404');
    r = await call('settings', { admin_remote: false });
    ok((await call('state')).json.admin_remote === false, '可以关闭远程管理');
    r = await req('GET', '/admin', { port, host: ip }); ok(r.status === 404, '关闭后非回环恢复 404');
  });
  await withServer(18791, { admin_remote: 'false' }, { HOST: '127.0.0.1' }, async ({ configPath }) => {
    ok(JSON.parse(fs.readFileSync(configPath, 'utf8')).admin_remote === false, '配置里的字符串 "false" 不会打开远程管理');
  });
  await withServer(18792, { admin_remote: 'off' }, { HOST: '127.0.0.1' }, async ({ port }) => {
    const r = await req('GET', '/admin', { port, headers: { 'x-forwarded-for': '9.9.9.9' } });
    ok(r.status === 404, '配置 "off" 时反代头仍 404');
  });
  await withServer(18793, { admin_remote: true }, { ADMIN_REMOTE: '0' }, async ({ port }) => {
    const r = await req('GET', '/admin', { port, host: ip });
    ok(r.status === 404, 'ADMIN_REMOTE=0 强制关闭，即使配置为 true');
  });
  await withServer(18794, { admin_remote: false }, { ADMIN_REMOTE: '1' }, async ({ port }) => {
    const r = await req('GET', '/admin', { port, host: ip });
    ok(r.status === 200, 'ADMIN_REMOTE=1 显式开启');
  });
  await withServer(18795, { admin_remote: false }, { ADMIN_REMOTE: 'yes' }, async ({ port }) => {
    const r = await req('GET', '/admin', { port, headers: { 'cf-ray': 'z' } });
    ok(r.status === 200, 'ADMIN_REMOTE=yes 显式开启');
  });
  await withServer(18796, { admin_remote: true }, { ADMIN_REMOTE: 'false' }, async ({ port }) => {
    const r = await req('GET', '/admin', { port, host: ip });
    ok(r.status === 404, 'ADMIN_REMOTE=false 强制关闭');
  });
}

async function main() {
  const mock = spawn(process.execPath, [path.join(DIR, 'mock-upstream.mjs')], { env: { ...process.env, MOCK_PORT: String(MOCK) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const srvOut = [];
  const srv = spawn(process.execPath, [path.join(DIR, '..', 'server.mjs')], { env: { ...process.env, RELAY_CONFIG: CONFIG, PORT: String(PORT), ADMIN_PASSWORD: '', RELAY_BASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => srvOut.push(String(d))); srv.stderr.on('data', d => srvOut.push(String(d)));
  const cleanup = () => { srv.kill(); mock.kill(); };
  process.on('exit', cleanup);
  for (let i = 0; i < 50; i++) { await sleep(100); if (/已启动/.test(srvOut.join('')) ) break; }
  const outText = srvOut.join('');
  PASSWORD = (/管理密码\s*:\s*(\S+)/.exec(outText) || [])[1] || '';
  const cfgNow = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  TOKEN = cfgNow.proxy_token;

  console.log('\n[基础 / 安全]');
  ok(!!PASSWORD && !!TOKEN, '首次启动自动生成管理密码和 proxy_token 并打印');
  ok((fs.statSync(CONFIG).mode & 0o777) === 0o600, 'config.json 权限 600', (fs.statSync(CONFIG).mode & 0o777).toString(8));
  ok(!cfgNow.admin_password && /^scrypt\$/.test(cfgNow.admin_password_hash), '管理密码以 scrypt 哈希保存');
  ok(cfgNow.admin_remote === false, '新建配置 admin_remote 默认为 false');
  ok(!outText.includes('sk-oa') && !outText.includes('sk-an'), '启动日志不含上游 key');
  let r = await req('GET', '/health'); ok(r.status === 200 && r.json.ok, 'GET /health');
  r = await req('OPTIONS', '/v1/chat/completions', { headers: { origin: 'https://x', 'access-control-request-method': 'POST' } }); ok(r.status === 204 && r.headers['access-control-allow-origin'] === '*' && /authorization/.test(r.headers['access-control-allow-headers']), 'OPTIONS CORS 预检');
  r = await req('GET', '/v1/models'); ok(r.status === 401, '无 token 访问 /v1/models → 401');
  r = await req('GET', '/v1/models', { headers: { authorization: 'Bearer wrong' } }); ok(r.status === 401, '错误 token → 401');
  r = await req('POST', '/v1/chat/completions', { body: { model: 'relay-gpt-mock', messages: [] }, headers: { authorization: 'Bearer nope' } }); ok(r.status === 401, '错误 token 发 chat → 401');

  console.log('\n[/v1/models]');
  r = await req('GET', '/v1/models', { headers: auth() });
  const ids = (r.json?.data || []).map(m => m.id);
  ok(r.status === 200 && ids.includes('relay-gpt-mock') && ids.includes('relay-claude-mock-1') && ids.includes('relay-gemini-mock') && ids.includes('relay-my-claude') && ids.includes('relay-llama3'), '列出带前缀的模型（含别名）', ids.join(','));
  ok(!ids.includes('relay-ghost'), '停用的上游不出现在模型列表');
  ok(ids.includes('relay-claude-mock-via-oa'), 'models 留空的上游自动拉取 /v1/models（拉取失败的上游不影响列表）', ids.join(','));

  console.log('\n[openai 直通]');
  r = await chat({ model: 'relay-gpt-mock', messages: [{ role: 'user', content: 'hi' }] });
  ok(r.status === 200 && r.json.choices[0].message.content === 'pong from openai model=gpt-mock', 'openai 非流式，前缀被去掉', r.text);
  let L = await last('oa');
  ok(L.headers.authorization === 'Bearer sk-oa' && L.headers['x-custom'] === 'hello' && L.body.model === 'gpt-mock', '上游收到真实 key、自定义头、真实模型名');
  r = await chat({ model: 'relay-gpt-mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const ps = parseSse(r.text), pa = assemble(ps.chunks);
  ok(r.status === 200 && /event-stream/.test(r.headers['content-type']) && ps.done && pa.content === 'pong from openai model=gpt-mock', 'openai 流式原样转发', r.text.slice(0, 300));
  const span = r.chunkTimes[r.chunkTimes.length - 1] - r.chunkTimes[0];
  ok(r.chunkTimes.length >= 5 && span >= 100, `流式逐块到达，不缓冲（${r.chunkTimes.length} 块，跨度 ${span}ms）`);
  await toolRoundTrip('relay-gpt-mock', 'openai');
  r = await chat({ model: 'relay-gpt-mock-high', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('oa'); ok(r.status === 200 && L.body.model === 'gpt-mock' && L.body.reasoning_effort === 'high', 'openai 模型名 -high 后缀 → reasoning_effort');
  r = await chat({ model: 'relay-gpt-mock', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' });
  L = await last('oa'); ok(r.status === 200 && L.body.reasoning_effort === 'low', 'openai 请求 reasoning_effort=low');
  r = await chat({ model: 'relay-gpt-mock-high', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' });
  L = await last('oa'); ok(L.body.model === 'gpt-mock' && L.body.reasoning_effort === 'high', 'openai 后缀优先于请求 reasoning_effort');
  r = await chat({ model: 'relay-gpt-mock', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' });
  L = await last('oa'); ok(L.body.reasoning_effort == null, 'openai reasoning_effort=off 不转发给上游');
  r = await chat({ model: 'relay-oa/gpt-5.5-max', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('oa'); ok(r.status === 200 && L.body.model === 'gpt-5.5' && L.body.reasoning_effort === 'xhigh', 'gpt-5.5 无 max，-max 夹到 xhigh', JSON.stringify(L.body && { model: L.body.model, reasoning_effort: L.body.reasoning_effort }));
  ok(srvOut.join('').includes('gpt-5.5 (effort=max→xhigh)'), '请求日志 real_model 记下实际发出的强度');
  r = await chat({ model: 'relay-oa/gpt-5-max', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('oa'); ok(L.body.model === 'gpt-5' && L.body.reasoning_effort === 'high', 'gpt-5 无 max / xhigh，-max 夹到 high');
  r = await chat({ model: 'relay-oa/o3-xhigh', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('oa'); ok(L.body.model === 'o3' && L.body.reasoning_effort === 'high', 'o3 无 xhigh，-xhigh 夹到 high');
  r = await chat({ model: 'relay-oa/custom-relay-model', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' });
  L = await last('oa'); ok(L.body.model === 'custom-relay-model' && L.body.reasoning_effort === 'high', '未知模型 max 夹到 low/medium/high 的最高档');
  r = await chat({ model: 'relay-oa/custom-relay-model', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'minimal' });
  L = await last('oa'); ok(L.body.reasoning_effort === 'low', '未知模型 minimal 向上夹到 low');
  r = await chat({ model: 'relay-oa/gpt-5.1-codex-max', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' });
  L = await last('oa'); ok(L.body.model === 'gpt-5.1-codex-max' && L.body.reasoning_effort === 'high', 'gpt-5.1-codex-max 的 max 是模型名，不当成强度后缀');
  let n0 = (await hits('oa')).length;
  r = await chat({ model: 'relay-oa/fail400', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' });
  ok(r.status === 400 && (await hits('oa')).length === n0 + 1, '与强度无关的 400 不重试', r.text);
  r = await chat({ model: 'relay-fail500', messages: [{ role: 'user', content: 'hi' }] });
  ok(r.status === 500 && r.json?.error?.message === 'boom', '上游 500 状态码和错误体原样返回', r.text);
  r = await chat({ model: 'relay-oa/gpt-mock', messages: [{ role: 'user', content: 'hi' }] });
  ok(r.status === 200 && /model=gpt-mock/.test(r.text), '“上游名/模型” 路由');
  r = await chat({ model: 'relay-llama3', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('local'); ok(r.status === 200 && /pong from local/.test(r.text) && !L.headers.authorization, 'Ollama/LM Studio 风格上游：无 key 时不发 Authorization', r.text);

  console.log('\n[openai-responses]');
  r = await chat({ model: 'relay-gpt-5-mock-high', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }], max_tokens: 100 });
  L = await last('rs');
  ok(r.status === 200 && r.json.choices[0].message.content === 'pong from responses model=gpt-5-mock effort=high', 'responses 非流式 + -high → reasoning.effort', r.text);
  ok(L.body.input[0].role === 'system' && L.body.input[1].content[1].type === 'input_image' && L.body.max_output_tokens === 100 && L.body.store === false, 'responses 请求翻译（system/input_image/max_output_tokens）', JSON.stringify(L.body));
  ok(r.json.usage?.prompt_tokens === 40 && r.json.usage?.completion_tokens === 12, 'responses usage 映射');
  r = await chat({ model: 'relay-gpt-5-mock', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium' });
  L = await last('rs'); ok(r.status === 200 && L.body.reasoning?.effort === 'medium' && !/-medium$/.test(L.body.model), 'responses 请求 reasoning_effort → reasoning.effort', JSON.stringify(L.body.reasoning));
  r = await chat({ model: 'relay-gpt-5-mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
  let a = assemble(parseSse(r.text).chunks);
  ok(r.status === 200 && a.content === 'pong from responses model=gpt-5-mock effort=none' && a.role === 'assistant' && a.finish === 'stop', 'responses 流式文本', r.text.slice(0, 300));
  await toolRoundTrip('relay-gpt-5-mock', 'responses');
  L = await last('rs');
  ok(L.body.input.some(i => i.type === 'function_call' && i.call_id === 'call_rs1') && L.body.input.some(i => i.type === 'function_call_output' && i.output === 'sunny 25C') && L.body.tools[0].type === 'function' && L.body.tools[0].name === 'get_weather', 'responses：tool_calls → function_call / tool → function_call_output / tools 扁平化');

  console.log('\n[anthropic]');
  r = await chat({ model: 'relay-claude-mock-1', messages: [{ role: 'system', content: 'sys A' }, { role: 'developer', content: 'sys B' }, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] }], temperature: 1.5, top_p: 0.9, stop: 'END' });
  L = await last('an');
  ok(r.status === 200 && r.json.choices[0].message.content === 'pong from anthropic model=claude-mock-1' && r.json.choices[0].finish_reason === 'stop', 'anthropic 非流式', r.text);
  ok(L.headers['x-api-key'] === 'sk-an' && L.headers['anthropic-version'] === '2023-06-01' && !L.headers.authorization, 'anthropic 发送 x-api-key + anthropic-version');
  ok(L.body.system.length === 2 && L.body.max_tokens === 8192 && L.body.stop_sequences[0] === 'END' && L.body.temperature === 1 && L.body.top_p === undefined, 'system 合并、max_tokens 默认 8192、stop、temperature 夹到 1、去掉 top_p', JSON.stringify(L.body).slice(0, 400));
  ok(L.body.messages[0].content[1].type === 'image' && L.body.messages[0].content[1].source.type === 'base64' && L.body.messages[0].content[2].source.type === 'url', 'image_url → image 块（base64 与 url）');
  ok(r.json.usage.prompt_tokens === 25 && r.json.usage.completion_tokens === 9, 'anthropic usage（含 cache_read）映射', JSON.stringify(r.json.usage));
  r = await chat({ model: 'relay-my-claude', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } });
  a = assemble(parseSse(r.text).chunks);
  ok(r.status === 200 && a.content === 'pong from anthropic model=claude-mock-1' && a.finish === 'stop' && a.usage?.completion_tokens === 15, '别名 my-claude → anthropic 流式文本 + usage', r.text.slice(0, 300));
  const an = await toolRoundTrip('relay-claude-mock-1', 'anthropic');
  ok(an.r1.json.choices[0].message.content === 'Let me check.', 'anthropic text + tool_use 同时返回');
  L = await last('an');
  const am = L.body.messages;
  ok(am[1].role === 'assistant' && am[1].content.some(b => b.type === 'tool_use' && b.id === 'toolu_01' && b.input.city === 'Beijing') && am[2].role === 'user' && am[2].content[0].type === 'tool_result' && am[2].content[0].tool_use_id === 'toolu_01' && L.body.tools[0].input_schema.properties.city, 'tool_calls → tool_use，role tool → user/tool_result，tools → input_schema', JSON.stringify(am));
  r = await chat({ model: 'relay-claude-mock-1', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tool_choice: 'required', parallel_tool_calls: false });
  L = await last('an'); ok(L.body.tool_choice.type === 'any' && L.body.tool_choice.disable_parallel_tool_use === true, 'tool_choice required → any + disable_parallel_tool_use');
  r = await chat({ model: 'relay-an/bad-model', messages: [{ role: 'user', content: 'x' }] });
  ok(r.status === 404 && /bad-model/.test(r.json?.error?.message) && r.json.error.type === 'not_found_error', 'anthropic 错误 → OpenAI 错误格式，状态码保留', r.text);
  r = await chat({ model: 'relay-claude-mock-1-low', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, top_p: 0.5, max_tokens: 100 });
  L = await last('an');
  ok(r.status === 200 && L.body.model === 'claude-mock-1' && L.body.thinking?.type === 'enabled' && L.body.thinking.budget_tokens === 2048 && L.body.max_tokens > L.body.thinking.budget_tokens && L.body.temperature == null && L.body.top_p == null && r.json.choices[0].message.reasoning_content === 'ponder', 'anthropic 未知/旧模型 -low → budget_tokens，max_tokens 大于预算，去掉 temperature/top_p', JSON.stringify(L.body).slice(0, 500));
  r = await chat({ model: 'relay-claude-mock-1-low', messages: [{ role: 'user', content: 'hi' }], top_p: 0.97, stream: true });
  L = await last('an');
  a = assemble(parseSse(r.text).chunks);
  ok(r.status === 200 && L.body.stream === true && L.body.thinking?.type === 'enabled' && L.body.thinking.budget_tokens === 2048 && L.body.top_p === 0.97 && a.reasoning === 'ponder' && a.content.includes('pong from anthropic'), 'anthropic 流式 -low 同样带 budget，top_p 在 0.95–1 保留，thinking_delta → reasoning_content', JSON.stringify(L.body.thinking));
  r = await chat({ model: 'relay-an/claude-sonnet-4-5-high', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.model === 'claude-sonnet-4-5' && L.body.thinking?.type === 'enabled' && L.body.thinking.budget_tokens === 16384 && L.body.output_config == null, 'Claude 4.5 -high → extended thinking budget 16384，不发 effort', JSON.stringify(L.body.thinking));
  r = await chat({ model: 'relay-an/claude-opus-4-5-high', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'enabled' && L.body.thinking.budget_tokens === 16384 && L.body.output_config?.effort === 'high', 'Claude Opus 4.5 同时发 budget_tokens 与 output_config.effort');
  r = await chat({ model: 'relay-an/claude-opus-4-5-xhigh', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.budget_tokens === 32768 && L.body.output_config?.effort === 'high', 'Opus 4.5 预算可以到 xhigh，effort 只接受 low/medium/high', JSON.stringify({ thinking: L.body.thinking, output_config: L.body.output_config }));
  r = await chat({ model: 'relay-an/claude-sonnet-4-6-high', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 });
  L = await last('an');
  ok(L.body.model === 'claude-sonnet-4-6' && L.body.thinking?.type === 'adaptive' && L.body.thinking.display === 'summarized' && L.body.thinking.budget_tokens == null && L.body.output_config?.effort === 'high' && L.body.temperature == null, 'Claude 4.6 -high → adaptive + effort，不发 budget_tokens', JSON.stringify({ thinking: L.body.thinking, output_config: L.body.output_config }));
  r = await chat({ model: 'relay-an/claude-sonnet-4-6-xhigh', messages: [{ role: 'user', content: 'hi' }], stream: true });
  L = await last('an');
  ok(L.body.stream === true && L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'high', 'Claude Sonnet 4.6 无 xhigh，-xhigh 向下夹到 high');
  r = await chat({ model: 'relay-an/claude-sonnet-4-6-max', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'max', 'Claude Sonnet 4.6 支持 max，-max 原样发送');
  r = await chat({ model: 'relay-an/claude-opus-5-5-max', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.model === 'claude-opus-5-5' && L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'max', 'Claude Opus 5.5 -max → effort max');
  r = await chat({ model: 'relay-an/claude-opus-4-7-xhigh', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'xhigh', 'Claude Opus 4.7 -xhigh → effort xhigh');
  r = await chat({ model: 'relay-an/claude-opus-5-5-minimal', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'low', 'Claude Opus 5.5 -minimal → effort low（API 无 minimal）');
  r = await chat({ model: 'relay-an/claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' });
  L = await last('an');
  ok(L.body.thinking?.type === 'disabled' && L.body.output_config == null, 'adaptive 且允许关闭的模型，reasoning_effort=off → thinking disabled');
  r = await chat({ model: 'relay-an/claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' });
  L = await last('an');
  ok(L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'low', 'Opus 5.5 不能关闭思考，off 夹到最低档 low', JSON.stringify({ thinking: L.body.thinking, output_config: L.body.output_config }));
  r = await chat({ model: 'relay-claude-mock-1-low', messages: USER, tools: TOOLS });
  const tcThink = r.json?.choices?.[0]?.message?.tool_calls?.[0];
  ok(r.status === 200 && r.json.choices[0].message.reasoning_content === 'ponder' && tcThink?.id === 'toolu_01', 'anthropic 非流式思考 + tool_use', r.text.slice(0, 300));
  L = await last('an');
  ok(String(L.headers['anthropic-beta'] || '').includes('interleaved-thinking-2025-05-14'), '手动 extended thinking 带工具时加 interleaved-thinking beta');
  r = await chat({ model: 'relay-claude-mock-1-low', messages: [...USER, { role: 'assistant', content: null, tool_calls: [tcThink] }, { role: 'tool', tool_call_id: tcThink.id, content: 'sunny 25C' }], tools: TOOLS });
  L = await last('an');
  const asst = (L.body.messages || []).find(m => m.role === 'assistant');
  ok(r.status === 200 && asst?.content?.[0]?.type === 'thinking' && asst.content[0].signature === 'sig-think' && asst.content.some(b => b.type === 'tool_use' && b.id === 'toolu_01'), '非流式工具轮次回传 thinking signature', JSON.stringify(asst?.content));
  r = await chat({ model: 'relay-claude-mock-1-low', messages: USER, tools: TOOLS, stream: true });
  a = assemble(parseSse(r.text).chunks);
  ok(a.reasoning === 'ponder' && a.tools[0]?.id === 'toolu_01', '流式思考 + tool_use');
  r = await chat({ model: 'relay-claude-mock-1-low', messages: [...USER, { role: 'assistant', content: null, tool_calls: [{ id: a.tools[0].id, type: 'function', function: { name: 'get_weather', arguments: a.tools[0].arguments } }] }, { role: 'tool', tool_call_id: a.tools[0].id, content: 'sunny 25C' }], tools: TOOLS, stream: true });
  L = await last('an');
  const asstS = (L.body.messages || []).find(m => m.role === 'assistant');
  ok(r.status === 200 && asstS?.content?.[0]?.signature === 'sig-stream' && asstS.content.some(b => b.type === 'tool_use'), '流式 signature_delta 在下一轮 tool 回传', JSON.stringify(asstS?.content));
  r = await chat({ model: 'relay-claude-mock-1', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', thinking_blocks: [{ type: 'thinking', thinking: 'kept', signature: 'sig-client' }, { type: 'redacted_thinking', data: 'enc' }], tool_calls: [{ id: 'toolu_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }] }, { role: 'tool', tool_call_id: 'toolu_x', content: 'sunny' }], tools: TOOLS });
  L = await last('an');
  const clientAsst = (L.body.messages || []).find(m => m.role === 'assistant');
  ok(r.status === 200 && clientAsst?.content?.[0]?.signature === 'sig-client' && clientAsst.content[1]?.type === 'redacted_thinking' && clientAsst.content[1].data === 'enc' && clientAsst.content[2]?.type === 'tool_use', '客户端带回的 thinking / redacted_thinking 原样转发给 Anthropic', JSON.stringify(clientAsst?.content));

  console.log('\n[gemini]');
  r = await chat({ model: 'relay-gemini-mock', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], max_tokens: 50, stop: ['X'] });
  L = await last('gm');
  ok(r.status === 200 && r.json.choices[0].message.content === 'pong from gemini model=gemini-mock', 'gemini 非流式', r.text);
  ok(L.path === '/gm/v1beta/models/gemini-mock:generateContent' && L.headers['x-goog-api-key'] === 'sk-gm' && L.body.systemInstruction.parts[0].text === 'sys' && L.body.generationConfig.maxOutputTokens === 50, 'gemini URL / key 头 / systemInstruction / generationConfig', L.path);
  ok(r.json.usage.prompt_tokens === 30 && r.json.usage.completion_tokens === 10, 'gemini usage（含 thoughts）');
  r = await chat({ model: 'relay-gemini-mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
  a = assemble(parseSse(r.text).chunks); L = await last('gm');
  ok(r.status === 200 && a.content === 'pong from gemini model=gemini-mock' && a.reasoning === 'thinking...' && L.path.includes('streamGenerateContent?alt=sse'), 'gemini 流式（alt=sse，thought → reasoning_content）', r.text.slice(0, 300));
  await toolRoundTrip('relay-gemini-mock', 'gemini');
  L = await last('gm');
  ok(L.body.tools[0].functionDeclarations[0].name === 'get_weather' && L.body.contents.some(c => c.role === 'model' && c.parts[0].functionCall) && L.body.contents.some(c => c.parts.some(p => p.functionResponse?.name === 'get_weather')), 'gemini：tools → functionDeclarations，tool_calls → functionCall，tool → functionResponse；thoughtSignature 回传（mock 校验）');
  r = await chat({ model: 'relay-gm/gemini-2.5-flash-low', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('gm');
  ok(r.status === 200 && L.path.includes(':generateContent') && !L.path.includes('stream') && L.body.generationConfig.thinkingConfig.thinkingBudget === 1024 && L.body.generationConfig.thinkingConfig.includeThoughts === true && L.body.generationConfig.thinkingConfig.thinkingLevel == null, 'gemini 2.5 非流式 -low → thinkingBudget 1024 + includeThoughts', JSON.stringify(L.body.generationConfig));
  r = await chat({ model: 'relay-gm/gemini-2.5-flash-low', messages: [{ role: 'user', content: 'hi' }], stream: true });
  L = await last('gm');
  ok(r.status === 200 && L.path.includes('streamGenerateContent?alt=sse') && L.body.generationConfig.thinkingConfig.thinkingBudget === 1024 && L.body.generationConfig.thinkingConfig.includeThoughts === true, 'gemini 2.5 流式同样带 thinkingBudget');
  r = await chat({ model: 'relay-gm/gemini-3-flash-high', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('gm');
  ok(L.body.generationConfig.thinkingConfig.thinkingLevel === 'high' && L.body.generationConfig.thinkingConfig.includeThoughts === true && L.body.generationConfig.thinkingConfig.thinkingBudget == null, 'gemini 3 -high → thinkingLevel high，不发 thinkingBudget', JSON.stringify(L.body.generationConfig.thinkingConfig));
  r = await chat({ model: 'relay-gm/gemini-3-flash-xhigh', messages: [{ role: 'user', content: 'hi' }], stream: true });
  L = await last('gm');
  ok(L.path.includes('streamGenerateContent') && L.body.generationConfig.thinkingConfig.thinkingLevel === 'high', 'gemini 3 流式 -xhigh → thinkingLevel high');
  r = await chat({ model: 'relay-gm/gemini-4-argon-minimal', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('gm');
  ok(L.body.generationConfig.thinkingConfig.thinkingLevel === 'low', 'Gemini 4 不支持 minimal，-minimal → thinkingLevel low');
  r = await chat({ model: 'relay-gm/gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' });
  L = await last('gm');
  ok(L.body.generationConfig.thinkingConfig.thinkingBudget === 0 && L.body.generationConfig.thinkingConfig.includeThoughts === false, 'gemini 2.5 Flash off → thinkingBudget 0');
  r = await chat({ model: 'relay-gm/gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' });
  L = await last('gm');
  ok(L.body.generationConfig?.thinkingConfig?.thinkingBudget === 512 && L.body.generationConfig.thinkingConfig.includeThoughts === true, 'gemini 2.5 Pro 不能关闭思考，off 夹到最低预算 512', JSON.stringify(L.body.generationConfig));

  console.log('\n[azure]');
  r = await chat({ model: 'relay-gpt4o-deploy', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('az');
  ok(r.status === 200 && /deployment:gpt4o-deploy/.test(r.text) && L.headers['api-key'] === 'sk-az' && L.path.includes('api-version=2024-10-21'), 'azure deployment URL + api-key 头 + api-version', r.text);

  console.log('\n[备用上游 fallback]');
  r = await chat({ model: 'relay-fb-test', messages: [{ role: 'user', content: 'hi' }] });
  ok(r.status === 200 && /pong from openai/.test(r.text), '上游 503 → 自动切到备用 oa', r.text);
  r = await chat({ model: 'relay-dead-test', messages: [{ role: 'user', content: 'hi' }], stream: true });
  ok(r.status === 200 && assemble(parseSse(r.text).chunks).content.startsWith('pong from openai'), '连接被拒 → 备用（流式）', r.text.slice(0, 200));
  const t0 = Date.now();
  r = await chat({ model: 'relay-slow-test', messages: [{ role: 'user', content: 'hi' }] });
  ok(r.status === 200 && /pong from openai/.test(r.text) && Date.now() - t0 < 2500, `超时(1s) → 备用（耗时 ${Date.now() - t0}ms）`, r.text);
  r = await chat({ model: 'relay-fb-test', messages: [{ role: 'user', content: 'hi' }] }, { 'x-relay-no-fallback': '1' });
  ok(r.status === 503, '关闭 fallback 时返回上游的 503', r.status);

  console.log('\n[管理页]');
  r = await req('GET', '/admin'); ok(r.status === 200 && r.text.includes('type="password"') && !r.text.includes('upstream/save'), '未登录访问 /admin 只得到登录页');
  r = await req('GET', '/admin/api/state', { headers: { 'x-relay-admin': '1' } }); ok(r.status === 401, '未登录调用 API → 401');
  r = await req('GET', '/admin', { headers: { 'cf-connecting-ip': '1.2.3.4' } }); ok(r.status === 404, '经隧道（带 Cf-Connecting-Ip）访问 /admin → 404');
  r = await req('GET', '/admin', { headers: { 'cf-ray': 'abc-IAD' } }); ok(r.status === 404, '带 Cf-Ray 访问 /admin → 404');
  r = await req('GET', '/admin', { headers: { forwarded: 'for=1.2.3.4;proto=https' } }); ok(r.status === 404, '带 Forwarded 访问 /admin → 404');
  r = await req('POST', '/admin/api/login', { body: { password: PASSWORD }, headers: { 'x-relay-admin': '1', 'x-forwarded-for': '1.2.3.4' } }); ok(r.status === 404, '经反代访问登录接口 → 404');
  r = await req('POST', '/admin/api/login', { body: { password: PASSWORD } }); ok(r.status === 403, '缺少 x-relay-admin 头（CSRF 防护）→ 403');
  r = await req('POST', '/admin/api/login', { body: { password: 'wrong' }, headers: { 'x-relay-admin': '1' } }); ok(r.status === 401, '错误密码 → 401');
  r = await req('POST', '/admin/api/login', { body: { password: PASSWORD }, headers: { 'x-relay-admin': '1' } });
  const sc = String(r.headers['set-cookie'] || '');
  ok(r.status === 200 && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), '登录成功，HttpOnly + SameSite=Strict cookie', sc);
  COOKIE = sc.split(';')[0];
  r = await req('GET', '/admin', { headers: { cookie: COOKIE } }); ok(r.status === 200 && r.text.includes('upstream/save'), '登录后 /admin 返回完整管理页');
  const adminPage = r.text;
  ok(adminPage.includes('思考深度') && adminPage.includes('id="eEffort"') && adminPage.includes('value="max"') && adminPage.includes('id="eBudget"') && adminPage.includes('id="eModelReason"') && adminPage.includes('levels:'), '管理页可设置思考深度（含 max）、预算和按模型覆盖');
  async function putUp(name, extra) {
    const u = (await admin('state')).json.upstreams.find(x => x.name === name);
    return admin('upstream/save', { original_name: name, upstream: {
      name: u.name, format: u.format, base_url: u.base_url, api_key: '', api_key_env: u.api_key_env || '',
      fallback: (u.fallback || []).join(', '), api_version: u.api_version || '', key_in_query: !!u.key_in_query,
      timeout_ms: u.timeout_ms || 0, enabled: u.enabled !== false, headers: u.headers || {}, models: (u.models || []).join('\n'),
      reasoning_effort: extra.reasoning_effort ?? '',
      reasoning_budget: Object.prototype.hasOwnProperty.call(extra, 'reasoning_budget') ? extra.reasoning_budget : null,
      model_reasoning: extra.model_reasoning || {},
    } });
  }
  console.log('\n[思考深度配置优先级]');
  r = await putUp('an', { reasoning_effort: 'low', reasoning_budget: 3000, model_reasoning: { 'claude-mock-1': { effort: 'medium', budget: 6000 }, bad: { effort: 'nope' } } });
  ok(r.status === 200 && r.json.upstream.reasoning_effort === 'low' && r.json.upstream.reasoning_budget === 3000 && r.json.upstream.model_reasoning['claude-mock-1'].budget === 6000 && r.json.upstream.model_reasoning.bad == null, '保存思考默认值，并丢掉非法的按模型强度', JSON.stringify(r.json.upstream.model_reasoning));
  ok(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).upstreams.find(u => u.name === 'an').reasoning_budget === 3000, '思考配置写入 config.json');
  r = await chat({ model: 'relay-claude-mock-1', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'enabled' && L.body.thinking.budget_tokens === 6000, '按模型预算优先于上游预算', JSON.stringify(L.body.thinking));
  r = await chat({ model: 'relay-claude-mock-1', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' });
  L = await last('an');
  ok(L.body.thinking?.budget_tokens === 16384, '请求 reasoning_effort 优先于按模型预算');
  r = await chat({ model: 'relay-claude-mock-1-xhigh', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.model === 'claude-mock-1' && L.body.thinking?.budget_tokens === 32768, '模型名后缀优先于按模型与上游默认');
  r = await chat({ model: 'relay-an/claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'enabled' && L.body.thinking.budget_tokens === 3000 && L.body.output_config == null, '未单独配置的模型使用上游默认强度和预算');
  r = await chat({ model: 'relay-an/claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking?.type === 'adaptive' && L.body.output_config?.effort === 'low' && L.body.thinking.budget_tokens == null, '上游默认 low 在 Claude 4.6 上变成 adaptive effort，预算不发给 adaptive 模型');
  r = await putUp('gm', { reasoning_effort: 'low', reasoning_budget: 2222, model_reasoning: { 'gemini-2.5-flash': { effort: 'high', budget: 4096 } } });
  ok(r.status === 200, '保存 gemini 思考配置', r.text);
  r = await chat({ model: 'relay-gm/gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('gm');
  ok(L.body.generationConfig.thinkingConfig.thinkingBudget === 4096 && L.body.generationConfig.thinkingConfig.includeThoughts === true, 'gemini 按模型预算覆盖上游预算');
  r = await chat({ model: 'relay-gm/gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('gm');
  ok(L.body.generationConfig.thinkingConfig.thinkingBudget === 2222, 'gemini 未单独配置的 2.5 模型用上游预算');
  r = await chat({ model: 'relay-gm/gemini-2.5-flash-high', messages: [{ role: 'user', content: 'hi' }], stream: true });
  L = await last('gm');
  ok(L.body.generationConfig.thinkingConfig.thinkingBudget === 16384 && L.path.includes('streamGenerateContent'), 'gemini 后缀优先于按模型预算（流式）');
  r = await putUp('oa', { model_reasoning: { 'gpt-5.6': { levels: ['low', 'medium', 'high'] }, 'effort-reject': { levels: ['low', 'medium', 'high', 'xhigh', 'max'] }, bad: { levels: ['nope'] } } });
  ok(r.status === 200 && r.json.upstream.model_reasoning['gpt-5.6'].levels.join(',') === 'low,medium,high' && r.json.upstream.model_reasoning['effort-reject'].levels.includes('max') && r.json.upstream.model_reasoning.bad == null, '按模型 levels 覆盖内置能力，非法档位丢掉', JSON.stringify(r.json.upstream.model_reasoning));
  r = await chat({ model: 'relay-oa/gpt-5.6', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' });
  L = await last('oa');
  ok(L.body.model === 'gpt-5.6' && L.body.reasoning_effort === 'high', '配置声明 gpt-5.6 只有 low/medium/high 时，max 夹到 high');
  n0 = (await hits('oa')).length;
  r = await chat({ model: 'relay-oa/effort-reject', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' });
  L = await last('oa');
  const seq = (await hits('oa')).slice(n0);
  ok(r.status === 200 && seq.length === 2 && seq[0].body.reasoning_effort === 'max' && seq[1].body.reasoning_effort === 'xhigh' && L.body.reasoning_effort === 'xhigh', '上游 400 指出 effort 非法时，降一档重试一次', JSON.stringify(seq.map(x => x.body.reasoning_effort)));
  const lgClamp = (await admin('logs')).json.logs.find(l => l.model === 'relay-oa/effort-reject');
  ok(lgClamp && lgClamp.real_model === 'effort-reject (effort=max→xhigh)', '重试后的 real_model 是实际发出的档', lgClamp && lgClamp.real_model);
  await putUp('oa', {});
  await putUp('an', {}); await putUp('gm', {});
  r = await chat({ model: 'relay-claude-mock-1', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('an');
  ok(L.body.thinking == null && L.body.max_tokens === 8192, '清空思考配置后不再发送 thinking');
  ok(['添加上游', '测试通过', '启动隧道', 'Cursor 已请求'].every(s => adminPage.includes(s)), '管理页包含四步清单');
  ok(adminPage.includes('confirm_admin_remote') && adminPage.includes('远程管理已开启'), '远程管理需确认，开启时有警告');
  r = await admin('state');
  ok(r.status === 200 && r.json.upstreams.length === 11 && !r.text.includes('sk-oa') && !r.text.includes('sk-an') && r.json.upstreams.find(u => u.name === 'oa').api_key_set, 'state 接口不泄露上游 key（只返回掩码）');
  ok(r.json.admin_remote === false, 'state.admin_remote 默认 false');
  ok(r.json.client_seen === true, '客户端请求会记入 client_seen');
  ok(r.json.cursor.api_key === TOKEN && r.json.cursor.models.includes('relay-gpt-mock'), 'Cursor 设置面板数据（api_key / 模型名）');
  r = await admin('settings', { admin_remote: true });
  ok(r.status === 400 && (await admin('state')).json.admin_remote === false, '未带确认不能开启远程管理', r.text);
  r = await admin('settings', { admin_remote: 'true' });
  ok(r.status === 400 && (await admin('state')).json.admin_remote === false, '字符串 true 且未确认不能开启远程管理');
  // 新增上游
  r = await admin('upstream/save', { upstream: { name: 'new1', format: 'openai', base_url: `${M}/oa/v1`, api_key: 'sk-oa', models: 'gpt-new-a, gpt-new-b', headers: 'X-Custom: fromui' } });
  ok(r.status === 200 && r.json.upstream.api_key_masked && !r.text.includes('sk-oa'), '新增上游（返回值 key 已掩码）', r.text);
  r = await chat({ model: 'relay-gpt-new-a', messages: [{ role: 'user', content: 'hi' }] });
  L = await last('oa'); ok(r.status === 200 && L.body.model === 'gpt-new-a' && L.headers['x-custom'] === 'fromui', '新上游立即生效（无需重启）');
  // 编辑但不改 key：key 保留
  r = await admin('upstream/save', { original_name: 'new1', upstream: { name: 'new1', format: 'openai', base_url: `${M}/oa/v1`, api_key: '', models: 'gpt-new-a' } });
  r = await chat({ model: 'relay-gpt-new-a', messages: [{ role: 'user', content: 'hi' }] });
  ok(r.status === 200, '编辑时 key 留空 → 保留原 key');
  ok((fs.statSync(CONFIG).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(CONFIG, 'utf8')).upstreams.some(u => u.name === 'new1'), '修改已写入 config.json 且仍为 600');
  r = await admin('upstream/models', { name: 'oa' }); ok(r.status === 200 && r.json.models.includes('gpt-mock'), '“获取模型” openai');
  r = await admin('upstream/models', { name: 'an' }); ok(r.status === 200 && r.json.models.includes('claude-mock-1'), '“获取模型” anthropic');
  r = await admin('upstream/models', { name: 'gm' }); ok(r.status === 200 && r.json.models.includes('gemini-mock') && !r.json.models.includes('embed-mock'), '“获取模型” gemini（过滤非 generateContent）');
  r = await admin('upstream/models', { draft: { name: 'tmp', format: 'openai', base_url: `${M}/oa/v1` }, original_name: 'oa' }); ok(r.status === 200 && r.json.models.length === 2, '未保存草稿也能获取模型（沿用原 key）', r.text);
  r = await admin('upstream/models', { name: 'az' }); ok(r.status === 502 && /deployment/.test(r.json.error.message), 'Azure 经典接口提示手动填写 deployment');
  for (const [u, m] of [['oa', 'gpt-mock'], ['rs', 'gpt-5-mock'], ['an', 'claude-mock-1'], ['gm', 'gemini-mock'], ['az', 'gpt4o-deploy'], ['local', 'llama3']]) {
    r = await admin('test', { upstream: u, model: m });
    ok(r.status === 200 && r.json.success && /pong/.test(r.json.reply) && r.json.ms >= 0, `“测试”按钮：${u}/${m} → ${r.json.ms}ms “${(r.json.reply || r.json.error || '').slice(0, 40)}”`);
  }
  r = await admin('test', { upstream: 'bad', model: 'gpt-mock' }); ok(r.status === 200 && r.json.success === false && r.json.status === 503, '“测试”失败时显示错误（不走 fallback）', r.text);
  r = await admin('upstream/save', { upstream: { name: 'badkey', format: 'openai', base_url: `${M}/oa/v1`, api_key: 'wrong', models: 'gpt-mock' } });
  r = await admin('test', { upstream: 'badkey', model: 'gpt-mock' });
  ok(r.json.success === false && r.json.status === 401 && /密钥/.test(r.json.hint || ''), '401 提示密钥被拒绝', r.json.hint || r.text);
  await admin('upstream/delete', { name: 'badkey' });
  r = await admin('test', { upstream: 'an', model: 'bad-model' });
  ok(r.json.status === 404 && /模型/.test(r.json.hint || ''), '404 提示没有这个模型', r.json.hint || r.text);
  r = await admin('upstream/save', { upstream: { name: 'badurl', format: 'openai', base_url: `${M}/nope/v1`, api_key: 'x', models: 'gpt-mock' } });
  r = await admin('test', { upstream: 'badurl', model: 'gpt-mock' });
  ok(r.json.status === 404 && /Base URL/.test(r.json.hint || ''), '404 提示 Base URL 路径不对', r.json.hint || r.text);
  await admin('upstream/delete', { name: 'badurl' });
  r = await admin('test', { upstream: 'off', model: 'ghost' }); ok(r.json.success === true, '停用的上游也能单独测试');
  r = await admin('upstream/toggle', { name: 'new1' }); ok(r.json.enabled === false, '停用上游');
  r = await req('GET', '/v1/models', { headers: auth() }); ok(!r.json.data.some(m => m.id === 'relay-gpt-new-b'), '停用后模型从列表消失');
  r = await admin('upstream/delete', { name: 'new1' }); ok(r.status === 200, '删除上游');
  r = await admin('upstream/save', { upstream: { name: 'bad name!', format: 'openai' } }); ok(r.status === 400, '非法名称被拒绝');
  r = await admin('upstream/save', { upstream: { name: 'x2', format: 'openai', base_url: 'ftp://a' } }); ok(r.status === 400, '非法 base_url 被拒绝');
  r = await admin('settings', { model_prefix: 'c-' });
  r = await chat({ model: 'c-gpt-mock', messages: [{ role: 'user', content: 'hi' }] }); L = await last('oa');
  ok(r.status === 200 && L.body.model === 'gpt-mock', '改前缀立即生效');
  await admin('settings', { model_prefix: 'relay-', models: { 'my-claude': { upstream: 'an', model: 'claude-mock-1' }, 'fast': { upstream: 'oa', model: 'gpt-mock' } } });
  r = await chat({ model: 'relay-fast', messages: [{ role: 'user', content: 'hi' }] }); L = await last('oa'); ok(r.status === 200 && L.body.model === 'gpt-mock', '在页面新增别名 fast → oa/gpt-mock');
  const oldTok = TOKEN;
  r = await admin('token/regenerate', {}); TOKEN = r.json.proxy_token;
  ok(TOKEN && TOKEN !== oldTok, '重新生成 proxy_token');
  r = await req('GET', '/v1/models', { headers: { authorization: `Bearer ${oldTok}` } }); ok(r.status === 401, '旧 token 立即失效');
  r = await admin('logs'); const lg = r.json.logs;
  ok(lg.length > 10 && lg[0].time && 'prompt_tokens' in lg[0] && lg.some(l => l.fallback_from), '请求日志（时间/模型/上游/状态/耗时/tokens/fallback）');
  ok(!JSON.stringify(lg).match(/sk-(oa|an|gm|rs|az)|sunny 25C|weather in Beijing/), '日志不含 key 和对话内容');
  ok(!srvOut.join('').match(/sk-(oa|an|gm|rs|az)/), '服务端控制台输出不含 key');
  r = await req('POST', '/admin/api/settings', { body: { model_prefix: 'x' }, headers: { 'x-relay-admin': '1', cookie: COOKIE, 'content-type': 'text/plain' } }); ok(r.status === 415, '非 JSON 的管理请求被拒');
  r = await admin('password', { password: 'short' }); ok(r.status === 400, '新密码太短被拒');
  r = await admin('password', { password: 'new-password-123' }); ok(r.status === 200, '修改管理密码');
  r = await admin('logout', {}); r = await admin('state'); ok(r.status === 401, '退出登录后 cookie 失效');
  r = await req('POST', '/admin/api/login', { body: { password: 'new-password-123' }, headers: { 'x-relay-admin': '1' } }); ok(r.status === 200, '用新密码登录');
  COOKIE = String(r.headers['set-cookie']).split(';')[0];
  for (let i = 0; i < 6; i++) r = await req('POST', '/admin/api/login', { body: { password: 'bad' }, headers: { 'x-relay-admin': '1' } });
  ok(r.status === 429, '连续输错密码触发限流 429');

  r = await admin('tunnel/ack', { url: 'https://old.trycloudflare.com' });
  ok(r.status === 200 && (await admin('state')).json.known_tunnel_url === 'https://old.trycloudflare.com' && (await admin('state')).json.tunnel.url_changed === false, '记下上次隧道地址；隧道未开时不提示变更');

  console.log('\n[远程管理默认关闭]');
  await remoteMatrix();

  if (process.env.TEST_TUNNEL === '1') {
    console.log('\n[cloudflared 隧道]');
    r = await admin('tunnel/start', {});
    const url = r.json?.tunnel?.url, tstate = r.json?.tunnel?.state;
    ok(r.status === 200 && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url || ''), '管理页启动隧道并拿到公网 URL：' + url + '（状态 ' + tstate + '）', r.text);
    if (tstate !== 'running') ok(false, '隧道连通（Registered tunnel connection）', r.json?.tunnel?.error);
    else if (url) {
      // 快速隧道域名刚公布时权威 DNS 可能短暂 NXDOMAIN，解析器按 SOA 负缓存约 60s。
      // 共用一个盖过负缓存的截止时间；全部失败时返回可断言的结果，避免 fetch 抛错把测试打崩。
      const deadline = Date.now() + 75000;
      const get = async (p, h = {}, opts = {}) => {
        let x, err;
        do {
          try { x = await fetch(url + p, { headers: h, ...opts }); if (x && ![502, 503, 530].includes(x.status)) return x; }
          catch (e) { err = e; }
          if (Date.now() >= deadline) break;
          await sleep(1500);
        } while (Date.now() < deadline);
        if (x) return x;
        const detail = String(err?.cause?.code || err?.message || 'no response');
        return { status: 0, text: async () => detail, json: async () => ({}) };
      };
      const js = async (x) => { try { return await x.json(); } catch { return {}; } };
      let x = await get('/health'); ok(x && x.status === 200 && (await js(x)).ok, '公网 /health', x && x.status);
      x = await get('/v1/models', { authorization: `Bearer ${TOKEN}` }); const mj = await js(x); ok(x.status === 200 && (mj.data || []).some(m => m.id === 'relay-gpt-mock'), '公网 /v1/models（带 token）', x.status);
      x = await get('/v1/models'); ok(x.status === 401, '公网 /v1/models 无 token → 401', x.status);
      x = await get('/admin'); ok(x.status === 404, '公网访问 /admin → 404（管理页不对隧道开放）', x.status);
      x = await get('/admin/api/state'); ok(x.status === 404, '公网访问管理 API → 404', x.status);
      x = await get('/v1/chat/completions', { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ model: 'relay-claude-mock-1', messages: [{ role: 'user', content: 'hi' }], stream: true }) });
      const tx = await x.text(); ok(x.status === 200 && assemble(parseSse(tx).chunks).content === 'pong from anthropic model=claude-mock-1', '公网 chat/completions 流式（anthropic 翻译）');
      r = await admin('state'); ok(r.json.cursor.base_url === url + '/v1', 'Cursor 面板显示 Base URL = 隧道/v1');
    }
    r = await admin('tunnel/stop', {}); await sleep(500);
    r = await admin('state'); ok(r.json.tunnel.state === 'stopped', '管理页停止隧道');
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  cleanup(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
