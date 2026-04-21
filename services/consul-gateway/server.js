'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { FirebaseLeaseManager, toBool } = require('../../modules/consul-firebase/lease-manager');

const PORT = Number(process.env.CONSUL_GATEWAY_PORT || 18090);
const UPSTREAM = process.env.CONSUL_UPSTREAM_URL || 'http://app:8090';
const ENABLED = toBool(process.env.CONSUL_FIREBASE_ENABLE, false);
const FIREBASE_URL = process.env.CONSUL_FIREBASE_URL || '';
const OWNER_ID = (process.env.CONSUL_NODE_ID || process.env.HOSTNAME || 'node-unknown').trim();
const LEASE_TTL_MS = Number(process.env.CONSUL_LEASE_TTL_MS || 70000);
const LEASE_RENEW_MS = Number(process.env.CONSUL_LEASE_RENEW_MS || 15000);
const LEASE_POLL_MS = Number(process.env.CONSUL_LEASE_POLL_MS || 10000);
const SSE_ENABLE = toBool(process.env.CONSUL_FIREBASE_SSE_ENABLE, true);
const LOST_LEASE_EXIT = toBool(process.env.CONSUL_LOST_LEASE_EXIT, false);
const STANDBY_ALLOW_API_READONLY = toBool(process.env.CONSUL_STANDBY_ALLOW_API_READONLY, true);
const TAKEOVER_ON_JOIN = toBool(process.env.CONSUL_TAKEOVER_ON_JOIN, false);

const READ_METHODS = new Set(['GET', 'HEAD']);
const upstreamBase = new URL(UPSTREAM);

let role = ENABLED ? 'standby' : 'writer';
let hadWriterRole = false;

const leaseManager = new FirebaseLeaseManager({
  enabled: ENABLED,
  leaseUrl: FIREBASE_URL,
  ownerId: OWNER_ID,
  leaseTtlMs: LEASE_TTL_MS,
  renewIntervalMs: LEASE_RENEW_MS,
  pollIntervalMs: LEASE_POLL_MS,
  listenSse: SSE_ENABLE,
  takeoverOnJoin: TAKEOVER_ON_JOIN
});

leaseManager.on('warn', (msg) => console.warn(`[consul] ${msg}`));
leaseManager.on('info', (msg) => console.log(`[consul] ${msg}`));
leaseManager.on('role', (evt) => {
  const prev = role;
  role = evt.role;
  if (evt.isWriter) hadWriterRole = true;
  if (prev !== role) {
    console.log(`[consul] role changed: ${prev} -> ${role}. reason=${evt.reason}`);
  }
  if (LOST_LEASE_EXIT && hadWriterRole && !evt.isWriter) {
    console.error('[consul] lost lease, exiting process for hard fencing.');
    process.exit(1);
  }
});

function isReadonlyAllowed(req) {
  if (!STANDBY_ALLOW_API_READONLY) return false;
  if (!READ_METHODS.has((req.method || '').toUpperCase())) return false;
  return req.url === '/api' || req.url.startsWith('/api/');
}

function shouldBlock(req) {
  if (!ENABLED) return false;
  if (role === 'writer') return false;
  return !isReadonlyAllowed(req);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Consul-Role': role
  });
  res.end(body);
}

function currentModeLabel() {
  return role === 'writer' ? 'leader-writer' : 'standby-read-only';
}

function proxyRequest(clientReq, clientRes) {
  const target = new URL(clientReq.url || '/', upstreamBase);

  const headers = { ...clientReq.headers };
  headers.host = target.host;
  headers['x-consul-role'] = role;

  const proxyReq = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: clientReq.method,
      headers
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 502, {
        ...proxyRes.headers,
        'x-consul-role': role
      });
      proxyRes.pipe(clientRes);
    }
  );

  proxyReq.on('error', (err) => {
    sendJson(clientRes, 502, {
      error: 'bad_gateway',
      message: err.message,
      role
    });
  });

  clientReq.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/__consul/status')) {
    console.log(`[consul] [status] mode=${currentModeLabel()}, method=${req.method}, path=${req.url}`);
    return sendJson(res, 200, {
      ok: true,
      upstream: UPSTREAM,
      role,
      lease: leaseManager.getState()
    });
  }

  if (shouldBlock(req)) {
    console.warn(`[consul] [readonly-enforce] mode=${currentModeLabel()}, blocking method=${req.method}, path=${req.url}`);
    return sendJson(res, 503, {
      error: 'standby_readonly',
      message: 'Node đang ở standby. Chỉ cho phép GET/HEAD ở /api/*.',
      role,
      method: req.method,
      path: req.url
    });
  }

  return proxyRequest(req, res);
});

async function main() {
  await leaseManager.start();
  server.listen(PORT, () => {
    console.log(`[consul] gateway listening on :${PORT}, upstream=${UPSTREAM}, enabled=${ENABLED}`);
    console.log(`[consul] startup mode=${currentModeLabel()}, ownerId=${OWNER_ID}, readonly_api=${STANDBY_ALLOW_API_READONLY}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`[consul] received ${signal}, shutting down.`);
    server.close();
    await leaseManager.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[consul] fatal: ${err.message}`);
  process.exit(1);
});
