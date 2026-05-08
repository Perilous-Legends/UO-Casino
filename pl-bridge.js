// Perilous Legends - Casino Bridge - Web Client
//
// Loaded by every casino page. Reads ?session=<token>#secret=<key> from
// the launch URL, caches the HMAC secret in memory, then issues signed
// requests to the PL server-side casino API.
//
// PL server is the AUTHORITY on balance. Every game must:
//   1. Call PL.init() on load (returns { account, character, balance, buyIn })
//   2. Call await PL.wager(gameId, amount) before locking a bet
//      → throws PLInsufficientFunds if balance can't cover
//   3. Call await PL.settle(gameId, payout) when the game resolves
//      (payout is the GROSS credit — 0 for a loss, 2*bet for 1:1 win, etc.)
//   4. Call PL.end() when the player clicks "Return to PL"
//
// Heartbeats run automatically every 60s. The server force-closes
// sessions idle for 5+ minutes, so don't pause the heartbeat without
// reason.
//
// API base resolution:
//   1. URL param ?api=<https://...>           (override, sticky in localStorage)
//   2. localStorage 'PL_API_BASE'             (set once via #1, reused)
//   3. window.PL_DEFAULT_API_BASE             (host-page injected)
//   4. window.location.origin                 (same-origin reverse proxy)
//
// All games receive the same global `PL` object. They MAY also import
// `PLInsufficientFunds`, `PLSessionClosed`, `PLNetworkError` from
// `window.PL.errors`.

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────
  // Error types
  // ────────────────────────────────────────────────────────────────────
  class PLBridgeError extends Error {
    constructor(code, msg) { super(msg); this.code = code; this.name = 'PLBridgeError'; }
  }
  class PLInsufficientFunds extends PLBridgeError {
    constructor(msg) { super('InsufficientBalance', msg || 'insufficient funds'); }
  }
  class PLSessionClosed extends PLBridgeError {
    constructor(msg) { super('SessionClosed', msg || 'session closed'); }
  }
  class PLNetworkError extends PLBridgeError {
    constructor(msg) { super('Network', msg || 'network error'); }
  }
  class PLNotInitialized extends PLBridgeError {
    constructor() { super('NotInitialized', 'PL.init() must be called first'); }
  }

  // ────────────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────────────
  let _sid          = null;       // session id (32 hex chars)
  let _secretBytes  = null;       // CryptoKey-backed HMAC key (raw bytes)
  let _hmacKey      = null;       // imported Web Crypto key
  let _seq          = 1;          // last seq sent (next call uses _seq+1)
  let _initialToken = null;       // the seq=1 token from the URL — used for /init only
  let _balance      = 0;
  let _buyIn        = 0;
  let _account      = '';
  let _character    = '';
  let _isClosed     = false;
  let _heartbeatTimer = null;
  let _balanceListeners = [];

  // ────────────────────────────────────────────────────────────────────
  // API base URL
  // ────────────────────────────────────────────────────────────────────
  // ⚠ Quick Cloudflare tunnel — URL changes every restart. When we move
  // to perilouslegends.com replace this with the named-tunnel URL.
  const PL_API_BASE_DEFAULT = 'https://where-licenses-career-keeping.trycloudflare.com';

  function resolveApiBase() {
    const u = new URL(window.location.href);
    const fromUrl = u.searchParams.get('api');
    if (fromUrl) {
      try { localStorage.setItem('PL_API_BASE', fromUrl); } catch (_) {}
      return fromUrl.replace(/\/+$/, '');
    }
    let stored = null;
    try { stored = localStorage.getItem('PL_API_BASE'); } catch (_) {}
    if (stored) return stored.replace(/\/+$/, '');
    if (window.PL_DEFAULT_API_BASE) return String(window.PL_DEFAULT_API_BASE).replace(/\/+$/, '');
    return PL_API_BASE_DEFAULT;
  }

  // ────────────────────────────────────────────────────────────────────
  // base64url helpers
  // ────────────────────────────────────────────────────────────────────
  function b64urlDecode(s) {
    const pad = '='.repeat((4 - s.length % 4) % 4);
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64urlEncode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  // ────────────────────────────────────────────────────────────────────
  // Token mint (HMAC-SHA256)
  // ────────────────────────────────────────────────────────────────────
  // Atomically advance the seq across all same-origin frames sharing this
  // session. Each call returns the next-to-use seq; reads sessionStorage
  // synchronously before any await so the parent and any iframe don't
  // collide. (Same-origin frames share a single event loop, so a sync
  // read-then-write is atomic relative to other frames' code.)
  function nextSeq() {
    let stored = 0;
    try {
      const s = sessionStorage.getItem(SS_SEQ);
      if (s) stored = parseInt(s, 10) || 0;
    } catch (_) {}
    const next = Math.max(stored, _seq) + 1;
    _seq = next;
    try { sessionStorage.setItem(SS_SEQ, String(next)); } catch (_) {}
    return next;
  }

  async function mintToken(seq) {
    if (!_hmacKey) throw new PLNotInitialized();
    const ts = Math.floor(Date.now() / 1000);
    const payload = `${_sid}|${seq}|${ts}`;
    const sig = await crypto.subtle.sign(
      'HMAC', _hmacKey, new TextEncoder().encode(payload)
    );
    return `${_sid}.${seq}.${ts}.${b64urlEncode(sig)}`;
  }

  // ────────────────────────────────────────────────────────────────────
  // URL parse + secret caching
  // ────────────────────────────────────────────────────────────────────
  function parseLaunchUrl() {
    const url = new URL(window.location.href);
    const tokenParam = url.searchParams.get('session');
    const hash = window.location.hash || '';
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const secretParam = hashParams.get('secret');
    if (!tokenParam || !secretParam) return null;

    const parts = tokenParam.split('.');
    if (parts.length !== 4) return null;
    const sid = parts[0];

    const secretBytes = b64urlDecode(secretParam);

    // Strip BOTH the session query param and the secret fragment from the
    // URL bar so a screenshot or copy-paste doesn't leak the secret.
    try {
      url.searchParams.delete('session');
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch (_) {}

    return { token: tokenParam, sid, secretBytes };
  }

  // ────────────────────────────────────────────────────────────────────
  // Persist secret across same-tab game navigation
  // ────────────────────────────────────────────────────────────────────
  // The casino floor (index.html) launches games as pop-up windows or tab
  // navigations. The secret won't survive a navigation if it lives only
  // in memory, so we stash it in sessionStorage. sessionStorage is
  // per-tab and cleared when the tab closes — secret never reaches disk
  // beyond the OS's transient memory.
  const SS_TOKEN  = 'PL_SESSION_TOKEN';
  const SS_SECRET = 'PL_SESSION_SECRET';
  const SS_SID    = 'PL_SESSION_SID';
  const SS_SEQ    = 'PL_SESSION_SEQ';

  function tryLoadFromSession() {
    try {
      const tok = sessionStorage.getItem(SS_TOKEN);
      const sec = sessionStorage.getItem(SS_SECRET);
      const sid = sessionStorage.getItem(SS_SID);
      const seq = sessionStorage.getItem(SS_SEQ);
      if (tok && sec && sid) {
        return { token: tok, sid, secretBytes: b64urlDecode(sec), seq: seq ? parseInt(seq, 10) : 1 };
      }
    } catch (_) {}
    return null;
  }

  function persistSession() {
    try {
      sessionStorage.setItem(SS_TOKEN, _initialToken);
      sessionStorage.setItem(SS_SECRET, b64urlEncode(_secretBytes));
      sessionStorage.setItem(SS_SID, _sid);
      sessionStorage.setItem(SS_SEQ, String(_seq));
    } catch (_) {}
  }

  function persistSeq() {
    try { sessionStorage.setItem(SS_SEQ, String(_seq)); } catch (_) {}
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SS_TOKEN);
      sessionStorage.removeItem(SS_SECRET);
      sessionStorage.removeItem(SS_SID);
      sessionStorage.removeItem(SS_SEQ);
    } catch (_) {}
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-tab call serializer — every API call queues behind the previous
  // one's promise. Prevents the race where a heartbeat and an end()
  // pick adjacent seq numbers but arrive at the server out of order.
  // (The server now also has a sliding-window replay check, so this is
  // belt-and-suspenders.)
  // ────────────────────────────────────────────────────────────────────
  let _callQueue = Promise.resolve();
  function queue(fn) {
    const next = _callQueue.then(fn, fn);
    _callQueue = next.catch(() => {}); // don't break the chain on errors
    return next;
  }

  // ────────────────────────────────────────────────────────────────────
  // HTTP
  // ────────────────────────────────────────────────────────────────────
  async function call(path, body) {
    if (_isClosed) throw new PLSessionClosed();
    const base = resolveApiBase();
    let resp;
    try {
      resp = await fetch(`${base}${path}`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new PLNetworkError(e && e.message);
    }
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    if (resp.ok && data.ok) return data;

    // Map server error codes to our exception types.
    const code = data.code || (resp.status === 410 ? 'SessionClosed'
                            : resp.status === 402 ? 'InsufficientBalance'
                            : resp.status === 401 ? 'BadSignature'
                            : resp.status === 409 ? 'ReplayedSequence'
                            : 'Unknown');
    const reason = data.reason || data.error || ('http ' + resp.status);
    if (code === 'InsufficientBalance') throw new PLInsufficientFunds(reason);
    if (code === 'SessionClosed' || code === 'SessionNotFound') {
      _isClosed = true;
      stopHeartbeat();
      clearSession();
      throw new PLSessionClosed(reason);
    }
    throw new PLBridgeError(code, reason);
  }

  function setBalance(b) {
    const next = Number(b);
    if (Number.isFinite(next) && next !== _balance) {
      _balance = next;
      for (const cb of _balanceListeners) {
        try { cb(_balance); } catch (_) {}
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Public surface
  // ────────────────────────────────────────────────────────────────────
  async function init() {
    if (_hmacKey) {
      // Already initialized in this module instance — refresh balance.
      await refreshBalance();
      return { account: _account, character: _character, balance: _balance, buyIn: _buyIn };
    }

    let bootstrap = parseLaunchUrl();
    let usingStash = false;
    if (!bootstrap) {
      bootstrap = tryLoadFromSession();
      usingStash = !!bootstrap;
    }
    if (!bootstrap) {
      throw new PLBridgeError('NoSession',
        'No casino session in URL. Buy in from a Casino Stone in Britain to start.');
    }

    _sid = bootstrap.sid;
    _secretBytes = bootstrap.secretBytes;
    _hmacKey = await crypto.subtle.importKey(
      'raw', _secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    _initialToken = bootstrap.token;
    _seq = usingStash ? (bootstrap.seq || 1) : 1;

    // First request — uses the inbound seq=1 token if fresh, otherwise
    // mints a new one with the next seq value.
    const tokenForInit = usingStash ? await mintToken(nextSeq()) : _initialToken;

    const data = await call('/api/casino/init', { token: tokenForInit });
    _account   = data.account || '';
    _character = data.character || '';
    _buyIn     = Number(data.buyIn) || 0;
    setBalance(Number(data.balance) || 0);

    persistSession();
    startHeartbeat();
    return { account: _account, character: _character, balance: _balance, buyIn: _buyIn };
  }

  function refreshBalance() {
    return queue(async () => {
      const t = await mintToken(nextSeq());
      const data = await call('/api/casino/balance', { token: t });
      setBalance(Number(data.balance) || 0);
      return _balance;
    });
  }

  function wager(gameId, amount, idempotencyKey) {
    if (!Number.isFinite(amount) || amount <= 0)
      return Promise.reject(new PLBridgeError('AmountOutOfRange', 'wager must be > 0'));
    const idem = idempotencyKey || newUuid();
    return queue(async () => {
      const t = await mintToken(nextSeq());
      const data = await call('/api/casino/wager', {
        token: t, gameId: gameId || '', amount: Math.floor(amount), idempotencyKey: idem
      });
      setBalance(Number(data.balance) || 0);
      return _balance;
    });
  }

  function settle(gameId, payout, idempotencyKey) {
    if (!Number.isFinite(payout) || payout < 0)
      return Promise.reject(new PLBridgeError('AmountOutOfRange', 'payout must be >= 0'));
    const idem = idempotencyKey || newUuid();
    return queue(async () => {
      const t = await mintToken(nextSeq());
      const data = await call('/api/casino/settle', {
        token: t, gameId: gameId || '', payout: Math.floor(payout), idempotencyKey: idem
      });
      setBalance(Number(data.balance) || 0);
      return _balance;
    });
  }

  function heartbeat() {
    if (!_hmacKey || _isClosed) return Promise.resolve();
    return queue(async () => {
      try {
        const t = await mintToken(nextSeq());
        const data = await call('/api/casino/heartbeat', { token: t });
        setBalance(Number(data.balance) || 0);
      } catch (e) {
        if (e instanceof PLSessionClosed) throw e;
      }
    });
  }

  function end() {
    if (_isClosed) return Promise.resolve({ deposited: 0 });
    return queue(async () => {
      const t = await mintToken(nextSeq());
      let data;
      try {
        data = await call('/api/casino/end', { token: t });
      } finally {
        _isClosed = true;
        stopHeartbeat();
        clearSession();
      }
      return { deposited: Number(data.deposited) || 0 };
    });
  }

  function startHeartbeat() {
    stopHeartbeat();
    // Only the top-level frame heartbeats. Iframes share the same
    // session and the parent's heartbeats keep it alive — running two
    // wastes API calls and can race the parent's seq advance.
    if (window !== window.top) return;
    _heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, 60_000);
    // Note: NO beforeunload → /end fallback. Web Crypto is async-only,
    // so we can't sign a token synchronously inside the unload handler
    // (Promises are abandoned by the browser there). The server-side
    // 5-min idle watchdog cleanly closes orphaned sessions and refunds
    // the BankCheck, so a tab-close just delays cashout by ≤5 minutes.
  }
  function stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  }

  // ────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────
  function newUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function fmtGold(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  // ────────────────────────────────────────────────────────────────────
  // Public surface
  // ────────────────────────────────────────────────────────────────────
  window.PL = {
    init,
    refreshBalance,
    wager,
    settle,
    heartbeat,
    end,
    onBalanceChanged(cb) { if (typeof cb === 'function') _balanceListeners.push(cb); },
    balance:   () => _balance,
    buyIn:     () => _buyIn,
    account:   () => _account,
    character: () => _character,
    isClosed:  () => _isClosed,
    fmtGold,
    errors: { PLBridgeError, PLInsufficientFunds, PLSessionClosed, PLNetworkError, PLNotInitialized },
  };
})();
