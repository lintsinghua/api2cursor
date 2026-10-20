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

function req(method, p, { body, headers = {}, port = PORT, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
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
  r = await req('POST', '/admin/api/login', { body: { password: PASSWORD }, headers: { 'x-relay-admin': '1', 'x-forwarded-for': '1.2.3.4' } }); ok(r.status === 404, '经反代访问登录接口 → 404');
  r = await req('POST', '/admin/api/login', { body: { password: PASSWORD } }); ok(r.status === 403, '缺少 x-relay-admin 头（CSRF 防护）→ 403');
  r = await req('POST', '/admin/api/login', { body: { password: 'wrong' }, headers: { 'x-relay-admin': '1' } }); ok(r.status === 401, '错误密码 → 401');
  r = await req('POST', '/admin/api/login', { body: { password: PASSWORD }, headers: { 'x-relay-admin': '1' } });
  const sc = String(r.headers['set-cookie'] || '');
  ok(r.status === 200 && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), '登录成功，HttpOnly + SameSite=Strict cookie', sc);
  COOKIE = sc.split(';')[0];
  r = await req('GET', '/admin', { headers: { cookie: COOKIE } }); ok(r.status === 200 && r.text.includes('upstream/save'), '登录后 /admin 返回完整管理页');
  r = await admin('state');
  ok(r.status === 200 && r.json.upstreams.length === 11 && !r.text.includes('sk-oa') && !r.text.includes('sk-an') && r.json.upstreams.find(u => u.name === 'oa').api_key_set, 'state 接口不泄露上游 key（只返回掩码）');
  ok(r.json.cursor.api_key === TOKEN && r.json.cursor.models.includes('relay-gpt-mock'), 'Cursor 设置面板数据（api_key / 模型名）');
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
