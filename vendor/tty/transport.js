(() => {
  'use strict';

  const {connect} = window.TTYShareVendor;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const relay = 'wss://demo.nats.io:8443';
  const version = 'v2';
  const pinAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pinPattern = new RegExp('^[' + pinAlphabet + ']{4}$');
  const roomPattern = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{87})$/;
  const lifetime = 120000;
  // Keep-Alive packets are authenticated and remain active only after approval.
  const heartbeat = 8000;
  const maxFrame = 262144;
  const maxQueue = 1048576;
  const kind = Object.freeze({join: 1, allow: 2, reject: 3, screen: 4, input: 5,
    output: 6, resize: 7, ping: 8, end: 9, cursor: 10});

  function encodeBytes(bytes) {
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }

  function decodeBytes(value) {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  }

  const pack = value => encoder.encode(JSON.stringify(value));
  const unpack = bytes => JSON.parse(decoder.decode(bytes));
  const randomId = () => encodeBytes(crypto.getRandomValues(new Uint8Array(16)));
  const generateKey = () => crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveBits']);
  const publicKey = async keys => encodeBytes(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const route = room => 'robit.tty.share.' + version + '.' + room;
  const newPIN = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), value => pinAlphabet[value & 31]).join('');
  const hasPermissions = value => Boolean(value && typeof value.view === 'boolean' &&
    typeof value.write === 'boolean' && (value.view || value.write));

  function parseInvite(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value.trim(), location.href);
      // An invite supplies a key and room only. Never navigate to or fetch the scanned address.
      if ((url.protocol !== 'https:' && url.origin !== location.origin) || url.username || url.password) return null;
      const hash = new URLSearchParams(url.hash.slice(1));
      const room = hash.get('ttyshare') || '';
      if (!room.startsWith(version + '.')) return null;
      const match = roomPattern.exec(room.slice(version.length + 1));
      if (!match || decodeBytes(match[2])[0] !== 4 || encodeBytes(decodeBytes(match[1])) !== match[1]
          || encodeBytes(decodeBytes(match[2])) !== match[2]) return null;
      return {room: match[1], hostKey: match[2]};
    } catch (_) {
      return null;
    }
  }

  async function deriveKeys({room, hostKey}, attempt, guestKey, keyPair, host) {
    const remoteKey = await crypto.subtle.importKey('raw', decodeBytes(host ? guestKey : hostKey),
      {name: 'ECDH', namedCurve: 'P-256'}, false, []);
    const secret = await crypto.subtle.deriveBits({name: 'ECDH', public: remoteKey}, keyPair.privateKey, 256);
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    new Uint8Array(secret).fill(0);
    const derive = (label, algorithm, operations) => crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: decodeBytes(room),
      info: pack(['tty-share', version, room, attempt, hostKey, guestKey, label])
    }, base, algorithm, false, operations);
    const gcm = {name: 'AES-GCM', length: 256};
    // Split keys by traffic direction and purpose. The short PIN is never an encryption key.
    const [outgoing, incoming, proof] = await Promise.all([
      derive(host ? 'host' : 'guest', gcm, ['encrypt']),
      derive(host ? 'guest' : 'host', gcm, ['decrypt']),
      derive('pin-proof', {name: 'HMAC', hash: 'SHA-256'}, [host ? 'verify' : 'sign'])
    ]);
    return {outgoing, incoming, proof};
  }

  function pinProofLink(room, attempt, mode, permissions, pin) {
    return pack(['tty-share-pin', version, room, attempt, mode, permissions ? [permissions.view, permissions.write] : null, pin]);
  }

  async function openRelay() {
    return connect({servers: relay, reconnect: false, ignoreServerUpdates: true,
      timeout: 8000, pingInterval: 15000, maxPingOut: 2, waitOnFirstConnect: false});
  }

  async function quietClose(nc) {
    const timer = setTimeout(() => nc.close(), 1000);
    try { if (!nc.isClosed()) await nc.flush(); } catch (_) {}
    clearTimeout(timer);
    await nc.close();
  }

  class Pair {
    constructor(nc, invite, attempt, guestKey, keys, host, onPacket, onClose) {
      this.nc = nc;
      this.invite = invite;
      this.attempt = attempt;
      this.guestKey = guestKey;
      this.keys = keys;
      this.host = host;
      this.onPacket = onPacket;
      this.onClose = onClose;
      this.outSeq = this.inSeq = this.queuedOut = this.queuedIn = 0;
      this.outbox = this.inbox = Promise.resolve();
      this.lastHeard = performance.now();
    }

    cipher(seq, host) {
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setUint32(8, seq);
      return {name: 'AES-GCM', iv, additionalData: pack(['tty-share-frame', version, this.invite.room, this.attempt, host, seq])};
    }

    send(type, bytes = new Uint8Array()) {
      if (this.closed && type !== kind.end) return this.outbox;
      if (bytes.length > maxFrame || this.queuedOut + bytes.length + 64 > maxQueue) {
        this.close('Terminal sharing traffic exceeded its buffer.', false);
        return this.outbox;
      }
      this.queuedOut += bytes.length + 64;
      this.outbox = this.outbox.then(async () => {
        if (this.closed && type !== kind.end) return;
        if (this.outSeq === 0xffffffff) throw new Error('Share sequence exhausted');
        const body = new Uint8Array(bytes.length + 1);
        body[0] = type;
        body.set(bytes, 1);
        const encrypted = await crypto.subtle.encrypt(this.cipher(this.outSeq, this.host), this.keys.outgoing, body);
        if (this.closed && type !== kind.end) return;
        const first = type === kind.join;
        const header = first ? encoder.encode(this.attempt + this.guestKey) : new Uint8Array();
        const frame = new Uint8Array(header.length + 4 + encrypted.byteLength);
        frame.set(header);
        new DataView(frame.buffer).setUint32(header.length, this.outSeq++);
        frame.set(new Uint8Array(encrypted), header.length + 4);
        const subject = first ? '.join' : (this.host ? '.down.' : '.up.') + this.attempt;
        this.nc.publish(route(this.invite.room) + subject, frame);
      }).catch(() => {
        this.close('The sharing relay disconnected.', false);
      }).finally(() => {
        this.queuedOut -= bytes.length + 64;
      });
      return this.outbox;
    }

    async decrypt(frame) {
      if (frame.length < 21 || frame.length > maxFrame + 21) return null;
      const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
      if (seq < this.inSeq) return null;
      let plaintext;
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt(
          this.cipher(seq, !this.host), this.keys.incoming, frame.subarray(4)));
      } catch (_) {
        return null;
      }
      if (seq !== this.inSeq) {
        this.close('A sharing message was lost.', false);
        return null;
      }
      this.inSeq++;
      this.lastHeard = performance.now();
      return plaintext;
    }

    listen() {
      const topic = route(this.invite.room) + (this.host ? '.up.' : '.down.') + this.attempt;
      this.subscription = this.nc.subscribe(topic, {callback: (error, message) => {
        if (error || this.closed) return;
        const frame = message.data;
        if (frame.length > maxFrame + 21) return;
        if (this.queuedIn + frame.length + 64 > maxQueue) {
          this.close('Terminal sharing traffic exceeded its buffer.', false);
          return;
        }
        this.queuedIn += frame.length + 64;
        this.inbox = this.inbox.then(async () => {
          if (this.closed) return;
          const body = await this.decrypt(frame);
          if (!body || this.closed) return;
          const type = body[0];
          if (type === kind.end) this.close('Terminal sharing ended.', false);
          else if (type !== kind.ping) this.onPacket(type, body.subarray(1));
        }).catch(() => {
          this.close('The peer sent an invalid sharing message.', false);
        }).finally(() => {
          this.queuedIn -= frame.length + 64;
        });
      }});
    }

    startHeartbeat() {
      if (this.closed || this.timer) return;
      this.lastHeard = performance.now();
      this.timer = setInterval(() => {
        if (performance.now() - this.lastHeard > heartbeat * 4) this.close('The sharing peer disconnected.', false);
        else this.send(kind.ping);
      }, heartbeat);
    }

    close(message, notify = true) {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.timer);
      this.subscription?.unsubscribe();
      if (notify) this.send(kind.end);
      this.onClose(message);
      this.outbox.then(() => quietClose(this.nc)).catch(() => {});
    }
  }

  async function createInvite({onRequest, onPacket, onClose}) {
    const keyPair = await generateKey();
    const invite = {room: randomId(), hostKey: await publicKey(keyPair)};
    const pin = newPIN();
    const nc = await openRelay();
    const url = new URL(location.pathname, location.origin);
    url.hash = 'ttyshare=' + version + '.' + invite.room + '.' + invite.hostKey;
    const seen = new Set();
    const expires = Date.now() + lifetime;
    let pending = false;
    let closed = false;
    let pair;
    let timer;
    let subscription;
    function close(message, notify = true) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      if (pair) pair.close(message, notify);
      else quietClose(nc);
      onClose(message);
    }

    async function handle(frame) {
      if (Date.now() >= expires) {
        close('The invite has expired.');
        return;
      }
      const header = decoder.decode(frame.subarray(0, 109));
      const match = roomPattern.exec(header.slice(0, 22) + '.' + header.slice(22));
      if (!match || decodeBytes(match[2])[0] !== 4 || seen.has(match[1])) return;
      const [, attempt, guestKey] = match;
      try {
        const keys = await deriveKeys(invite, attempt, guestKey, keyPair, true);
        const candidate = new Pair(nc, invite, attempt, guestKey, keys, true, onPacket, close);
        const body = await candidate.decrypt(frame.subarray(109));
        if (closed) return;
        if (body?.[0] !== kind.join) return;
        const {mode, proof, permissions} = unpack(body.subarray(1));
        if (!['request', 'give'].includes(mode) || typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return;
        if (mode === 'give' ? !hasPermissions(permissions) : permissions !== null) return;
        seen.add(attempt);
        const valid = await crypto.subtle.verify('HMAC', keys.proof, decodeBytes(proof),
          pinProofLink(invite.room, attempt, mode, permissions, pin));
        if (closed) return;
        if (!valid) {
          await candidate.send(kind.reject);
          return;
        }
        pair = candidate;
        subscription.unsubscribe();
        pair.listen();
        onRequest(mode, permissions, pair, () => {
          if (closed || Date.now() >= expires) {
            close('The invite has expired.');
            return false;
          }
          clearTimeout(timer);
          pair.send(kind.allow);
          pair.startHeartbeat();
          return true;
        });
      } finally {
        if (!closed && !pair && seen.size >= 3) close('Too many attempts. Create a new invite.');
      }
    }

    subscription = nc.subscribe(route(invite.room) + '.join', {callback: (error, message) => {
      if (error || closed || pending || message.data.length < 130 || message.data.length > 1024) return;
      pending = true;
      handle(message.data).catch(() => {}).finally(() => { pending = false; });
    }});
    nc.closed().then(() => close('The sharing relay disconnected.', false));
    try {
      await nc.flush();
      if (closed) throw new Error('Relay closed');
    } catch (error) {
      close('The sharing relay disconnected.', false);
      throw error;
    }
    timer = setTimeout(() => close('The invite has expired.'), Math.max(0, expires - Date.now()));
    return {pin, url: url.href, close, expires};
  }

  async function joinInvite(invite, pin, mode, permissions, {onReady, onPacket, onClose}) {
    const keyPair = await generateKey();
    const attempt = randomId();
    const guestKey = await publicKey(keyPair);
    const keys = await deriveKeys(invite, attempt, guestKey, keyPair, false);
    const proof = await crypto.subtle.sign('HMAC', keys.proof, pinProofLink(invite.room, attempt, mode, permissions, pin));
    const nc = await openRelay();
    let approved = false;
    const pair = new Pair(nc, invite, attempt, guestKey, keys, false, (type, bytes) => {
      if (!approved && type === kind.reject) {
        pair.close('The PIN was rejected. Check it and try again.', false);
      } else if (!approved && type === kind.allow) {
        approved = true;
        clearTimeout(timer);
        pair.startHeartbeat();
        onReady(pair);
      } else if (approved && type !== kind.allow && type !== kind.reject) {
        onPacket(type, bytes);
      }
    }, message => {
      clearTimeout(timer);
      onClose(message);
    });
    const timer = setTimeout(() => pair.close('Approval timed out. Ask for a new invite.'), lifetime);
    nc.closed().then(() => pair.close('The sharing relay disconnected.', false));
    try {
      pair.listen();
      await nc.flush();
      pair.send(kind.join, pack({mode, permissions, proof: encodeBytes(new Uint8Array(proof))}));
    } catch (_) {
      pair.close('The sharing relay disconnected.', false);
    }
    return pair;
  }

  window.TTYShare = {kind, pack, unpack, parseInvite, pinAlphabet, pinPattern, hasPermissions, createInvite, joinInvite};
})();
