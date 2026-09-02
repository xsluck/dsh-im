import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { fetchImageBuffer } from '../shared/image-prompt.mjs';

export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';
export const WEIXIN_PROTOCOL_VERSION = '2.4.6';
export const DEFAULT_BOT_TYPE = '3';
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const WEIXIN_CDN_HOST = 'novac2c.cdn.weixin.qq.com';

const ILINK_APP_ID = 'bot';
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_STATUSES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect',
]);

export class WeixinApiError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WeixinApiError';
    this.code = code;
    this.status = options.status;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strictBase64(value) {
  const text = nonEmptyString(value);
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  return Buffer.from(text, 'base64');
}

/** Parse the two AES key encodings used by Weixin iLink image messages. */
export function parseWeixinImageAesKey(imageItem) {
  const directHex = nonEmptyString(imageItem?.aeskey);
  if (directHex) {
    if (!/^[0-9a-fA-F]{32}$/.test(directHex)) {
      throw new WeixinApiError('invalid-image-key', '微信图片的加密密钥无效。');
    }
    return Buffer.from(directHex, 'hex');
  }

  const encoded = strictBase64(imageItem?.media?.aes_key);
  if (encoded?.length === 16) return encoded;
  if (encoded?.length === 32 && /^[0-9a-fA-F]{32}$/.test(encoded.toString('ascii'))) {
    return Buffer.from(encoded.toString('ascii'), 'hex');
  }
  throw new WeixinApiError('invalid-image-key', '微信图片的加密密钥无效。');
}

