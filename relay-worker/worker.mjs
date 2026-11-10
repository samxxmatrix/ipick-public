/**
 * 中转 Worker：读 KV 里的 IP 列表公开出来，同时接住容器的推送。
 *
 *   GET    /ips/{slug}          → 公开读，纯文本（每行 IP:端口）
 *   PUT    /_push/ips/{slug}    → 容器推送（需 Bearer RELAY_TOKEN）
 *   DELETE /_push/ips/{slug}    → 容器删集（需 Bearer RELAY_TOKEN）
 *   POST   /_push/probe         → 测试连接：写→读回→删探针 key（需 Bearer RELAY_TOKEN）
 *   GET    /                    → 403（刻意不提供探测页，不向外确认这里跑的是什么服务）
 *
 * 为什么写入也走 Worker，而不是让容器直连 Cloudflare API：容器只需要「一个域名 + 一个
 * token」，不必再配 account id 与 namespace id；更要紧的是这个 token 的权限被限制在
 * 「这一个 Worker 的写端点」上，不再是可枚举全账号 KV 的 API 令牌。
 *
 * 写入必须逐行校验格式：Worker 是唯一写入口，放进去一行坏数据，代理侧只会表现成
 * 「订阅能拉到、节点全连不上」，比在写入时直接拒绝难查一个数量级。
 *
 * 为什么公开读带 5 分钟缓存：一轮最短间隔按小时计，5 分钟内复用同一份足够新鲜；
 * 而 KV 免费额度只有 10 万读/天，代理 Worker 高频拉取时这层缓存是必需的。
 */

const CACHE_SECONDS = 300;

// 与 server/publisher.py 的 SLUG_RE 同一套字符集（Base64URL），
// 顺便防止有人拿 "../" 之类的路径去探 KV 里的别的 key
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 与 server/publisher.py 的 MAX_PUSH_BYTES 保持一致。正常一轮几百行不到 10KB，
// 256KB 足够宽松，又能挡住「把别的东西推上来」这种事故。
const MAX_PUSH_BYTES = 256 * 1024;

const PUSH_IPS_PREFIX = '/_push/ips/';
const PUSH_PROBE_PATH = '/_push/probe';

// 探针 key：测试连接时写一次、读回、删掉。用固定名而不是随机名，
// 万一删失败也不会在 namespace 里堆一串垃圾（下次探针会覆盖同名 key）。
const PROBE_KEY = '__ipick_probe__';

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
  // 允许任意代理 Worker（5 个账号上的 edgetunnel / CFNext / CFnew）跨域来取
  'access-control-allow-origin': '*',
};

/** 公开读的响应（带 CORS，允许浏览器侧代理直接取）。 */
function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...TEXT_HEADERS, ...extra } });
}

/** 写端点的响应：不带 CORS、一律不缓存 —— 写结果绝不能被任何中间层留下来。 */
function pushText(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

/** 204：写成功且没有响应体。 */
function noContent(extra = {}) {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', ...extra },
  });
}

const PUSH_OPTIONS = {
  'access-control-allow-methods': 'PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      // 兜底：把原因写进响应体，否则线上只能看到 Cloudflare 的 error 1101 页面
      const message = err && err.message ? err.message : String(err);
      return text('ipick-relay error: ' + message + '\n', 500, { 'cache-control': 'no-store' });
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...TEXT_HEADERS, ...PUSH_OPTIONS },
    });
  }

  if (url.pathname === PUSH_PROBE_PATH) {
    return probe(request, env);
  }
  if (url.pathname.startsWith(PUSH_IPS_PREFIX)) {
    return push(request, env, url.pathname.slice(PUSH_IPS_PREFIX.length));
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('method not allowed\n', 405, { allow: 'GET, HEAD' });
  }

  if (url.pathname === '/' || url.pathname === '') {
    // 根路径不暴露任何服务信息：只有知道 slug 的调用方才该拿到内容。
    // 要确认域名是否绑对，用一个不存在的 slug 看 404 即可。
    return text('forbidden\n', 403, { 'cache-control': 'no-store' });
  }

  const matched = url.pathname.match(/^\/ips\/([^/]+)$/);
  if (!matched || !SLUG_RE.test(matched[1])) {
    return text('not found\n', 404, { 'cache-control': 'no-store' });
  }

  const slug = matched[1];
  let body;
  try {
    // cacheTtl 最小 60 秒；边缘节点会在这段时间内直接返回缓存，不打 KV 读额度
    body = await env.IP_KV.get(slug, { cacheTtl: CACHE_SECONDS });
  } catch (err) {
    // KV 读失败（配额用尽 / binding 配错）：502 而不是 404，
    // 让调用方能区分「这个 slug 还没有内容」和「后端挂了」
    return text('kv error: ' + messageOf(err) + '\n', 502, { 'cache-control': 'no-store' });
  }

  if (body === null) {
    return text('not found\n', 404, { 'cache-control': 'no-store' });
  }

  return text(body, 200, {
    'cache-control': `public, max-age=${CACHE_SECONDS}`,
    // 空列表是合法结果（本轮一条都没过筛），这里只标注条数，便于人工核对
    'x-ipick-count': String(body ? body.split('\n').filter(Boolean).length : 0),
  });
}

