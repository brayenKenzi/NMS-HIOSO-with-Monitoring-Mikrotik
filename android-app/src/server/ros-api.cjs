const net = require('node:net');
const crypto = require('node:crypto');

/** Encodes a single word using RouterOS binary API length prefixing. */
function encodeWord(word) {
  const payload = Buffer.from(String(word), 'utf8');
  const len = payload.length;
  let hdr;
  if (len < 0x80) {
    hdr = Buffer.from([len]);
  } else if (len < 0x4000) {
    const val = len | 0x8000;
    hdr = Buffer.from([(val >> 8) & 0xFF, val & 0xFF]);
  } else if (len < 0x200000) {
    const val = len | 0xC00000;
    hdr = Buffer.from([(val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]);
  } else if (len < 0x10000000) {
    const val = len | 0xE0000000;
    hdr = Buffer.from([(val >>> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]);
  } else {
    hdr = Buffer.from([0xF0, (len >>> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
  }
  return Buffer.concat([hdr, payload]);
}

/** Encodes a full RouterOS API sentence terminated by a zero-length word. */
function encodeSentence(words) {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0])]);
}

function decodeLength(buf, off) {
  if (off >= buf.length) return null;
  const c0 = buf[off];
  if ((c0 & 0x80) === 0) return [c0, 1];
  if ((c0 & 0xC0) === 0x80) {
    if (off + 1 >= buf.length) return null;
    return [((c0 & 0x3F) << 8) | buf[off + 1], 2];
  }
  if ((c0 & 0xE0) === 0xC0) {
    if (off + 2 >= buf.length) return null;
    return [((c0 & 0x1F) << 16) | (buf[off + 1] << 8) | buf[off + 2], 3];
  }
  if ((c0 & 0xF0) === 0xE0) {
    if (off + 3 >= buf.length) return null;
    return [((c0 & 0x0F) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3], 4];
  }
  if (off + 4 >= buf.length) return null;
  return [((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0, 5];
}

function parseAttributes(words) {
  const obj = {};
  for (const w of words) {
    if (!w.startsWith('=')) continue;
    const eq = w.indexOf('=', 1);
    if (eq > 0) obj[w.slice(1, eq)] = w.slice(eq + 1);
    else obj[w.slice(1)] = '';
  }
  return obj;
}

const sessionPool = new Map();

function sessionKey(host, port, username) {
  return host + ':' + port + ':' + username;
}

function makeTransportError(msg) {
  const err = new Error(msg);
  err.isTransport = true;
  return err;
}

class RosApiSession {
  constructor(host, port, username, password) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.words = [];
    this.authenticated = false;
    this.closed = false;
    this.pending = null;
    this.tail = Promise.resolve();
  }

  _rejectPending(err) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.rej(err instanceof Error ? err : new Error(String(err)));
  }

  _dispatchSentence(sent) {
    if (!sent.length || !this.pending) return;
    const reply = sent[0];
    const attrs = parseAttributes(sent.slice(1));
    if (reply === '!re') {
      this.pending.records.push(attrs);
    } else if (reply === '!trap' || reply === '!fatal') {
      this.pending.error = attrs.message || 'RouterOS API error';
      if (reply === '!fatal') {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.rej(makeTransportError(p.error));
      }
    } else if (reply === '!done') {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      if (p.error) {
        const err = new Error(p.error);
        err.isTrap = true;
        p.rej(err);
      } else {
        p.res({ records: p.records, done: attrs });
      }
    }
  }

  _sendSentence(sentence, timeoutMs = 6000) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(makeTransportError('Koneksi RouterOS API terputus.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) {
          this.pending = null;
          this._resetSocket();
          reject(makeTransportError('Koneksi RouterOS API timeout.'));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending = { res: resolve, rej: reject, records: [], error: null, timer };
      try {
        this.socket.write(encodeSentence(sentence));
      } catch (err) {
        this._rejectPending(makeTransportError('RouterOS API: ' + (err.code || err.message)));
      }
    });
  }

  async _ensureConnected(timeoutMs = 6000) {
    if (this.authenticated && this.socket && !this.socket.destroyed) return;
    this._resetSocket();
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch {}
        reject(makeTransportError('Koneksi RouterOS API timeout.'));
      }, timeoutMs);
      timer.unref?.();

      socket.once('connect', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.setKeepAlive(true, 15000);
        socket.unref();
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.words = [];
        socket.on('data', (chunk) => {
          this.buf = Buffer.concat([this.buf, chunk]);
          while (true) {
            const res = decodeLength(this.buf, 0);
            if (!res) break;
            const [len, hdr] = res;
            if (len === 0) {
              this.buf = this.buf.subarray(hdr);
              const finished = this.words;
              this.words = [];
              this._dispatchSentence(finished);
              continue;
            }
            if (this.buf.length < hdr + len) break;
            this.words.push(this.buf.subarray(hdr, hdr + len).toString('utf8'));
            this.buf = this.buf.subarray(hdr + len);
          }
        });
        socket.on('error', (err) => {
          this.authenticated = false;
          this._rejectPending(makeTransportError('RouterOS API: ' + (err.code || err.message)));
        });
        socket.on('close', () => {
          this.authenticated = false;
          this.socket = null;
          this._rejectPending(makeTransportError('Koneksi RouterOS API ditutup router.'));
        });
        resolve();
      });

      socket.once('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch {}
        reject(makeTransportError('RouterOS API: ' + (err.code || err.message)));
      });
    });

    const loginRes = await this._sendSentence(['/login', '=name=' + this.username, '=password=' + this.password], timeoutMs);
    if (loginRes.done?.ret) {
      const digest = crypto.createHash('md5').update(
        Buffer.concat([Buffer.from([0]), Buffer.from(this.password, 'utf8'), Buffer.from(loginRes.done.ret, 'hex')])
      ).digest('hex');
      await this._sendSentence(['/login', '=name=' + this.username, '=response=00' + digest], timeoutMs);
    }
    this.authenticated = true;
  }

  _resetSocket() {
    this.authenticated = false;
    this._rejectPending(makeTransportError('Koneksi RouterOS API direset.'));
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch {}
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
    this.buf = Buffer.alloc(0);
    this.words = [];
  }

  close() {
    this.closed = true;
    this._resetSocket();
  }

  async _runList(commands, timeoutMs) {
    await this._ensureConnected(timeoutMs);
    const results = [];
    for (const cmd of commands) {
      const out = await this._sendSentence(cmd, timeoutMs);
      results.push(out.records);
    }
    return results;
  }

  execBatch(commands = [], timeoutMs = 6000) {
    const task = async () => {
      const wasAuthenticated = Boolean(this.authenticated && this.socket && !this.socket.destroyed);
      try {
        return await this._runList(commands, timeoutMs);
      } catch (err) {
        if (err.isTransport && wasAuthenticated && !this.closed) {
          this._resetSocket();
          return await this._runList(commands, timeoutMs);
        }
        if (!this.authenticated || err.isTransport) {
          this._resetSocket();
        }
        throw err;
      }
    };
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}