export function decryptWeixinImage(ciphertext, key) {
  const encrypted = Buffer.from(ciphertext);
  const aesKey = Buffer.from(key);
  if (aesKey.length !== 16 || encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new WeixinApiError('invalid-image-ciphertext', '微信图片的加密数据无效。');
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (error) {
    throw new WeixinApiError('image-decryption-failed', '微信图片解密失败。', { cause: error });
  }
}

export function weixinImageDownloadUrl(media) {
  const query = nonEmptyString(media?.encrypt_query_param);
  if (query) {
    return `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(query)}`;
  }

  const fullUrl = nonEmptyString(media?.full_url);
  if (!fullUrl) throw new WeixinApiError('missing-image-url', '微信图片没有可用的下载地址。');
  let url;
  try {
    url = new URL(fullUrl);
  } catch {
    throw new WeixinApiError('invalid-image-url', '微信图片的下载地址无效。');
  }
  if (url.protocol !== 'https:' || url.hostname !== WEIXIN_CDN_HOST
    || (url.port && url.port !== '443') || !url.pathname.startsWith('/c2c/')) {
    throw new WeixinApiError('untrusted-image-url', '微信图片的下载地址不受信任。');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

/** Convert iLink image items into lazily downloaded, decrypted image references. */
export function extractWeixinImages(message, { fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const images = [];
  for (const item of message?.item_list ?? []) {
    const imageItem = item?.image_item;
    if (!imageItem || typeof imageItem !== 'object') continue;
    images.push({
      name: images.length === 0 ? 'image' : `image-${images.length + 1}`,
      load: async ({ signal, maxBytes }) => {
        const key = parseWeixinImageAesKey(imageItem);
        const url = weixinImageDownloadUrl(imageItem.media);
        const ciphertext = await fetchImageBuffer(url, {
          fetchImpl,
          signal,
          maxBytes: maxBytes + 16,
          allowedHosts: [WEIXIN_CDN_HOST],
        });
        return decryptWeixinImage(ciphertext, key);
      },
    });
  }
  return images;
}

// --- CDN upload helpers for sending images ---

/** AES-128-ECB encrypt with PKCS7 padding (Node.js default). */
function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Build CDN upload URL from upload_param and filekey. */
function buildCdnUploadUrl(uploadParam, filekey) {
  return `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/** Get upload URL from Weixin iLink API. */
async function getUploadUrl(fetchImpl, { baseUrl, token, filekey, mediaType, toUserId, plaintext, aeskey, signal }) {
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);

  const response = await requestJson(fetchImpl, {
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token,
    signal,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
      base_info: baseInfo(),
    },
  });

  if (response?.ret !== undefined && response.ret !== 0) {
    throw new WeixinApiError('upload-url-failed', `微信服务返回了错误码 ${response.ret}`);
  }

  return {
    uploadFullUrl: response?.upload_full_url,
    uploadParam: response?.upload_param,
    rawsize,
    rawfilemd5,
    filesize,
  };
}

/** Upload buffer to Weixin CDN. */
async function uploadToCdn(fetchImpl, { plaintext, aeskey, uploadFullUrl, uploadParam, filekey, signal }) {
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnUrl = uploadFullUrl || buildCdnUploadUrl(uploadParam, filekey);

  const response = await fetchImpl(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext,
    signal,
  });

  if (!response.ok) {
    const errMsg = response.headers.get('x-error-message') ?? await response.text();
    throw new WeixinApiError('cdn-upload-failed', `CDN上传失败 (HTTP ${response.status}): ${errMsg}`);
  }

  const downloadParam = response.headers.get('x-encrypted-param');
  if (!downloadParam) {
    throw new WeixinApiError('cdn-upload-missing-param', 'CDN响应缺少下载参数');
  }

  return { downloadParam };
}

function isWeixinHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'weixin.qq.com' || normalized.endsWith('.weixin.qq.com');
}

export function normalizeWeixinApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinApiError('invalid-base-url', '微信服务返回了无效的连接地址。');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)
    || (url.port !== '' && url.port !== '443')) {
    throw new WeixinApiError('untrusted-base-url', '微信服务返回了不受信任的连接地址。');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

export function normalizeWeixinQrUrl(value) {
  const text = nonEmptyString(value);
  if (!text) throw new WeixinApiError('invalid-qr', '微信服务没有返回扫码地址。');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WeixinApiError('invalid-qr', '微信服务返回了无效的扫码地址。');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new WeixinApiError('untrusted-qr', '微信服务返回了不受信任的扫码地址。');
  }
  return url.toString();
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
  };
}

function authenticatedHeaders(token) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  };
  if (nonEmptyString(token)) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function baseInfo() {
  return {
    channel_version: WEIXIN_PROTOCOL_VERSION,
    bot_agent: 'DeepSeekHarness/0.14.0',
  };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

async function requestJson(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  authenticated = true,
}) {
  const trustedBase = normalizeWeixinApiBaseUrl(baseUrl);
  const url = new URL(endpoint, trustedBase);
  if (!isWeixinHost(url.hostname)) {
    throw new WeixinApiError('untrusted-endpoint', '拒绝访问不受信任的微信服务地址。');
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      method,
      headers: authenticated ? authenticatedHeaders(token) : commonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WeixinApiError(
        'http-error',
        `微信服务请求失败（HTTP ${response.status}）。`,
        { status: response.status },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinApiError('invalid-response', '微信服务返回了无法解析的响应。', { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (timedOut) {
      throw new WeixinApiError('timeout', '微信服务请求超时。', { cause: error });
    }
    if (error instanceof WeixinApiError) throw error;
    throw new WeixinApiError('network-error', '暂时无法访问微信服务。', { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function validateLoginResponse(value) {
  if (!value || typeof value !== 'object' || !LOGIN_STATUSES.has(value.status)) {
    throw new WeixinApiError('invalid-login-status', '微信服务返回了无法识别的扫码状态。');
  }
  return value;
}

export function createWeixinApi({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  return Object.freeze({
    inboundImages(message) {
      return extractWeixinImages(message, { fetchImpl });
    },

    async beginLogin({ localTokens = [], botType = DEFAULT_BOT_TYPE, signal } = {}) {
      const tokens = [...new Set(localTokens.map(nonEmptyString).filter(Boolean))].slice(-10);
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl: WEIXIN_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: tokens },
        timeoutMs: 10_000,
        signal,
      });
      const qrcode = nonEmptyString(response?.qrcode);
      if (!qrcode) throw new WeixinApiError('invalid-qr', '微信服务没有返回二维码令牌。');
      return {
        qrcode,
        qrcodeUrl: normalizeWeixinQrUrl(response.qrcode_img_content),
      };
    },

    async pollLogin({ qrcode, baseUrl = WEIXIN_QR_BASE_URL, verifyCode, signal }) {
      const qr = nonEmptyString(qrcode);
      if (!qr) throw new TypeError('qrcode is required');
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
      if (nonEmptyString(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
      const response = await requestJson(fetchImpl, {
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal,
        authenticated: false,
      });
      return validateLoginResponse(response);
    },

    async getUpdates({ baseUrl, token, getUpdatesBuf = '', timeoutMs, signal }) {
      try {
        return await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
          token,
          timeoutMs: timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
          signal,
        });
      } catch (error) {
        if (error instanceof WeixinApiError && error.code === 'timeout') {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        }
        throw error;
      }
    },

    async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString(toUserId);
      const content = nonEmptyString(text);
      if (!recipient || !content) throw new TypeError('toUserId and text are required');
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: `dsh-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: content } }],
            ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
            ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      });
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new WeixinApiError('send-rejected', '微信服务拒绝了回复消息。');
      }
      return true;
    },

    async sendImage({ baseUrl, token, toUserId, imageData, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString(toUserId);
      if (!recipient) throw new TypeError('toUserId is required');

      // imageData can be Buffer, Uint8Array, or base64 string
      let plaintext;
      if (typeof imageData === 'string') {
        // base64 string
        plaintext = Buffer.from(imageData, 'base64');
      } else if (imageData instanceof Uint8Array) {
        plaintext = Buffer.from(imageData);
      } else if (Buffer.isBuffer(imageData)) {
        plaintext = imageData;
      } else {
        throw new TypeError('imageData must be a Buffer, Uint8Array, or base64 string');
      }

      if (plaintext.length === 0) throw new TypeError('imageData cannot be empty');
      if (plaintext.length > 5 * 1024 * 1024) {
        throw new WeixinApiError('image-too-large', '图片大小超过 5 MB 限制');
      }

      const filekey = randomBytes(16).toString('hex');
      const aeskey = randomBytes(16);

      // Step 1: Get upload URL
      const uploadInfo = await getUploadUrl(fetchImpl, {
        baseUrl,
        token,
        filekey,
        mediaType: 1, // IMAGE
        toUserId: recipient,
        plaintext,
        aeskey,
        signal,
      });

      // Step 2: Upload to CDN
      const { downloadParam } = await uploadToCdn(fetchImpl, {
        plaintext,
        aeskey,
        uploadFullUrl: uploadInfo.uploadFullUrl,
        uploadParam: uploadInfo.uploadParam,
        filekey,
        signal,
      });

      // Step 3: Send text message first (if provided)
      if (text) {
        await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/sendmessage',
          token,
          signal,
          body: {
            msg: {
              from_user_id: '',
              to_user_id: recipient,
              client_id: `dsh-weixin-${randomUUID()}`,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text } }],
              ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
              ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
            },
            base_info: baseInfo(),
          },
        });
      }

      // Step 4: Send image message
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: `dsh-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [
              {
                type: 2, // IMAGE
                image_item: {
                  media: {
                    encrypt_query_param: downloadParam,
                    aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
                    encrypt_type: 1,
                  },
                  mid_size: uploadInfo.filesize,
                },
              },
            ],
            ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
            ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      });

      if (response?.ret !== undefined && response.ret !== 0) {
        throw new WeixinApiError('send-rejected', '微信服务拒绝了回复消息。');
      }
      return true;
    },

    async sendVideo({ baseUrl, token, toUserId, videoData, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString(toUserId);
      if (!recipient) throw new TypeError('toUserId is required');

      let plaintext;
      if (typeof videoData === 'string') {
        plaintext = Buffer.from(videoData, 'base64');
      } else if (videoData instanceof Uint8Array) {
        plaintext = Buffer.from(videoData);
      } else if (Buffer.isBuffer(videoData)) {
        plaintext = videoData;
      } else {
        throw new TypeError('videoData must be a Buffer, Uint8Array, or base64 string');
      }

      if (plaintext.length === 0) throw new TypeError('videoData cannot be empty');
      if (plaintext.length > 100 * 1024 * 1024) {
        throw new WeixinApiError('video-too-large', '视频大小超过 100 MB 限制');
      }

      const filekey = randomBytes(16).toString('hex');
      const aeskey = randomBytes(16);

      const uploadInfo = await getUploadUrl(fetchImpl, {
        baseUrl, token, filekey,
        mediaType: 2, // VIDEO
        toUserId: recipient,
        plaintext, aeskey, signal,
      });

      const { downloadParam } = await uploadToCdn(fetchImpl, {
        plaintext, aeskey,
        uploadFullUrl: uploadInfo.uploadFullUrl,
        uploadParam: uploadInfo.uploadParam,
        filekey, signal,
      });

      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl, endpoint: 'ilink/bot/sendmessage',
        token, signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: `dsh-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [
              ...(text ? [{ type: 1, text_item: { text } }] : []),
              {
                type: 5, // VIDEO
                video_item: {
                  media: {
                    encrypt_query_param: downloadParam,
                    aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
                    encrypt_type: 1,
                  },
                  video_size: uploadInfo.filesize,
                },
              },
            ],
            ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
            ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      });

      if (response?.ret !== undefined && response.ret !== 0) {
        throw new WeixinApiError('send-rejected', '微信服务拒绝了回复消息。');
      }
      return true;
    },

    async sendFile({ baseUrl, token, toUserId, fileData, fileName, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString(toUserId);
      if (!recipient) throw new TypeError('toUserId is required');
      if (!fileName) throw new TypeError('fileName is required');

      let plaintext;
      if (typeof fileData === 'string') {
        plaintext = Buffer.from(fileData, 'base64');
      } else if (fileData instanceof Uint8Array) {
        plaintext = Buffer.from(fileData);
      } else if (Buffer.isBuffer(fileData)) {
        plaintext = fileData;
      } else {
        throw new TypeError('fileData must be a Buffer, Uint8Array, or base64 string');
      }

      if (plaintext.length === 0) throw new TypeError('fileData cannot be empty');
      if (plaintext.length > 200 * 1024 * 1024) {
        throw new WeixinApiError('file-too-large', '文件大小超过 200 MB 限制');
      }

      const filekey = randomBytes(16).toString('hex');
      const aeskey = randomBytes(16);

      const uploadInfo = await getUploadUrl(fetchImpl, {
        baseUrl, token, filekey,
        mediaType: 3, // FILE
        toUserId: recipient,
        plaintext, aeskey, signal,
      });

      const { downloadParam } = await uploadToCdn(fetchImpl, {
        plaintext, aeskey,
        uploadFullUrl: uploadInfo.uploadFullUrl,
        uploadParam: uploadInfo.uploadParam,
        filekey, signal,
      });

      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl, endpoint: 'ilink/bot/sendmessage',
        token, signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: recipient,
            client_id: `dsh-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [
              ...(text ? [{ type: 1, text_item: { text } }] : []),
              {
                type: 4, // FILE
                file_item: {
                  media: {
                    encrypt_query_param: downloadParam,
                    aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
                    encrypt_type: 1,
                  },
                  file_name: fileName,
                  len: String(uploadInfo.rawsize),
                },
              },
            ],
            ...(nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {}),
            ...(nonEmptyString(runId) ? { run_id: runId.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      });

      if (response?.ret !== undefined && response.ret !== 0) {
        throw new WeixinApiError('send-rejected', '微信服务拒绝了回复消息。');
      }
      return true;
    },

    async notifyStart({ baseUrl, token, signal }) {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        token,
        signal,
        timeoutMs: 10_000,
        body: { base_info: baseInfo() },
      });
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new WeixinApiError('start-rejected', '微信账号连接启动失败。');
      }
      return response;
    },

    async notifyStop({ baseUrl, token, signal }) {
      return requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        token,
        signal,
        timeoutMs: 10_000,
        body: { base_info: baseInfo() },
      });
    },
  });
}

export function extractWeixinText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim();
      if (text) return text;
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim();
      if (text) return text;
    }
  }
  return null;
}

export function weixinMessageId(message) {
  if (message?.message_id !== undefined && message.message_id !== null) {
    return String(message.message_id);
  }
  return nonEmptyString(message?.client_id);
}

export function splitWeixinText(text, maxChars = 4_000) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