// ======================================================================
// 写入：容器推上来的 IP 列表
// ======================================================================

async function push(request, env, slug) {
  const denied = requireToken(request, env);
  if (denied) return denied;

  if (!SLUG_RE.test(slug)) {
    return pushText('invalid slug\n', 400);
  }

  if (request.method === 'DELETE') {
    try {
      // KV 删除天然幂等：key 不存在也算成功，调用方要的是「确保没了」
      await env.IP_KV.delete(slug);
    } catch (err) {
      return pushText('kv delete failed: ' + messageOf(err) + '\n', 502);
    }
    return noContent();
  }

  if (request.method !== 'PUT') {
    return pushText('method not allowed\n', 405, { allow: 'PUT, DELETE' });
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_PUSH_BYTES) {
    return pushText(
      'body too large: ' + buffer.byteLength + ' > ' + MAX_PUSH_BYTES + '\n',
      413,
    );
  }

  const body = new TextDecoder().decode(buffer);
  const verdict = checkList(body);
  if (!verdict.ok) {
    // 响应体直接写清「第几行、哪里不对」，容器会把这句话原样显示在运行详情里
    return pushText(verdict.reason + '\n', 400);
  }

  try {
    await env.IP_KV.put(slug, body);
  } catch (err) {
    return pushText('kv write failed: ' + messageOf(err) + '\n', 502);
  }
  return noContent({ 'x-ipick-count': String(verdict.count) });
}

async function probe(request, env) {
  const denied = requireToken(request, env);
  if (denied) return denied;

  if (request.method !== 'POST') {
    return pushText('method not allowed\n', 405, { allow: 'POST' });
  }

  const stamp = 'probe ' + new Date().toISOString();
  try {
    await env.IP_KV.put(PROBE_KEY, stamp);
    const back = await env.IP_KV.get(PROBE_KEY);
    await env.IP_KV.delete(PROBE_KEY);
    if (back !== stamp) {
      // 只写不读的话，「binding 指到别的 namespace」这类错查不出来
      return pushText('kv readback mismatch\n', 502);
    }
  } catch (err) {
    return pushText('kv error: ' + messageOf(err) + '\n', 502);
  }
  return pushText('ok\n', 200);
}

/**
 * 校验整份列表。返回 ``{ok: true, count}`` 或 ``{ok: false, reason}``。
 *
 * 规则：空 body 合法（本轮一条都没过筛）；只容忍结尾一个换行；中间空行一律拒绝；
 * 每行必须是 IPv4:端口。端口不接受前导 0（"043" 看着像八进制，容易被误读）。
 */
function checkList(body) {
  if (body === '') return { ok: true, count: 0 };

  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  for (let i = 0; i < lines.length; i += 1) {
    // 容忍 \r\n：Windows 上手工 curl 测试不至于因为一个不可见字符失败
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (!isEndpoint(line)) {
      return { ok: false, reason: '第 ' + (i + 1) + ' 行不是合法的 IP:端口 → ' + clip(line) };
    }
  }
  return { ok: true, count: lines.length };
}

/** 严格校验 ``IPv4:端口``（第一阶段测速本身就只在 IPv4 上做）。 */
function isEndpoint(line) {
  const colon = line.lastIndexOf(':');
  if (colon <= 0) return false;

  const host = line.slice(0, colon);
  const port = line.slice(colon + 1);

  if (!/^[1-9]\d{0,4}$/.test(port)) return false;
  if (Number(port) > 65535) return false;

  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

function requireToken(request, env) {
  const expected = env.RELAY_TOKEN;
  if (!expected) {
    // 配置缺失要和「token 不对」分开报：前者需要去 `wrangler secret put RELAY_TOKEN`
    return pushText('worker 未配置 RELAY_TOKEN\n', 503);
  }
  const header = request.headers.get('authorization') || '';
  if (!sameSecret(header, 'Bearer ' + expected)) {
    return pushText('unauthorized\n', 401);
  }
  return null;
}

/** 常量时间比较：不按第一个不同字符提前返回，避免用响应耗时逐字符猜 token。 */
function sameSecret(got, expected) {
  const length = Math.max(got.length, expected.length);
  let diff = got.length ^ expected.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (got.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function clip(text) {
  const clean = String(text).replace(/[\r\n]/g, ' ');
  if (clean === '') return '（空行）';
  return clean.length > 80 ? clean.slice(0, 80) + '…' : clean;
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}
