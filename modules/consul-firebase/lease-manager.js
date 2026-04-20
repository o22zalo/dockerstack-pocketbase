'use strict';

const { EventEmitter } = require('node:events');

function toBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeFirebaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (!raw.includes('.json')) {
    throw new Error('CONSUL_FIREBASE_URL phải là URL Realtime Database endpoint có hậu tố .json');
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') {
      throw new Error('CONSUL_FIREBASE_URL phải dùng https://');
    }
    if ((parsed.search || '').includes('.json')) {
      throw new Error('CONSUL_FIREBASE_URL có dấu hiệu bị ghép sai (query đang chứa .json path).');
    }
    if ((parsed.search || '').includes('/')) {
      throw new Error('CONSUL_FIREBASE_URL có dấu hiệu ghép sai path trong query string.');
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('CONSUL_FIREBASE_URL không phải URL hợp lệ.');
    }
    throw err;
  }
  return raw;
}

function withQuery(url, patch = {}) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    next.searchParams.set(key, String(value));
  }
  return next.toString();
}

class FirebaseLeaseManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.enabled = toBool(opts.enabled, false);
    this.leaseUrl = normalizeFirebaseUrl(opts.leaseUrl || '');
    this.ownerId = String(opts.ownerId || '').trim() || `node-${Math.random().toString(16).slice(2)}`;
    this.leaseTtlMs = Number(opts.leaseTtlMs || 70000);
    this.renewIntervalMs = Number(opts.renewIntervalMs || 15000);
    this.pollIntervalMs = Number(opts.pollIntervalMs || 10000);
    this.listenSse = toBool(opts.listenSse, true);
    this.requestTimeoutMs = Number(opts.requestTimeoutMs || 10000);
    this.takeoverOnJoin = toBool(opts.takeoverOnJoin, false);

    this.isWriter = !this.enabled;
    this.currentLease = null;
    this.currentEtag = null;
    this.lastRenewedAt = 0;

    this._renewTimer = null;
    this._pollTimer = null;
    this._sseAbort = null;
    this._stopped = false;
  }

  async start() {
    if (!this.enabled) {
      this.emitRole(true, 'CONSUL_FIREBASE_ENABLE=false');
      return;
    }
    try {
      await this.refreshLease('start');
    } catch (err) {
      this.emit('warn', `[lease][start] ${err.message}. tạm chạy standby và retry theo chu kỳ.`);
      this.emitRole(false, 'start failed');
    }
    this._renewTimer = setInterval(() => {
      this.refreshLease('renew-tick').catch((err) => this.emit('warn', `[lease][renew] ${err.message}`));
    }, this.renewIntervalMs);

    this._pollTimer = setInterval(() => {
      this.observeLease('poll').catch((err) => this.emit('warn', `[lease][poll] ${err.message}`));
    }, this.pollIntervalMs);

    if (this.listenSse) {
      this.startSseListener();
    }
  }

  async stop() {
    this._stopped = true;
    if (this._renewTimer) clearInterval(this._renewTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._sseAbort) this._sseAbort.abort();
  }

  emitRole(nextIsWriter, reason) {
    if (this.isWriter === nextIsWriter) return;
    this.isWriter = nextIsWriter;
    this.emit('role', {
      isWriter: nextIsWriter,
      role: nextIsWriter ? 'writer' : 'standby',
      reason,
      ownerId: this.ownerId,
      lease: this.currentLease
    });
  }

  makeLeasePayload(nowMs) {
    return {
      ownerId: this.ownerId,
      expiresAt: nowMs + this.leaseTtlMs,
      renewedAt: nowMs,
      version: 1
    };
  }

  async fetchLease() {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(withQuery(this.leaseUrl, { print: 'pretty' }), {
        headers: {
          'X-Firebase-ETag': 'true',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} khi đọc lease`);
      }
      const etag = res.headers.get('etag');
      const data = await res.json();
      return { etag, data: data && typeof data === 'object' ? data : null };
    } finally {
      clearTimeout(t);
    }
  }

  canTakeOver(lease, nowMs) {
    if (!lease || typeof lease !== 'object') return true;
    if (!lease.ownerId) return true;
    if (lease.ownerId === this.ownerId) return true;
    return Number(lease.expiresAt || 0) <= nowMs;
  }

  async writeLease(etag, payload) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(withQuery(this.leaseUrl, { print: 'silent' }), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'if-match': etag || '*'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (res.status === 412) return false;
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} khi ghi lease: ${(text || '').slice(0, 300)}`);
      }
      return true;
    } finally {
      clearTimeout(t);
    }
  }

  async refreshLease(reason) {
    if (this._stopped || !this.enabled) return;
    const nowMs = Date.now();
    const { etag, data } = await this.fetchLease();
    this.currentLease = data;
    this.currentEtag = etag;

    const allowPreempt = reason === 'start' && this.takeoverOnJoin;
    if (!this.canTakeOver(data, nowMs) && !allowPreempt) {
      this.emitRole(false, `${reason}: lease đang thuộc owner khác`);
      return;
    }

    const payload = this.makeLeasePayload(nowMs);
    const ok = await this.writeLease(etag, payload);
    if (!ok) {
      this.emitRole(false, `${reason}: lease race (412)`);
      return;
    }

    this.currentLease = payload;
    this.lastRenewedAt = nowMs;
    this.emitRole(true, allowPreempt ? `${reason}: preempted lease on join` : `${reason}: lease renewed`);
  }

  async observeLease(reason) {
    if (this._stopped || !this.enabled) return;
    const nowMs = Date.now();
    const { data } = await this.fetchLease();
    this.currentLease = data;

    if (!data || typeof data !== 'object') {
      this.emitRole(false, `${reason}: lease rỗng`);
      return;
    }

    if (data.ownerId === this.ownerId && Number(data.expiresAt || 0) > nowMs) {
      this.emitRole(true, `${reason}: lease xác nhận owner local`);
      return;
    }
    this.emitRole(false, `${reason}: owner active khác`);
  }

  async startSseListener() {
    if (this._stopped || !this.enabled) return;

    const url = withQuery(this.leaseUrl, { ns: '' });
    this._sseAbort = new AbortController();

    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache'
        },
        signal: this._sseAbort.signal
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!this._stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (chunk.includes('event: put') || chunk.includes('event: patch')) {
            this.observeLease('sse').catch((err) => this.emit('warn', `[lease][sse-observe] ${err.message}`));
          }
        }
      }
    } catch (err) {
      if (!this._stopped) {
        this.emit('warn', `[lease][sse] ${err.message}`);
        setTimeout(() => {
          if (!this._stopped) this.startSseListener().catch((e) => this.emit('warn', `[lease][sse-retry] ${e.message}`));
        }, Math.min(this.pollIntervalMs, 10000));
      }
    }
  }

  getState() {
    return {
      enabled: this.enabled,
      role: this.isWriter ? 'writer' : 'standby',
      isWriter: this.isWriter,
      ownerId: this.ownerId,
      lease: this.currentLease,
      lastRenewedAt: this.lastRenewedAt
    };
  }
}

module.exports = {
  FirebaseLeaseManager,
  toBool
};
