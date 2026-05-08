/**
 * webBridge — opt-in dev/test HTTP+WS bridge that mirrors Friday's IPC surface
 * so the renderer can be loaded in a real browser (Chrome, Firefox, etc.).
 *
 * SECURITY: This bridge has full host privileges. It can launch local apps,
 * read SQLite, see API keys, and execute tools. It MUST be bound to loopback
 * (127.0.0.1) only. Loopback enforcement happens in main.js BEFORE this module
 * is loaded.
 *
 * Wire format:
 *   GET  /                 → /index.html with ?web=1 forced via redirect
 *   GET  /healthz          → { ready, providers, activeSession, localOnly, ... }
 *   GET  /<file>           → static file from src/renderer/ or whitelisted node_modules paths
 *   POST /ipc/<channel>    → invokes ipcHandlers[channel](body); JSON in/out
 *                            Special: /ipc/transcribe-audio and /ipc/extract-file-text
 *                            accept multipart/form-data for binary blobs
 *   WS   /events           → broadcasts main→renderer push events (agent-event, etc.)
 *                            Receives { type: 'permission-response', ... } messages
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
};

// Whitelisted node_modules subtrees that the renderer loads via <script src="../../node_modules/...">.
// Anything outside these is rejected to avoid serving credentials, configs, or unrelated code.
const NODE_MODULES_WHITELIST = [
  'marked',
  'highlight.js',
  '@highlightjs',
  'katex',
];

function _safeJoin(rootDir, relative) {
  const decoded = decodeURIComponent(relative).replace(/^\/+/, '');
  const joined = path.normalize(path.join(rootDir, decoded));
  if (!joined.startsWith(path.normalize(rootDir))) return null;
  return joined;
}

function _send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function _sendJson(res, status, obj) {
  _send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function _readBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function _parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();
  const boundaryBuf = Buffer.from(boundary);
  const parts = [];
  let pos = 0;
  while (pos < body.length) {
    const boundaryStart = body.indexOf(boundaryBuf, pos);
    if (boundaryStart < 0) break;
    const partStart = boundaryStart + boundaryBuf.length;
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    const headerStart = partStart + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const headerStr = body.slice(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundaryBuf, dataStart);
    const dataEnd = nextBoundary < 0 ? body.length : nextBoundary - 2;

    const part = { headers: {}, data: body.slice(dataStart, dataEnd) };
    for (const line of headerStr.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) part.headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const cd = part.headers['content-disposition'] || '';
    const nameMatch = /name="([^"]+)"/.exec(cd);
    const filenameMatch = /filename="([^"]*)"/.exec(cd);
    if (nameMatch) part.name = nameMatch[1];
    if (filenameMatch) part.filename = filenameMatch[1];
    part.contentType = part.headers['content-type'];
    parts.push(part);
    pos = nextBoundary < 0 ? body.length : nextBoundary;
  }
  return parts;
}

// ─── WebSocket (RFC 6455) — minimal server-side implementation ────────────────
// Avoids the `ws` dep so npm install isn't needed for the bridge to function.
const crypto = require('crypto');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function _wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function _wsEncode(payload, opcode = 0x1) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function _wsDecodeFrames(buffer) {
  const frames = [];
  let pos = 0;
  while (pos + 2 <= buffer.length) {
    const b1 = buffer[pos];
    const b2 = buffer[pos + 1];
    const fin = (b1 & 0x80) !== 0;
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f;
    let headerLen = 2;
    if (len === 126) { len = buffer.readUInt16BE(pos + 2); headerLen = 4; }
    else if (len === 127) { len = Number(buffer.readBigUInt64BE(pos + 2)); headerLen = 10; }
    if (masked) headerLen += 4;
    if (pos + headerLen + len > buffer.length) break; // incomplete
    const maskKey = masked ? buffer.slice(pos + headerLen - 4, pos + headerLen) : null;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      const b = buffer[pos + headerLen + i];
      payload[i] = masked ? b ^ maskKey[i & 3] : b;
    }
    frames.push({ fin, opcode, payload });
    pos += headerLen + len;
  }
  return { frames, consumed: pos };
}

function _attachWebSocketServer(server, onConnection) {
  server.on('upgrade', (req, socket /* head */) => {
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    if (req.url !== '/events') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = _wsAccept(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );
    let inbox = Buffer.alloc(0);
    const conn = {
      socket,
      send: (text) => { try { socket.write(_wsEncode(text, 0x1)); } catch {} },
      close: () => { try { socket.end(_wsEncode('', 0x8)); } catch {} },
      onMessage: () => {},
    };
    socket.on('data', (chunk) => {
      inbox = Buffer.concat([inbox, chunk]);
      const { frames, consumed } = _wsDecodeFrames(inbox);
      inbox = inbox.slice(consumed);
      for (const f of frames) {
        if (f.opcode === 0x8) { conn.close(); return; }       // close
        if (f.opcode === 0x9) { socket.write(_wsEncode(f.payload.toString('utf8'), 0xA)); continue; } // ping → pong
        if (f.opcode === 0xA) continue;                        // pong
        if (f.opcode === 0x1) {
          try { conn.onMessage(f.payload.toString('utf8')); }
          catch (e) { console.error('[webBridge] WS handler threw:', e.message); }
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => onDisconnect(conn));
    onConnection(conn);
  });
  const onDisconnect = () => {};
  return { onDisconnect };
}

// ─── Public entry point ──────────────────────────────────────────────────────

async function startWebBridge({
  host,
  port,
  ipcHandlers,
  registerBroadcaster,
  onPermissionResponse,
  getStatus,
  rendererDir,
  nodeModulesDir,
}) {
  const wsClients = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      const pathname = url.pathname;

      // ── Health check ────────────────────────────────────────────────────────
      if (pathname === '/healthz') {
        return _sendJson(res, 200, getStatus ? getStatus() : { ready: true });
      }

      // ── IPC bridge: POST /ipc/<channel> ─────────────────────────────────────
      if (req.method === 'POST' && pathname.startsWith('/ipc/')) {
        const channel = pathname.slice('/ipc/'.length);
        const handler = ipcHandlers[channel];
        if (!handler) return _sendJson(res, 404, { success: false, error: `Unknown channel: ${channel}` });

        const ct = req.headers['content-type'] || '';
        // argList = the variadic argument list to pass to the handler.
        // - JSON body: [parsedValue] (so single-arg handlers see (event, parsed))
        // - Multipart with file part: [fileBuffer, ...extraStringArgs]
        // - Empty body: [] (handler called as fn(event))
        let argList;
        try {
          if (ct.startsWith('multipart/form-data')) {
            const body = await _readBody(req);
            const parts = _parseMultipart(body, ct);
            const filePart = parts.find((p) => p.filename != null);
            const argParts = parts.filter((p) => p.filename == null);
            const extras = argParts.map((p) => p.data.toString('utf8'));
            argList = filePart ? [filePart.data, ...extras] : extras;
          } else if (ct.includes('application/json')) {
            const body = await _readBody(req);
            argList = body.length ? [JSON.parse(body.toString('utf8'))] : [];
          } else {
            argList = [];
          }
        } catch (err) {
          return _sendJson(res, 400, { success: false, error: `Bad request body: ${err.message}` });
        }

        try {
          const result = await handler(...argList);
          return _sendJson(res, 200, { __wrapped: true, value: result });
        } catch (err) {
          console.error(`[webBridge] handler ${channel} threw:`, err.message);
          return _sendJson(res, 500, { success: false, error: err.message });
        }
      }

      // ── Static: redirect bare / to index.html ───────────────────────────────
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return _serveStatic(res, path.join(rendererDir, 'index.html'));
      }
      if (req.method === 'GET' && pathname === '/settings.html') {
        return _serveStatic(res, path.join(rendererDir, 'settings.html'));
      }

      // ── Static: node_modules whitelist ──────────────────────────────────────
      // Renderer currently uses paths like ../../node_modules/marked/...
      // We rewrite that to /node_modules/... when ?web=1 is set (see webShim.js).
      if (req.method === 'GET' && pathname.startsWith('/node_modules/')) {
        const rel = pathname.slice('/node_modules/'.length);
        const top = rel.split('/')[0].startsWith('@') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0];
        if (!NODE_MODULES_WHITELIST.includes(top)) {
          return _send(res, 403, 'Forbidden');
        }
        const target = _safeJoin(nodeModulesDir, rel);
        if (!target) return _send(res, 403, 'Forbidden');
        return _serveStatic(res, target);
      }

      // ── Static: anything under /public/ (icons) ─────────────────────────────
      if (req.method === 'GET' && pathname.startsWith('/public/')) {
        const rel = pathname.slice('/public/'.length);
        const target = _safeJoin(path.join(rendererDir, '../../public'), rel);
        if (!target) return _send(res, 403, 'Forbidden');
        return _serveStatic(res, target);
      }

      // ── Static: anything else under renderer dir ────────────────────────────
      if (req.method === 'GET') {
        const target = _safeJoin(rendererDir, pathname);
        if (!target) return _send(res, 403, 'Forbidden');
        return _serveStatic(res, target);
      }

      _send(res, 405, 'Method not allowed');
    } catch (err) {
      console.error('[webBridge] request error:', err);
      _send(res, 500, 'Internal error');
    }
  });

  _attachWebSocketServer(server, (conn) => {
    wsClients.add(conn);
    conn.onMessage = (text) => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (msg && msg.type === 'permission-response') {
        onPermissionResponse?.(msg);
      }
    };
    conn.socket.on('close', () => wsClients.delete(conn));
  });

  registerBroadcaster((channel, data) => {
    const payload = JSON.stringify({ channel, data });
    for (const c of wsClients) c.send(payload);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return { server, broadcastCount: () => wsClients.size };
}

function _serveStatic(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return _send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { startWebBridge };
