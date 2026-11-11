'use strict';

/* 快速复制助手 —— 后台服务
 * 负责调用腾讯云「录音文件识别极速版」接口：
 * POST https://asr.cloud.tencent.com/asr/flash/v1/<appid>?...
 * 由后台发起请求，避免网页 CORS 限制，也避免把密钥暴露给页面脚本。
 */

const CONFIG_KEY = 'qc_asr_config';
const API_HOST = 'asr.cloud.tencent.com';
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set([
  'wav', 'pcm', 'ogg-opus', 'speex', 'silk', 'mp3', 'm4a', 'aac', 'amr'
]);

const FORMAT_BY_MIME = {
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
  'audio/ogg': 'ogg-opus',
  'audio/opus': 'ogg-opus',
  'audio/pcm': 'pcm',
  'audio/silk': 'silk',
  'audio/speex': 'speex'
};

const FORMAT_BY_EXT = {
  mp3: 'mp3',
  wav: 'wav',
  wave: 'wav',
  m4a: 'm4a',
  mp4: 'm4a',
  aac: 'aac',
  amr: 'amr',
  ogg: 'ogg-opus',
  opus: 'ogg-opus',
  pcm: 'pcm',
  silk: 'silk',
  speex: 'speex'
};

const API_HINTS = {
  4001: '请检查请求参数',
  4002: '请检查 AppID / SecretID / SecretKey 是否正确',
  4003: '请先在腾讯云控制台开通语音识别服务',
  4004: '资源包已耗尽，请购买资源包或开通后付费',
  4005: '账户欠费，请充值后重试',
  4006: '并发超限，请稍后重试',
  4007: '音频解码失败，请确认音频格式与参数一致',
  4008: '音频上传超时，请检查网络后重试',
  4009: '连接已断开，请重新识别',
  4010: '请求内容无法识别，请重试',
  4011: '音频数据太大',
  4012: '音频数据为空',
  5001: '服务繁忙，请重试',
  5002: '识别失败，请重试',
  5003: '识别超时，请重试'
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.type !== 'QC_ASR_RECOGNIZE') return;

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
  const config = await getConfig();
  const missing = [];
  if (!config.appId) missing.push('AppID');
  if (!config.secretId) missing.push('SecretID');
  if (!config.secretKey) missing.push('SecretKey');
  if (missing.length) {
    return {
      ok: false,
      stage: 'config',
      error: '请先在插件中填写腾讯云语音识别的 ' + missing.join(' / ')
    };
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
    mime = msg.mime || '';
  } else {
    url = String(msg.url || '').trim();
    if (!url) return { ok: false, stage: 'audio', error: '未找到音频地址' };
    if (!/^https?:|^file:|^blob:|^data:/i.test(url)) {
      return { ok: false, stage: 'audio', error: '音频地址不受支持' };
    }
    if (/^blob:|^data:/i.test(url)) {
      return { ok: false, stage: 'audio', error: '该音频只能在页面内读取，请重试' };
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
    return { ok: false, stage: 'audio', error: '音频超过 100MB 限制' };
  }

  let format = String(msg.format || '').toLowerCase();
  if (format === 'ogg') format = 'ogg-opus';
  if (!SUPPORTED_FORMATS.has(format)) format = detectFormat(url, mime);
  if (!format) {
    return {
      ok: false,
      stage: 'format',
      error: '无法判断音频格式，请使用 wav / mp3 / m4a / aac / amr / ogg-opus 等格式'
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    appid: config.appId,
    secretid: config.secretId,
    engine_type: config.engineType || '16k_zh',
    voice_format: format,
    timestamp,
    convert_num_mode: 1,
    first_channel_only: 1,
    filter_dirty: 0,
    filter_modal: 0,
    filter_punc: 0,
    speaker_diarization: 0,
    word_info: 0
  };

  const path = '/asr/flash/v1/' + encodeURIComponent(config.appId);
  const query = Object.keys(params)
    .sort()
    .map((key) => key + '=' + encodeURIComponent(params[key]))
    .join('&');

  let signature;
  try {
    signature = await signRequest('POST' + API_HOST + path + '?' + query, config.secretKey);
  } catch (e) {
    return { ok: false, stage: 'sign', error: '生成签名失败：' + (e && e.message ? e.message : e) };
  }

  let response;
  try {
    response = await fetchWithTimeout(
      'https://' + API_HOST + path + '?' + query,
      {
        method: 'POST',
        headers: {
          Authorization: signature,
          'Content-Type': 'application/octet-stream'
        },
        body: bytes
      },
      120000
    );
  } catch (e) {
    return {
      ok: false,
      stage: 'request',
      error: '请求腾讯云失败：' + (e && e.message ? e.message : e)
    };
  }

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }

  if (!data) {
    return {
      ok: false,
      stage: 'request',
      error: '腾讯云返回内容无法解析（HTTP ' + response.status + '）'
    };
  }

  if (Number(data.code) !== 0) {
    const code = data.code;
    const hint = API_HINTS[Number(code)] || '';
    return {
      ok: false,
      stage: 'api',
      code,
      requestId: data.request_id || '',
      error:
        '识别失败（' + code + '）' +
        (data.message ? '：' + data.message : '') +
        (hint ? '。' + hint : '')
    };
  }

  const results = Array.isArray(data.flash_result) ? data.flash_result : [];
  const text = results
    .map((item) => (item && item.text ? String(item.text).trim() : ''))
    .filter(Boolean)
    .join('\n');

  if (!text) {
    return { ok: false, stage: 'api', error: '识别完成，但没有返回文字内容' };
  }

  return {
    ok: true,
    text,
    duration: data.audio_duration || 0,
    requestId: data.request_id || ''
  };
}

/* ---------- 网络与签名 ---------- */

async function fetchAudio(url) {
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      { credentials: 'include', cache: 'default' },
      60000
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

async function signRequest(payload, secretKey) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToBase64(new Uint8Array(signature));
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

function detectFormat(url, mime) {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();
  if (FORMAT_BY_MIME[clean]) return FORMAT_BY_MIME[clean];

  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch (e) {
    pathname = '';
  }

  const match = pathname.match(/\.([a-z0-9]+)$/i);
  if (match && FORMAT_BY_EXT[match[1].toLowerCase()]) {
    return FORMAT_BY_EXT[match[1].toLowerCase()];
  }

  return '';
}

/* ---------- 存储与编码 ---------- */

function getConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CONFIG_KEY, (data) => {
        if (chrome.runtime.lastError || !data) {
          resolve({});
          return;
        }
        resolve(data[CONFIG_KEY] || {});
      });
    } catch (e) {
      resolve({});
    }
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
