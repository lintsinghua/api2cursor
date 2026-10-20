// 模拟各种上游：/oa (openai) /rs (responses) /an (anthropic) /gm (gemini) /az (azure) /bad (503) /slow (超时)
import http from 'node:http';
const PORT = Number(process.env.MOCK_PORT || 9901);
const last = {};
const hits = {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = (res, s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream' });
const lastUserText = (msgs) => { const m = [...msgs].reverse().find(m => m.role === 'user'); return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content); };

async function openaiChat(req, res, body, tag) {
  const msgs = body.messages || [];
  const lastMsg = msgs[msgs.length - 1];
  const wantTool = body.tools?.length && lastMsg?.role === 'user';
  const text = lastMsg?.role === 'tool' ? `tool said: ${lastMsg.content}` : `pong from ${tag} model=${body.model}`;
  if (!body.stream) {
    const message = wantTool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_oa1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }] } : { role: 'assistant', content: text };
    return json(res, 200, { id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: wantTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
  }
  sse(res);
  const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const c = (delta, f = null) => ({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: f }] });
  w(c({ role: 'assistant', content: '' }));
  if (wantTool) {
    w(c({ tool_calls: [{ index: 0, id: 'call_oa1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }));
    for (const p of ['{"city"', ':"Beij', 'ing"}']) { await sleep(30); w(c({ tool_calls: [{ index: 0, function: { arguments: p } }] })); }
    w(c({}, 'tool_calls'));
  } else {
    for (const p of text.match(/.{1,6}/g)) { await sleep(30); w(c({ content: p })); }
    w(c({}, 'stop'));
  }
  if (body.stream_options?.include_usage) w({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
  res.end('data: [DONE]\n\n');
}

async function anthropic(req, res, body) {
  if (req.headers['x-api-key'] !== 'sk-an' || req.headers['anthropic-version'] !== '2023-06-01') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
  if (body.model === 'bad-model') return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'model: bad-model' } });
  const lastMsg = body.messages[body.messages.length - 1];
  const tr = lastMsg.content.find?.(b => b.type === 'tool_result');
  const wantTool = body.tools?.length && !tr;
  const text = tr ? `tool said: ${tr.content}` : `pong from anthropic model=${body.model}`;
  const thinkingOn = body.thinking && body.thinking.type && body.thinking.type !== 'disabled';
  if (!body.stream) {
    const content = [];
    if (thinkingOn) content.push({ type: 'thinking', thinking: 'ponder', signature: 'sig-think' });
    if (wantTool) content.push({ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Beijing' } });
    else content.push({ type: 'text', text });
    return json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason: wantTool ? 'tool_use' : 'end_turn', usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5 } });
  }
  sse(res);
  const w = (ev, o) => res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...o })}\n\n`);
  w('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 20, output_tokens: 1 } } });
  w('ping', {});
  let idx = 0;
  if (thinkingOn) {
    w('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
    w('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: 'ponder' } });
    w('content_block_delta', { index: idx, delta: { type: 'signature_delta', signature: 'sig-stream' } });
    w('content_block_stop', { index: idx });
    idx++;
  }
  w('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
  for (const p of (wantTool ? 'Let me check.' : text).match(/.{1,5}/g)) { await sleep(25); w('content_block_delta', { index: idx, delta: { type: 'text_delta', text: p } }); }
  w('content_block_stop', { index: idx });
  if (wantTool) {
    idx++;
    w('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} } });
    for (const p of ['', '{"city": ', '"Beijing"}']) { await sleep(25); w('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: p } }); }
    w('content_block_stop', { index: idx });
  }
  w('message_delta', { delta: { stop_reason: wantTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 15 } });
  w('message_stop', {});
  res.end();
}

async function gemini(req, res, body, model, stream) {
  if (req.headers['x-goog-api-key'] !== 'sk-gm') return json(res, 403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } });
  const lastC = body.contents[body.contents.length - 1];
  const fr = lastC.parts.find(p => p.functionResponse);
  if (fr) { // 检查 thoughtSignature 是否回传
    const modelTurn = body.contents.find(c => c.role === 'model' && c.parts.some(p => p.functionCall));
    const sig = modelTurn?.parts.find(p => p.functionCall)?.thoughtSignature;
    if (sig !== 'sig-abc') return json(res, 400, { error: { code: 400, message: 'missing thought signature, got ' + sig, status: 'INVALID_ARGUMENT' } });
  }
  const wantTool = body.tools?.length && !fr;
  const text = fr ? `tool said: ${JSON.stringify(fr.functionResponse.response)}` : `pong from gemini model=${model}`;
  const usage = { promptTokenCount: 30, candidatesTokenCount: 6, thoughtsTokenCount: 4, totalTokenCount: 40 };
  const parts = wantTool ? [{ functionCall: { name: 'get_weather', args: { city: 'Beijing' } }, thoughtSignature: 'sig-abc' }] : [{ text }];
  if (!stream) return json(res, 200, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: usage });
  sse(res);
  const w = (o) => res.write(`data: ${JSON.stringify(o)}\r\n\r\n`);
  if (wantTool) w({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: usage });
  else {
    w({ candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }] } }] });
    const ps = text.match(/.{1,7}/g);
    for (let i = 0; i < ps.length; i++) { await sleep(25); w({ candidates: [{ content: { role: 'model', parts: [{ text: ps[i] }] }, ...(i === ps.length - 1 ? { finishReason: 'STOP' } : {}) }], ...(i === ps.length - 1 ? { usageMetadata: usage } : {}) }); }
  }
  res.end();
}

async function responses(req, res, body) {
  if (req.headers.authorization !== 'Bearer sk-rs') return json(res, 401, { error: { message: 'bad key', type: 'invalid_request_error' } });
  const lastIt = body.input[body.input.length - 1];
  const isOut = lastIt.type === 'function_call_output';
  const wantTool = body.tools?.length && !isOut;
  const text = isOut ? `tool said: ${lastIt.output}` : `pong from responses model=${body.model} effort=${body.reasoning?.effort || 'none'}`;
  const usage = { input_tokens: 40, output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 } };
  const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_rs1', name: 'get_weather', arguments: '{"city":"Beijing"}', status: 'completed' };
  const msg = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] };
  if (!body.stream) return json(res, 200, { id: 'resp_1', object: 'response', status: 'completed', model: body.model, output: wantTool ? [{ type: 'reasoning', id: 'rs_1', summary: [] }, fc] : [msg], usage });
  sse(res);
  const w = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  w({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
  if (wantTool) {
    w({ type: 'response.output_item.added', output_index: 0, item: { ...fc, arguments: '', status: 'in_progress' } });
    for (const p of ['{"city"', ':"Beijing"}']) { await sleep(25); w({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: p }); }
    w({ type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: fc.arguments });
    w({ type: 'response.output_item.done', output_index: 0, item: fc });
  } else {
    w({ type: 'response.output_item.added', output_index: 0, item: { ...msg, content: [] } });
    for (const p of text.match(/.{1,6}/g)) { await sleep(25); w({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: p }); }
  }
  w({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage } });
  res.end();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let raw = ''; for await (const c of req) raw += c;
  let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { }
  const p = url.pathname;
  if (p.startsWith('/_last/')) return json(res, 200, last[p.slice(7)] || null);
  if (p.startsWith('/_hits/')) return json(res, 200, hits[p.slice(7)] || []);
  const tag = p.split('/')[1];
  if (req.method === 'POST') {
    const rec = { path: p + url.search, headers: req.headers, body };
    last[tag] = rec;
    (hits[tag] ||= []).push(rec);
    if (hits[tag].length > 80) hits[tag].shift();
  }
  try {
    if (p === '/oa/v1/models' || p === '/rs/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'gpt-mock' }, { id: 'claude-mock-via-oa' }] });
    if (p === '/an/v1/models') return json(res, 200, { data: [{ id: 'claude-mock-1', type: 'model' }] });
    if (p === '/gm/v1beta/models') return json(res, 200, { models: [{ name: 'models/gemini-mock', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-mock', supportedGenerationMethods: ['embedContent'] }] });
    if (p === '/oa/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer sk-oa') return json(res, 401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (body.model === 'fail500') return json(res, 500, { error: { message: 'boom', type: 'server_error' } });
      if (body.model === 'fail400') return json(res, 400, { error: { message: 'bad request payload', type: 'invalid_request_error' } });
      if (body.model === 'effort-reject' && body.reasoning_effort === 'max') return json(res, 400, { error: { message: 'Invalid reasoning_effort: max is not supported', type: 'invalid_request_error', param: 'reasoning_effort' } });
      return openaiChat(req, res, body, 'openai');
    }
    if (p === '/local/v1/chat/completions') { if (req.headers.authorization) return json(res, 400, { error: { message: 'unexpected auth' } }); return openaiChat(req, res, body, 'local'); }
    if (p === '/bad/v1/chat/completions') return json(res, 503, { error: { message: 'relay overloaded' } });
    if (p === '/slow/v1/chat/completions') { await sleep(3000); return openaiChat(req, res, body, 'slow'); }
    if (p === '/rs/v1/responses') return responses(req, res, body);
    if (p === '/an/v1/messages') return anthropic(req, res, body);
    let m = /^\/gm\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(p);
    if (m) return gemini(req, res, body, decodeURIComponent(m[1]), m[2] === 'streamGenerateContent');
    m = /^\/az\/openai\/deployments\/([^/]+)\/chat\/completions$/.exec(p);
    if (m) {
      if (req.headers['api-key'] !== 'sk-az' || !url.searchParams.get('api-version')) return json(res, 401, { error: { message: 'azure auth/api-version' } });
      return openaiChat(req, res, { ...body, model: 'deployment:' + m[1] }, 'azure');
    }
    json(res, 404, { error: { message: 'mock 404 ' + p } });
  } catch (e) { json(res, 500, { error: { message: e.message } }); }
}).listen(PORT, '127.0.0.1', () => console.log('mock upstream on', PORT));
