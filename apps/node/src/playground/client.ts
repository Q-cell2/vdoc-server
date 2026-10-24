import { generationError } from './generation-error';
import { renderTestTable } from './table';
import { connect, type ClientSession } from '@vrealtime/client';
import { createTestDocument } from './document';
import { createPausableMicrophone } from './microphone';
import { createArticleStream } from './article-stream';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const status = (text: string) => { el('status').textContent = text; };
let session: ClientSession | undefined;
let connection: { sessionId: string; base: string; key: string } | undefined;
let busy = false;
let microphone: ReturnType<typeof createPausableMicrophone> | undefined;
let microphoneBusy = false;
let answer = '';
let responseId = '';
let executionStage = '';
let taskError = '';
let sequence = 0;
const logs: string[] = [];
function log(text: string) { logs.push(new Date().toLocaleTimeString() + ' ' + text); if (logs.length > 80) logs.shift(); el('events').textContent = logs.join('\n'); }
function controls() {
  button('connect').disabled = busy || !!session;
  button('microphone').disabled = busy || !!session;
  button('disconnect').disabled = !session;
  button('send').disabled = !session;
  button('interrupt').disabled = !session;
  const mic = microphone;
  button('mute').disabled = !session || !mic?.attached || microphoneBusy || mic.state === 'starting';
  button('mute').textContent = mic?.state === 'paused' ? '恢复收音' : '暂停收音';
  button('mute').setAttribute('aria-pressed', String(mic?.state === 'paused'));
  el('micStatus').textContent = mic?.state === 'paused' ? '收音已暂停：麦克风已关闭。服务端会确认语音结束，暂停不会取消任务。'
    : mic?.state === 'listening' ? '正在收音。说完后可点击“暂停收音”，停止采集周围声音，当前任务继续。'
    : mic?.state === 'starting' ? '正在启用麦克风…' : '未启用麦克风；文字输入不受影响。';
}
const doc = createTestDocument((renderContent = true) => renderDocument(renderContent));
let documentFrame = 0;
const articleStream = createArticleStream(() => doc.read(), () => {
  if (!documentFrame) documentFrame = requestAnimationFrame(() => { documentFrame = 0; renderDocument(); });
});
function renderDocument(renderContent = true) {
  const value = doc.read();
  el('revision').textContent = `版本 ${value.revision} · ${value.blocks.length} 个内容块 · 本页刷新即清空`;
  const name = el<HTMLInputElement>('documentName');
  if (document.activeElement !== name) name.value = value.title;
  const select = el<HTMLSelectElement>('documents');
  select.replaceChildren(...doc.list().map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; return option; }));
  select.value = value.docId;
  const preview = articleStream.view();
  const contentName = preview?.name === 'insert_test_table' ? '表格' : '文章';
  const draftStatus = el('draftStatus');
  draftStatus.hidden = !preview;
  button('discardDraft').hidden = !preview;
  draftStatus.textContent = !preview ? '' : preview.stale ? '文档已被修改，流式草稿已停止显示；正式写入仍需通过版本校验。'
    : preview.phase === 'cancelled' ? '已停止生成 · 以下片段未完成、未写入文档。'
    : preview.phase === 'failed' ? '写入未成功 · 以下片段仅为草稿，可清除后重试。'
    : preview.phase === 'pending' ? `${contentName}已生成 · 正在校验并写入…`
    : `正在生成${contentName} · 内容实时显示，完成后自动写入。`;
  if (!renderContent && !preview) return;
  const container = el('document');
  const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 64;
  const previousScroll = container.scrollTop;
  const existing = new Map([...container.children].map(node => [(node as HTMLElement).dataset.key, node as HTMLElement]));
  const obtain = (key: string, tag: string, text: string) => {
    const old = existing.get(key);
    const node = old?.tagName.toLowerCase() === tag ? old : document.createElement(tag);
    node.dataset.key = key;
    if (node.textContent !== text && document.activeElement !== node) node.textContent = text;
    return node;
  };
  const nodes = value.blocks.map(block => {
    if (block.kind === 'table') {
      const node = obtain(block.id, 'table', '');
      renderTestTable(node, block.columns ?? [], block.rows ?? [], block.caption ?? '');
      return node;
    }
    const node = obtain(block.id, block.kind === 'heading' ? `h${block.level}` : 'p', block.text);
    node.contentEditable = 'true'; node.setAttribute('role', 'textbox'); node.setAttribute('aria-label', block.kind === 'heading' ? '文档标题段落' : '文档正文');
    node.dataset.placeholder = '在这里输入，或让 Pi 帮你写作…';
    node.oninput = () => { try { doc.editBlock(block.id, node.innerText); } catch (error) { status(String(error)); node.textContent = doc.read().blocks.find(item => item.id === block.id)?.text ?? ''; } };
    return node;
  });
  if (preview && !preview.stale) {
    const streamed = preview.blocks.map((block, index) => {
      if (block.kind === 'table') {
        const node = obtain(`draft:${preview.callId}:${index}`, 'table', '');
        renderTestTable(node, block.columns ?? [], block.rows ?? [], block.caption ?? '');
        node.className = 'streamed'; node.dataset.streaming = 'true'; return node;
      }
      const node = obtain(`draft:${preview.callId}:${index}`, block.kind === 'heading' ? `h${block.level}` : 'p', block.text);
      node.className = 'streamed'; node.dataset.streaming = 'true';
      return node;
    });
    if (preview.replaceBlank && streamed.length) nodes.splice(0, nodes.length, ...streamed);
    else nodes.splice(preview.offset, 0, ...streamed);
  }
  const keep = new Set(nodes);
  for (const node of [...container.children]) if (!keep.has(node as HTMLElement)) node.remove();
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null); });
  container.scrollTop = preview && follow ? container.scrollHeight : previousScroll;
}
renderDocument();
async function disconnect() {
  articleStream.cancel();
  const active = connection; connection = undefined;
  const old = session; session = undefined; sequence++;
  const oldMicrophone = microphone; microphone = undefined;
  controls();
  await Promise.allSettled([old?.close(), oldMicrophone?.stop()]);
  if (active) await fetch(active.base + '/' + active.sessionId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + active.key } }).catch(() => undefined);
  status('已断开');
}
async function start(mic: boolean) {
  if (busy || session) return;
  busy = true; controls(); status('正在连接 Higgs + Pi…');
  const run = ++sequence;

  const key = el<HTMLInputElement>('clientKey').value.trim();
  const documentId = 'playground-' + crypto.randomUUID();
  const base = '/v1/documents/' + documentId + '/voice-sessions';
  executionStage = ''; taskError = '';
  const capture = mic ? createPausableMicrophone(controls, undefined, () => {
    if (!session || run !== sequence) return;
    session.setContext({ documentId, voiceControl: { type: 'finish-speech', id: crypto.randomUUID() } });
    if (!executionStage || executionStage.includes('语音') || executionStage.includes('委派')) {
      executionStage = '收音已暂停，正在结束当前语音并等待 Higgs 委派（最长 15 秒）';
      status(executionStage);
    }
    log('已请求服务端结束当前语音；不打断正在执行的任务');
  }) : undefined;
  microphone = capture;
  try {
    const response = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer ' + key } });
    if (!response.ok) { const body = await response.json(); throw new Error(body.detail ?? `HTTP ${response.status}`); }
    const grant = await response.json();
    connection = { base, key, sessionId: grant.sessionId };
    const client = await connect(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${grant.realtimePath}`, {
      auth: async () => {
        const response = await fetch(base + '/' + grant.sessionId + '/grants', { method: 'POST', headers: { Authorization: 'Bearer ' + key } });
        if (!response.ok) throw new Error('续签失败，请重新连接');
        return (await response.json()).token;
      },
      tools: doc.tools, context: { documentId, title: '本地测试文档', language: 'zh-CN' },
      audio: { input: capture?.input ?? false, output: false }, reconnect: false,
    });
    if (run !== sequence) { await client.close(); return; }
    session = client;
    client.on('text', event => {
      if (event.delta.startsWith('[执行阶段] ')) {
        executionStage = event.delta.slice('[执行阶段] '.length).trim(); status(executionStage); log(executionStage); return;
      }
      executionStage = 'Pi 正在输出任务进度'; status(executionStage);
      if (responseId !== event.responseId) { responseId = event.responseId; if (answer) answer += '\n\n'; }
      answer += event.delta; el('answer').textContent = answer;
    });
    client.on('transcript', event => {
      if (event.role === 'user' && event.final && !executionStage.startsWith('Pi') && !executionStage.includes('文章')) {
        taskError = ''; executionStage = '语音已识别，等待 Higgs 委派（最长 15 秒）'; status(executionStage);
      }
      if (event.role === 'user') el('heard').textContent = '你：' + event.text; });
    client.on('state', event => {
      if (event.state === 'idle') { executionStage = ''; status(taskError || '已连接 · 就绪'); }
      else if (event.state === 'listening') { taskError = ''; executionStage = ''; status('正在收音'); }
      else status(taskError || executionStage || (event.state === 'thinking' ? '等待语音结束或 Higgs 委派' : '已连接 · ' + event.state));
    });
    client.on('tool.call', event => { executionStage = ['insert_structured_article', 'insert_test_table'].includes(event.name) ? '正在校验并写入内容' : 'Pi 正在执行工具：' + event.name; status(executionStage); log('执行 ' + event.name); });
    client.on('tool.result', event => { articleStream.finish(event.callId, event.result.ok); log(event.name + (event.result.ok ? ' 完成（请以文档结果为准）' : ' 失败')); el('preview').textContent = ''; });
    client.on('tool.stream', event => {
      articleStream.receive(event);
      if (event.phase === 'arguments-delta') {
        executionStage = event.name === 'insert_test_table' ? 'Pi 正在生成表格，行数据实时显示中' : event.name === 'insert_structured_article' ? 'Pi 正在生成文章，正文实时显示中' : 'Pi 正在准备工具：' + event.name;
        status(executionStage);
      }
      if (event.phase === 'arguments-delta') el('preview').textContent = ((el('preview').textContent ?? '') + event.delta).slice(-12000);
    });
    client.on('error', event => { taskError = generationError(taskError, event.message); articleStream.cancel(); status(taskError); log(event.code + ': ' + event.message); });
    client.on('closed', () => { if (session === client) { articleStream.cancel(); session = undefined; microphone = undefined; void capture?.stop(); controls(); status('连接已关闭，请重新连接'); } });
    client.on('interrupted', () => { articleStream.cancel(); log('已打断；旧任务结果已关闭'); el('preview').textContent = ''; });
    status(mic ? '已连接 · 可以说话' : '已连接 · 可输入文字，Pi 实时返回结果'); log('实时会话已连接');
  } catch (error) { await disconnect(); status('连接失败：' + (error instanceof Error ? error.message : String(error))); }
  finally { busy = false; controls(); }
}
button('microphone').onclick = () => { void start(true); };
button('connect').onclick = () => { void start(false); };
button('disconnect').onclick = () => { void disconnect(); };
button('send').onclick = () => {
  const prompt = el<HTMLTextAreaElement>('prompt').value.trim(); if (!prompt || !session) return;
  articleStream.clear();
  taskError = ''; executionStage = '文字请求已发送，等待 Higgs 委派（最长 15 秒）'; status(executionStage);
  answer = ''; responseId = ''; el('answer').textContent = ''; el('preview').textContent = '';
  el('heard').textContent = '你：' + prompt; session.sendText(prompt);
};
button('interrupt').onclick = () => session?.interrupt('keyboard');
button('mute').onclick = async () => {
  const mic = microphone; if (!session || !mic?.attached || microphoneBusy) return;
  microphoneBusy = true; controls();
  try {
    if (mic.state === 'paused') { await mic.resume(); log('已恢复麦克风收音'); }
    else { await mic.pause(); log('已暂停收音；当前 AI 任务继续执行'); }
  } catch (error) { log('麦克风操作失败：' + (error instanceof Error ? error.message : String(error))); }
  finally { microphoneBusy = false; controls(); }
};
button('discardDraft').onclick = () => { session?.interrupt('keyboard'); articleStream.clear(); };
button('reset').onclick = () => {
  session?.interrupt('keyboard');
  articleStream.clear();
  try { doc.create(); status(`已新建「${doc.read().title}」，可以在右侧输入正文`); log('已新建 ' + doc.read().title); el('document').querySelector<HTMLElement>('[contenteditable]')?.focus(); }
  catch (error) { status(String(error)); }
};
el<HTMLSelectElement>('documents').onchange = event => { session?.interrupt('keyboard'); articleStream.clear(); doc.switchDocument((event.target as HTMLSelectElement).value); log('已切换到 ' + doc.read().title); };
el<HTMLInputElement>('documentName').onchange = event => { try { doc.rename((event.target as HTMLInputElement).value); } catch (error) { status(String(error)); } };
button('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([doc.read().blocks.map(block => block.text).join('\n\n')], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'pi-test-document.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
controls();
