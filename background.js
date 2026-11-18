'use strict';

/* 语音识别助手 —— 后台服务
 * 1. 下载页面音频（http/https 由后台直接下载，可携带页面 Cookie；blob:/data: 由内容脚本读取后转交）
 * 2. 以 multipart/form-data 的 file 字段 POST 到用户配置的接口
 * 3. 从响应里取出可读文本和逐词时间戳（timestamps）返回给内容脚本
 *
 * 由后台发起请求，避免页面 CORS 限制，也让接口地址 / 密钥只留在插件里。
 */

const SETTINGS_KEY = 'asr_settings';
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_TEXT = 1024 * 1024;
const MAX_TIMESTAMP_ROWS = 2000;
const FETCH_TIMEOUT = 60000;
const REQUEST_TIMEOUT = 180000;

/* 时间戳数组常见的字段名，按顺序尝试 */
const TIMESTAMP_KEYS = ['timestamps', 'timestamp', 'words', 'tokens', 'segments', 'items'];

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  webm: 'audio/webm',
  pcm: 'audio/pcm',
  silk: 'audio/silk',
  speex: 'audio/speex'
};

const EXT_BY_MIME = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/aacp': 'aac',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'audio/pcm': 'pcm',
  'audio/silk': 'silk',
  'audio/speex': 'speex'
};

/* 常见的「文本字段」命名，按顺序尝试 */
const TEXT_KEYS = [
  'text',
  'transcript',
  'transcription',
  'asr_text',
  'asrText',
  'sentence',
  'result',
  'content',
  'data',
  'message',
  'msg'
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.type !== 'ASR_RECOGNIZE') return;

  recognize(msg)
    .then((result) => sendResponse(result))
    .catch((err) => {
      sendResponse({
        ok: false,
        stage: 'unknown',
        error: '语音识别失败：' + (err && err.message ? err.message : String(err))
      });
    });

  return true; // 异步响应
});

async function recognize(msg) {
  const settings = await getSettings();
  const endpoint = String(settings.endpoint || '').trim();

  if (!endpoint) {
    return { ok: false, stage: 'config', error: '请先点击插件图标填写接口地址' };
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    return { ok: false, stage: 'config', error: '接口地址格式不正确：' + endpoint };
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return { ok: false, stage: 'config', error: '接口地址需要以 http:// 或 https:// 开头' };
  }

  let bytes = null;
  let mime = '';
  let url = '';

  if (msg.base64) {
    try {
      bytes = base64ToBytes(msg.base64);
    } catch (e) {
      return { ok: false, stage: 'audio', error: '音频数据解析失败' };
    }
    mime = String(msg.mime || '');
  } else {
    url = String(msg.url || '').trim();
    if (!url) return { ok: false, stage: 'audio', error: '未找到音频地址' };

    if (/^blob:|^data:/i.test(url)) {
      return { ok: false, stage: 'inline', error: '该音频需要在页面内读取' };
    }
    if (!/^https?:/i.test(url)) {
      return { ok: false, stage: 'audio', error: '音频地址不受支持：' + url };
    }

    const fetched = await fetchAudio(url);
    if (!fetched.ok) return { ok: false, stage: 'fetch', error: fetched.error };
    bytes = fetched.bytes;
    mime = fetched.mime;
  }

  if (!bytes || !bytes.length) {
    return { ok: false, stage: 'audio', error: '音频内容为空' };
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    return { ok: false, stage: 'audio', error: '音频超过 100MB，无法上传' };
  }

  const meta = resolveFileMeta(url, mime, msg.filename);
  const fieldName = String(settings.fieldName || 'file').trim() || 'file';

  let body;
  try {
    const form = new FormData();
    form.append(fieldName, new Blob([bytes], { type: meta.mime }), meta.filename);
    body = form;
  } catch (e) {
    return { ok: false, stage: 'request', error: '构造上传数据失败：' + (e && e.message ? e.message : e) };
  }

  let response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        body,
        credentials: 'include'
      },
      REQUEST_TIMEOUT
    );
  } catch (e) {
    return {
      ok: false,
      stage: 'request',
      error: '请求识别接口失败：' + (e && e.message ? e.message : e)
    };
  }

  let raw = '';
  try {
    raw = await response.text();
  } catch (e) {
    return {
      ok: false,
      stage: 'request',
      status: response.status,
      error: '读取接口返回内容失败（HTTP ' + response.status + '）'
    };
  }

  if (raw.length > MAX_RESPONSE_TEXT) {
    raw = raw.slice(0, MAX_RESPONSE_TEXT) + '\n…（返回内容过长，已截断）';
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }

  const text = data === null ? raw.trim() : extractText(data);

  if (!response.ok) {
    const detail = text || raw.trim().slice(0, 300);
    return {
      ok: false,
      stage: 'api',
      status: response.status,
      error: '接口返回 HTTP ' + response.status + (detail ? '：' + detail : ''),
      raw
    };
  }

  return {
    ok: true,
    status: response.status,
    text,
    timestamps: normalizeTimestamps(findTimestampList(data)),
    filename: pickField(data, ['filename', 'file_name', 'file']) || '',
    apiElapsed: toSeconds(pickField(data, ['elapsed', 'cost', 'duration'])),
    raw,
    json: data !== null
  };
}