/**
 * Reuses a persistent authenticated MikroTik RouterOS API socket (port 8728)
 * across polls so RouterOS only logs one `/login` per session instead of
 * spamming login/logout every 3 seconds.
 */
async function runRosApiCommands(host, port = 8728, username, password, commands = [], timeoutMs = 6000) {
  const key = sessionKey(host, port, username);
  let sess = sessionPool.get(key);
  if (sess && (sess.password !== password || sess.closed)) {
    sess.close();
    sessionPool.delete(key);
    sess = null;
  }
  if (!sess) {
    sess = new RosApiSession(host, port, username, password);
    sessionPool.set(key, sess);
  }
  try {
    return await sess.execBatch(commands, timeoutMs);
  } catch (err) {
    if (!sess.authenticated && sessionPool.get(key) === sess) {
      sessionPool.delete(key);
    }
    throw err;
  }
}

function closeRosApiSession(host, port = 8728, username) {
  const key = sessionKey(host, port, username);
  const sess = sessionPool.get(key);
  if (sess) {
    sessionPool.delete(key);
    sess.close();
  }
}

function closeAllRosApiSessions() {
  for (const [key, sess] of sessionPool.entries()) {
    sessionPool.delete(key);
    sess.close();
  }
}

/** Fast reachability probe over the persistent RouterOS API session (no extra login). */
function probeRosApi(host, port = 8728, username, password, timeoutMs = 2000) {
  return runRosApiCommands(host, port, username, password, [['/system/identity/print']], timeoutMs)
    .then(() => true)
    .catch((err) => /invalid user name or password/i.test(err.message));
}

module.exports = {
  encodeWord,
  encodeSentence,
  runRosApiCommands,
  probeRosApi,
  closeRosApiSession,
  closeAllRosApiSessions,
};