/* ---------- 网络 ---------- */

async function fetchAudio(url) {
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      { credentials: 'include', cache: 'default' },
      FETCH_TIMEOUT
    );
  } catch (e) {
    return { ok: false, error: '下载音频失败：' + (e && e.message ? e.message : e) };
  }

  if (!response.ok) {
    return { ok: false, error: '下载音频失败（HTTP ' + response.status + '）' };
  }

  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (e) {
    return { ok: false, error: '读取音频失败：' + (e && e.message ? e.message : e) };
  }

  if (!buffer.byteLength) {
    return { ok: false, error: '音频内容为空' };
  }

  const mime = response.headers.get('content-type') || '';
  if (/^text\/html/i.test(mime)) {
    return { ok: false, error: '下载到的不是音频文件（可能需要登录或链接已失效）' };
  }

  return {
    ok: true,
    bytes: new Uint8Array(buffer),
    mime
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function resolveFileMeta(url, mime, filename) {
  let name = String(filename || '').trim();

  if (!name && url) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    } catch (e) {
      name = '';
    }
  }

  const cleanMime = String(mime || '').split(';')[0].trim().toLowerCase();

  let ext = (name.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  if (!ext) ext = EXT_BY_MIME[cleanMime] || '';
  if (!ext) ext = 'bin';

  if (!name) name = 'audio.' + ext;
  else if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.' + ext;

  name = name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'audio.' + ext;

  const finalMime = cleanMime || MIME_BY_EXT[ext] || 'application/octet-stream';

  return { filename: name, mime: finalMime };
}

/* ---------- 响应解析 ---------- */

function extractText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.trim();
  if (typeof data !== 'object') return '';

  const seen = new Set();

  function walk(value, depth) {
    if (value == null || depth > 6) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    if (Array.isArray(value)) {
      const parts = value.map((item) => walk(item, depth + 1)).filter(Boolean);
      return parts.join('\n').trim();
    }

    for (const key of TEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const found = walk(value[key], depth + 1);
      if (found) return found;
    }

    return '';
  }

  return walk(data, 0);
}

/* ---------- 时间戳（逐词时间轴） ---------- */

function findTimestampList(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return null;

  if (Array.isArray(value)) {
    return looksLikeTimestampList(value) ? value : null;
  }

  for (const key of TIMESTAMP_KEYS) {
    if (Array.isArray(value[key]) && looksLikeTimestampList(value[key])) return value[key];
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (!child || typeof child !== 'object') continue;
    const found = findTimestampList(child, depth + 1);
    if (found) return found;
  }

  return null;
}

function looksLikeTimestampList(list) {
  let hits = 0;
  for (const item of list.slice(0, 5)) {
    if (!item || typeof item !== 'object') continue;
    if (
      'start' in item || 'begin' in item || 'start_time' in item || 'from' in item ||
      'end' in item || 'stop' in item || 'end_time' in item || 'to' in item ||
      'token' in item || 'word' in item
    ) {
      hits += 1;
    }
  }
  return hits > 0;
}

function normalizeTimestamps(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const rawToken = item.token ?? item.text ?? item.word ?? item.value ?? '';
    const token = String(rawToken);
    const start = toSeconds(item.start ?? item.begin ?? item.start_time ?? item.startTime ?? item.from);
    const end = toSeconds(item.end ?? item.stop ?? item.end_time ?? item.endTime ?? item.to);

    if (!token.trim() && start === null && end === null) continue;

    out.push({ token, start, end });
    if (out.length >= MAX_TIMESTAMP_ROWS) break;
  }

  return out;
}

/* 秒数，支持 0.84 / "0.84" / "00:00:01.234"；无法解析时返回 null */
function toSeconds(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'string' && value.includes(':')) {
    const parts = value.split(':').map((part) => Number(part));
    if (parts.length && parts.every((part) => Number.isFinite(part))) {
      return parts.reduce((acc, part) => acc * 60 + part, 0);
    }
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pickField(data, keys) {
  if (!data || typeof data !== 'object') return null;

  for (const key of keys) {
    if (data[key] != null && data[key] !== '') return data[key];
  }

  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    return pickField(data.data, keys);
  }

  return null;
}

/* ---------- 存储与编码 ---------- */

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [SETTINGS_KEY]: {} }, (data) => {
        if (chrome.runtime.lastError || !data) {
          resolve({});
          return;
        }
        resolve(data[SETTINGS_KEY] || {});
      });
    } catch (e) {
      resolve({});
    }
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
