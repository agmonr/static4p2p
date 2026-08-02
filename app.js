(() => {
  'use strict';

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const HISTORY_KEY = 'p2p_chat_history';
  const FILE_CHUNK_SIZE = 16 * 1024;
  const FILE_BUFFERED_HIGH = 1_000_000;
  const FILE_BUFFERED_LOW = 500_000;
  const TRACKER_URLS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.btorrent.xyz'];
  const TRACKER_TIMEOUT_MS = 20000;
  // Generous: needs to survive a real "switch to WhatsApp, send, switch
  // back" round trip on mobile, where a background tab's timers get
  // throttled and only really resume once the user returns anyway.
  const CONNECT_STUCK_TIMEOUT_MS = 45000;

  let pc = null;
  let channel = null;
  let myRole = null; // 'inviter' | 'invitee' | 'mirror-viewer'
  let hasShared = false; // becomes true once the user copies/sends their link
  let isMirrorViewer = false;
  let isReconnectAttempt = false; // true when pc came from tracker reconnect, not a fresh QR pairing
  let pendingTrackerOfferId = null;

  let mirrorPc = null;
  let mirrorChannel = null;

  let fileSending = false;
  let incomingFile = null; // { meta, chunks }

  // ---------- base64url + gzip helpers ----------

  function base64UrlEncode(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function encodePayload(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      return 'g' + base64UrlEncode(new Uint8Array(buf));
    }
    return 'r' + base64UrlEncode(bytes);
  }

  async function decodePayload(str) {
    const flag = str[0];
    const bytes = base64UrlDecode(str.slice(1));
    if (flag === 'g') {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function extractPayloadToken(text) {
    text = text.trim();
    const m = text.match(/(?:^|[#?&])p=([^&\s]+)/);
    if (m) return m[1];
    return text;
  }

  function buildLink(token) {
    return location.origin + location.pathname + '#p=' + token;
  }

  // ---------- link shortening (WhatsApp share only - cosmetic, best-effort) ----------
  //
  // The SDP payload link can run 700+ chars, which reads as a wall of
  // noise in a WhatsApp message. No shortener owned by this app - two
  // public, no-signup services (same "public infra, not app-owned"
  // tradeoff already made for the tracker reconnect feature) are tried in
  // turn; if both are unreachable (offline, blocked), callers fall back to
  // the full link, so pairing still works without them.

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => clearTimeout(t));
  }

  async function shortenLink(longUrl) {
    // tinyurl first: in testing, is.gd's free API frequently returned
    // "Error, database insert failed" (HTTP 200, so failures don't even
    // throw - checked explicitly below) for brand-new long URLs, while
    // tinyurl was consistently reliable.
    try {
      const res = await fetchWithTimeout('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl), {}, 4000);
      const text = (await res.text()).trim();
      if (/^https:\/\//.test(text)) return text;
    } catch (err) { /* try next service */ }
    try {
      const res = await fetchWithTimeout('https://is.gd/create.php?format=json&url=' + encodeURIComponent(longUrl), {}, 4000);
      const data = await res.json();
      if (data && data.shorturl) return data.shorturl;
    } catch (err) { /* fall back to the full link */ }
    return null;
  }

  // ---------- binary/hash helpers (used by tracker reconnect) ----------

  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  // BitTorrent tracker wire protocol encodes 20-byte fields (info_hash,
  // peer_id, offer_id) as JSON strings where each character's code point
  // is one raw byte (0-255) - not base64, not UTF-8 text. This round-trips
  // correctly through JSON.stringify/parse because those byte values are
  // valid (if unprintable) UTF-16 code units.
  function bytesToBinaryStr(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  async function sha1Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return new Uint8Array(digest);
  }

  // ---------- screen management ----------

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
  }

  function showError(msg) {
    document.getElementById('error-message').textContent = msg;
    showScreen('error');
  }

  // Non-blocking replacement for alert() - alert() halts all page JS until
  // dismissed, which is a bad UX for a chat app in general and can wedge
  // the page entirely if nothing is present to dismiss it.
  let toastTimer = null;
  function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.getElementById('app').appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  // ---------- QR rendering ----------

  function renderQR(container, text) {
    container.innerHTML = '';
    try {
      new QRCode(container, {
        text,
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.L,
      });
    } catch (err) {
      container.textContent = 'לא ניתן להציג ברקוד (הקישור ארוך מדי)';
    }
  }

  function showInviteScreen(title, subtitle, link) {
    document.getElementById('invite-title').textContent = title;
    document.getElementById('invite-subtitle').textContent = subtitle;
    document.getElementById('invite-link').value = link;
    document.getElementById('btn-scan-instead').hidden = myRole !== 'inviter';
    renderQR(document.getElementById('qr-container'), link);
    showScreen('invite');

    const tagInput = document.getElementById('invite-tag');
    currentHistoryId = addLinkHistoryEntry(myRole, link, tagInput.value.trim());
  }

  // ---------- link history (localStorage - persists across app restarts) ----------
  //
  // A saved link cannot actually be reused to reconnect: each
  // RTCPeerConnection mints its own DTLS certificate and ICE
  // ufrag/password, and those die with the page. This is a log for
  // reference/tagging only, never presented as "tap to reconnect".

  const LINK_HISTORY_KEY = 'p2p_link_history';
  let currentHistoryId = null;

  function getLinkHistory() {
    try { return JSON.parse(localStorage.getItem(LINK_HISTORY_KEY) || '[]'); } catch (err) { return []; }
  }

  function setLinkHistory(list) {
    localStorage.setItem(LINK_HISTORY_KEY, JSON.stringify(list));
  }

  function addLinkHistoryEntry(role, link, tag) {
    const history = getLinkHistory();
    const id = 'h' + Date.now() + Math.random().toString(36).slice(2, 6);
    history.unshift({ id, role, link, tag: tag || '', createdAt: Date.now() });
    if (history.length > 50) history.length = 50;
    setLinkHistory(history);
    return id;
  }

  function updateLinkHistoryTag(id, tag) {
    const history = getLinkHistory();
    const entry = history.find((h) => h.id === id);
    if (entry) { entry.tag = tag; setLinkHistory(history); }
  }

  function deleteLinkHistoryEntry(id) {
    setLinkHistory(getLinkHistory().filter((h) => h.id !== id));
    renderHistoryList();
  }

  function getLastTag() {
    const history = getLinkHistory();
    return history.length ? history[0].tag : '';
  }

  function roleLabel(role) {
    if (role === 'inviter') return 'הזמנה שלי';
    if (role === 'invitee') return 'אישור שלי';
    if (role === 'mirror-viewer') return 'אישור שיקוף';
    return role;
  }

  function renderHistoryList() {
    const container = document.getElementById('history-list');
    const history = getLinkHistory();
    container.innerHTML = '';
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'אין עדיין קישורים שמורים.';
      container.appendChild(empty);
      return;
    }
    history.forEach((entry) => {
      const el = document.createElement('div');
      el.className = 'history-entry';

      const top = document.createElement('div');
      top.className = 'history-entry-top';
      const tagInput = document.createElement('input');
      tagInput.className = 'history-tag-input';
      tagInput.placeholder = 'תיוג';
      tagInput.value = entry.tag;
      tagInput.addEventListener('change', () => updateLinkHistoryTag(entry.id, tagInput.value.trim()));
      const role = document.createElement('span');
      role.className = 'history-role';
      role.textContent = roleLabel(entry.role);
      top.appendChild(tagInput);
      top.appendChild(role);

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const date = document.createElement('span');
      date.textContent = new Date(entry.createdAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = '📋';
      copyBtn.setAttribute('aria-label', 'העתק קישור');
      copyBtn.addEventListener('click', () => copyToClipboard(entry.link).then(() => showToast('הועתק')));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.setAttribute('aria-label', 'מחק');
      delBtn.addEventListener('click', () => deleteLinkHistoryEntry(entry.id));
      actions.appendChild(copyBtn);
      actions.appendChild(delBtn);
      meta.appendChild(date);
      meta.appendChild(actions);

      el.appendChild(top);
      el.appendChild(meta);
      container.appendChild(el);
    });
  }

  document.getElementById('btn-open-history').addEventListener('click', () => {
    renderHistoryList();
    document.getElementById('history-modal').hidden = false;
  });
  document.getElementById('btn-close-history').addEventListener('click', () => {
    document.getElementById('history-modal').hidden = true;
  });
  document.getElementById('invite-tag').addEventListener('change', (e) => {
    if (currentHistoryId) updateLinkHistoryTag(currentHistoryId, e.target.value.trim());
  });

  // ---------- contacts (persistent shared secret, enables tracker reconnect) ----------
  //
  // Established the first time a QR/link pairing actually connects: the
  // inviter generates a random secret and sends it once over the freshly
  // opened DataChannel; both sides then save it locally under whatever tag
  // they typed on their own invite screen. Never derived from anything
  // public (like a public key) - reconnectViaTracker() below turns this
  // into an infohash, and a secret is what keeps that infohash unguessable
  // by anyone else watching the public tracker.

  const CONTACTS_KEY = 'p2p_contacts';

  function getContacts() {
    try { return JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]'); } catch (err) { return []; }
  }

  function setContacts(list) {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(list));
  }

  function saveContact(tag, secretHex) {
    const contacts = getContacts();
    const existing = contacts.find((c) => c.secret === secretHex);
    if (existing) {
      existing.lastConnectedAt = Date.now();
      if (tag) existing.tag = tag;
      setContacts(contacts);
      return existing.id;
    }
    const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    contacts.unshift({ id, tag: tag || 'ללא שם', secret: secretHex, createdAt: Date.now(), lastConnectedAt: Date.now() });
    setContacts(contacts);
    return id;
  }

  function deleteContact(id) {
    setContacts(getContacts().filter((c) => c.id !== id));
    renderContactsList();
  }

  function renderContactsList() {
    const container = document.getElementById('contacts-list');
    const contacts = getContacts();
    container.innerHTML = '';
    if (!contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'אין עדיין אנשי קשר שמורים. אנשי קשר נשמרים אוטומטית אחרי חיבור מוצלח.';
      container.appendChild(empty);
      return;
    }
    contacts.forEach((contact) => {
      const el = document.createElement('div');
      el.className = 'history-entry';

      const top = document.createElement('div');
      top.className = 'history-entry-top';
      const name = document.createElement('span');
      name.className = 'contact-name';
      name.textContent = contact.tag;
      const reconnectBtn = document.createElement('button');
      reconnectBtn.type = 'button';
      reconnectBtn.className = 'btn btn-primary btn-sm';
      reconnectBtn.textContent = '🔄 התחבר';
      reconnectBtn.addEventListener('click', () => reconnectViaTracker(contact));
      top.appendChild(name);
      top.appendChild(reconnectBtn);

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const date = document.createElement('span');
      date.textContent = 'חיבור אחרון: ' + new Date(contact.lastConnectedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '🗑';
      delBtn.setAttribute('aria-label', 'מחק איש קשר');
      delBtn.addEventListener('click', () => deleteContact(contact.id));
      meta.appendChild(date);
      meta.appendChild(delBtn);

      el.appendChild(top);
      el.appendChild(meta);
      container.appendChild(el);
    });
  }

  document.getElementById('btn-open-contacts').addEventListener('click', () => {
    renderContactsList();
    document.getElementById('contacts-modal').hidden = false;
  });
  document.getElementById('btn-close-contacts').addEventListener('click', () => {
    document.getElementById('contacts-modal').hidden = true;
  });

  // ---------- tracker-based reconnect ----------
  //
  // Manual, single-attempt (not an always-on background listener): opens
  // one tracker connection for this specific contact's infohash, announces
  // an offer, waits up to TRACKER_TIMEOUT_MS for the other side to also be
  // announcing (they need the app open too), then hands off to the same
  // connection machinery a fresh QR pairing uses.

  function connectTrackerWs(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { ws.close(); reject(new Error('tracker connect timeout')); }, 6000);
      ws.onopen = () => { clearTimeout(t); resolve(ws); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('tracker connect error')); };
    });
  }

  async function startTrackerOffer(ws, infoHashBin, myPeerIdBin) {
    hasShared = true;
    myRole = 'inviter';
    isReconnectAttempt = true;
    pc = createPeerConnection();
    setupDataChannel(pc.createDataChannel('chat'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const offerIdBin = bytesToBinaryStr(randomBytes(20));
    pendingTrackerOfferId = offerIdBin;
    ws.send(JSON.stringify({
      action: 'announce',
      info_hash: infoHashBin,
      peer_id: myPeerIdBin,
      numwant: 1,
      uploaded: 0,
      downloaded: 0,
      left: 0,
      event: 'started',
      offers: [{ offer_id: offerIdBin, offer: { type: 'offer', sdp: pc.localDescription.sdp } }],
    }));
  }

  async function respondToTrackerOffer(ws, infoHashBin, myPeerIdBin, msg) {
    // Glare case: we may have an in-flight offering attempt of our own
    // (startTrackerOffer) that lost the tie-break. Close it explicitly
    // instead of just dropping the reference, or it keeps gathering/
    // connecting in the background and can interfere with this one.
    if (pc) { try { pc.close(); } catch (err) { /* already closed */ } }
    hasShared = true;
    myRole = 'invitee';
    isReconnectAttempt = true;
    pc = createPeerConnection();
    pc.ondatachannel = (e) => setupDataChannel(e.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    ws.send(JSON.stringify({
      action: 'announce',
      info_hash: infoHashBin,
      peer_id: myPeerIdBin,
      to_peer_id: msg.peer_id,
      answer: { type: 'answer', sdp: pc.localDescription.sdp },
      offer_id: msg.offer_id,
    }));
  }

  async function reconnectViaTracker(contact) {
    if (pc) { try { pc.close(); } catch (err) { /* already closed */ } pc = null; channel = null; }
    document.getElementById('contacts-modal').hidden = true;

    const secretBytes = hexToBytes(contact.secret);
    const infoHashBytes = await sha1Bytes(secretBytes);
    const infoHashBin = bytesToBinaryStr(infoHashBytes);
    const myPeerIdBin = bytesToBinaryStr(randomBytes(20));

    let ws = null;
    for (const url of TRACKER_URLS) {
      try { ws = await connectTrackerWs(url); break; } catch (err) { /* try next tracker */ }
    }
    if (!ws) { showToast('לא ניתן להתחבר לשרת התיאום'); return; }

    showToast('מחפשים את ' + contact.tag + '...');
    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      ws.close();
      showToast(contact.tag + ' לא נמצא/ה כרגע. ודאו שהאפליקציה פתוחה אצל שניכם ונסו שוב.');
    }, TRACKER_TIMEOUT_MS);

    ws.onmessage = async (event) => {
      if (resolved) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      if (msg.info_hash !== infoHashBin) return;

      if (msg.offer && msg.offer_id && !msg.answer) {
        // Both sides may announce an offer at once (glare) - deterministic
        // tie-break so only one side answers instead of two connections
        // forming.
        if (myPeerIdBin > msg.peer_id) {
          resolved = true;
          clearTimeout(timeoutId);
          await respondToTrackerOffer(ws, infoHashBin, myPeerIdBin, msg);
          setTimeout(() => ws.close(), 3000);
        }
      } else if (msg.answer && msg.offer_id === pendingTrackerOfferId) {
        resolved = true;
        clearTimeout(timeoutId);
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.answer.sdp });
        setTimeout(() => ws.close(), 3000);
      }
    };

    await startTrackerOffer(ws, infoHashBin, myPeerIdBin);
  }

  // ---------- beep ----------

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch (err) { /* audio unavailable */ }
  }

  // ---------- WebRTC ----------

  function waitForIceGatheringComplete(conn) {
    if (conn.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      function check() {
        if (conn.iceGatheringState === 'complete') {
          conn.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      }
      conn.addEventListener('icegatheringstatechange', check);
      setTimeout(() => {
        conn.removeEventListener('icegatheringstatechange', check);
        resolve();
      }, 6000);
    });
  }

  function createPeerConnection() {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    let disconnectTimer = null;
    // 'checking' can otherwise sit forever with no further state change and
    // no feedback: on mobile, backgrounding this tab to send the answer via
    // WhatsApp commonly stalls the handshake (throttled/suspended tab) well
    // short of ever reaching 'failed'. One watchdog, armed the first time
    // checking actually starts, guarantees *some* resolution - success
    // clears it, otherwise the user gets a clear retry prompt instead of a
    // silent spinner.
    let stuckTimer = null;
    conn.oniceconnectionstatechange = () => {
      const state = conn.iceConnectionState;
      if (state === 'checking') {
        if (hasShared) showScreen('connecting');
        if (!stuckTimer) {
          stuckTimer = setTimeout(() => {
            const s = conn.iceConnectionState;
            if (s !== 'connected' && s !== 'completed') {
              showError('החיבור נתקע - ייתכן שבעקבות מעבר בין אפליקציות בנייד. נסו לשלוח שוב את הקוד, או התחילו הזמנה חדשה.');
            }
          }, CONNECT_STUCK_TIMEOUT_MS);
        }
      }
      if (state === 'connected' || state === 'completed') {
        clearTimeout(stuckTimer);
        stuckTimer = null;
      }
      if (state === 'failed') {
        clearTimeout(disconnectTimer);
        clearTimeout(stuckTimer);
        stuckTimer = null;
        showError('החיבור נכשל. נסו ליצור הזמנה חדשה.');
      } else if (state === 'disconnected') {
        // Transient - WebRTC can and often does recover from this on its
        // own (brief network hiccup) without ever reaching 'failed'. Give
        // it a few seconds before treating it as a real disconnect.
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          if (conn.iceConnectionState === 'disconnected') {
            showError('החיבור נכשל. נסו ליצור הזמנה חדשה.');
          }
        }, 5000);
      } else {
        clearTimeout(disconnectTimer);
      }
    };
    return conn;
  }

  function setupDataChannel(ch) {
    channel = ch;
    channel.binaryType = 'arraybuffer';
    const onOpen = () => {
      showScreen('chat');
      document.getElementById('screen-chat').classList.add('active');
      renderHistory();
      if (!isReconnectAttempt && myRole === 'inviter') {
        const secretHex = bytesToHex(randomBytes(16));
        channel.send(JSON.stringify({ type: 'pairing-secret', secret: secretHex }));
        saveContact(document.getElementById('invite-tag').value.trim(), secretHex);
      }
    };
    // ch may already be 'open' by the time this runs (e.g. answerer side,
    // received via ondatachannel after the handshake already completed) -
    // in that case the 'open' event already fired and onopen would never
    // be called if we only relied on the event.
    if (ch.readyState === 'open') onOpen(); else ch.onopen = onOpen;
    ch.onmessage = (e) => handleChannelMessage(e, false);
  }

  function handleChannelMessage(e, isMirror) {
    if (typeof e.data !== 'string') {
      // binary file chunk
      if (incomingFile) incomingFile.chunks.push(e.data);
      return;
    }
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }

    if (msg.type === 'pairing-secret') {
      if (!isReconnectAttempt) {
        saveContact(document.getElementById('invite-tag').value.trim(), msg.secret);
      }
      return;
    }
    if (msg.type === 'file-meta') {
      incomingFile = { meta: msg, chunks: [] };
      return;
    }
    if (msg.type === 'file-end') {
      if (!incomingFile) return;
      const blob = new Blob(incomingFile.chunks, { type: incomingFile.meta.mime });
      const url = URL.createObjectURL(blob);
      addFileMessage(incomingFile.meta, url, false);
      saveMessage(null, false, incomingFile.meta.ts, { file: { name: incomingFile.meta.name, mime: incomingFile.meta.mime } });
      forwardToMirror({ text: '📎 ' + incomingFile.meta.name, ts: incomingFile.meta.ts, outgoing: false });
      playBeep();
      incomingFile = null;
      return;
    }
    if (msg.type === 'mirror-history') {
      msg.items.forEach((m) => addMessage(m.text, m.outgoing, m.ts));
      return;
    }
    if (msg.type === 'mirror-relay') {
      addMessage(msg.item.text, msg.item.outgoing, msg.item.ts);
      playBeep();
      return;
    }
    // plain chat text message
    addMessage(msg.text, false, msg.ts);
    saveMessage(msg.text, false, msg.ts);
    forwardToMirror({ text: msg.text, ts: msg.ts, outgoing: false });
    playBeep();
  }

  async function startAsInviter() {
    myRole = 'inviter';
    hasShared = false;
    isReconnectAttempt = false;
    document.getElementById('invite-tag').value = getLastTag();
    pc = createPeerConnection();
    setupDataChannel(pc.createDataChannel('chat'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const token = await encodePayload({ t: 'o', s: pc.localDescription.sdp });
    showInviteScreen('הזמנה', 'שלח אותי לחבר', buildLink(token));
  }

  async function startAsInvitee(offerSdp) {
    myRole = 'invitee';
    hasShared = false;
    isReconnectAttempt = false;
    pc = createPeerConnection();
    pc.ondatachannel = (e) => setupDataChannel(e.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    // Bare token, not a full link: the recipient here is always the
    // inviter, who is already sitting on this same page waiting for the
    // answer - no need to re-send the origin+pathname they're already on.
    const token = await encodePayload({ t: 'a', s: pc.localDescription.sdp });
    showInviteScreen('אישור הזמנה', 'שלח בחזרה לחבר', token);
  }

  async function startAsMirrorViewer(offerSdp) {
    myRole = 'mirror-viewer';
    isMirrorViewer = true;
    hasShared = false;
    pc = createPeerConnection();
    pc.ondatachannel = (e) => setupMirrorViewerChannel(e.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    // Same reasoning as the invitee answer above - bare token, no link.
    const token = await encodePayload({ t: 'a', s: pc.localDescription.sdp, m: true });
    showInviteScreen('אישור שיקוף', 'שלח בחזרה למכשיר המקורי', token);
  }

  function setupMirrorViewerChannel(ch) {
    channel = ch;
    channel.binaryType = 'arraybuffer';
    const onOpen = () => {
      showScreen('chat');
      document.getElementById('screen-chat').classList.add('active');
      document.getElementById('chat-form').hidden = true;
      document.getElementById('chat-toolbar').hidden = true;
      document.getElementById('mirror-viewer-banner').hidden = false;
    };
    if (ch.readyState === 'open') onOpen(); else ch.onopen = onOpen;
    ch.onmessage = (e) => handleChannelMessage(e, true);
  }

  async function applyAnswer(rawText) {
    if (!pc) { showError('אין הזמנה פעילה. התחילו מחדש.'); return; }
    if (pc.signalingState !== 'have-local-offer') { showToast('כבר מחוברים'); return; }
    try {
      const token = extractPayloadToken(rawText);
      const obj = await decodePayload(token);
      if (obj.t !== 'a') throw new Error('not-an-answer');
      await pc.setRemoteDescription({ type: 'answer', sdp: obj.s });
    } catch (err) {
      showToast('הקישור לא תקין או שפג תוקפו');
    }
  }

  async function route(rawText) {
    const token = extractPayloadToken(rawText);
    if (!token) { startAsInviter(); return; }
    try {
      const obj = await decodePayload(token);
      if (obj.t === 'o' && obj.m) {
        await startAsMirrorViewer(obj.s);
      } else if (obj.t === 'o') {
        await startAsInvitee(obj.s);
      } else if (obj.t === 'a') {
        await applyAnswer(rawText);
      } else {
        throw new Error('unknown payload type');
      }
    } catch (err) {
      showError('הקישור לא תקין או שפג תוקפו');
    }
  }

  // ---------- chat ----------

  function addMessage(text, outgoing, ts) {
    const el = document.createElement('div');
    el.className = 'bubble ' + (outgoing ? 'out' : 'in');
    el.appendChild(document.createTextNode(text));
    el.appendChild(makeTimeSpan(ts));
    appendBubble(el);
  }

  function addFileMessage(meta, url, outgoing) {
    const el = document.createElement('div');
    el.className = 'bubble ' + (outgoing ? 'out' : 'in');
    if (meta.mime && meta.mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'bubble-image';
      img.alt = meta.name;
      el.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = meta.name;
      link.className = 'bubble-file-link';
      link.textContent = '📎 ' + meta.name + ' (' + formatSize(meta.size) + ')';
      el.appendChild(link);
    }
    el.appendChild(makeTimeSpan(meta.ts));
    appendBubble(el);
  }

  function makeTimeSpan(ts) {
    const time = document.createElement('span');
    time.className = 'bubble-time';
    time.textContent = new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    return time;
  }

  function appendBubble(el) {
    const messages = document.getElementById('messages');
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function saveMessage(text, outgoing, ts) {
    if (text == null) return; // file messages aren't persisted (blob data isn't practical to store)
    const history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
    history.push({ text, outgoing, ts });
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  function renderHistory() {
    const history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
    document.getElementById('messages').innerHTML = '';
    history.forEach((m) => addMessage(m.text, m.outgoing, m.ts));
  }

  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !channel || channel.readyState !== 'open') return;
    const ts = Date.now();
    channel.send(JSON.stringify({ text, ts }));
    addMessage(text, true, ts);
    saveMessage(text, true, ts);
    forwardToMirror({ text, ts, outgoing: true });
    input.value = '';
  });

  // ---------- file / photo attachments ----------

  async function sendFile(file) {
    if (!channel || channel.readyState !== 'open' || fileSending) return;
    fileSending = true;
    document.getElementById('btn-attach').disabled = true;
    document.getElementById('btn-camera').disabled = true;
    try {
      const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 8);
      const meta = { type: 'file-meta', id, name: file.name || 'photo.jpg', mime: file.type || 'application/octet-stream', size: file.size, ts: Date.now() };
      channel.send(JSON.stringify(meta));

      const buf = await file.arrayBuffer();
      for (let offset = 0; offset < buf.byteLength; offset += FILE_CHUNK_SIZE) {
        if (channel.bufferedAmount > FILE_BUFFERED_HIGH) {
          await new Promise((resolve) => {
            channel.bufferedAmountLowThreshold = FILE_BUFFERED_LOW;
            channel.onbufferedamountlow = () => { channel.onbufferedamountlow = null; resolve(); };
          });
        }
        channel.send(buf.slice(offset, offset + FILE_CHUNK_SIZE));
      }
      channel.send(JSON.stringify({ type: 'file-end', id }));

      addFileMessage(meta, URL.createObjectURL(file), true);
      saveMessage(null, true, meta.ts);
      forwardToMirror({ text: '📎 ' + meta.name, ts: meta.ts, outgoing: true });
    } finally {
      fileSending = false;
      document.getElementById('btn-attach').disabled = false;
      document.getElementById('btn-camera').disabled = false;
    }
  }

  document.getElementById('btn-attach').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('btn-camera').addEventListener('click', () => {
    document.getElementById('camera-input').click();
  });
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) sendFile(file);
  });
  document.getElementById('camera-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) sendFile(file);
  });

  // ---------- sharing (main invite) ----------

  function afterShare() {
    hasShared = true;
    document.getElementById('receive-answer-box').hidden = myRole !== 'inviter';
    showScreen('waiting');
  }

  // navigator.clipboard.writeText() can hang indefinitely (not just reject)
  // when the clipboard permission is stuck in "prompt" state with nothing
  // able to answer it - race it against a timeout so the UI never blocks.
  function copyToClipboard(text) {
    const viaClipboardApi = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('clipboard API unavailable'));
    return Promise.race([
      viaClipboardApi,
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1500)),
    ]).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* best effort only */ }
      document.body.removeChild(ta);
    });
  }

  document.getElementById('btn-copy').addEventListener('click', async () => {
    await copyToClipboard(document.getElementById('invite-link').value);
    afterShare();
  });

  document.getElementById('btn-whatsapp').addEventListener('click', async () => {
    const link = document.getElementById('invite-link').value;
    // Open the tab synchronously (still inside the click gesture) and
    // redirect it once we have a link - opening after the await risks the
    // browser treating it as an unrequested popup and blocking it.
    const win = window.open('', '_blank');
    // Answers are a bare token (see startAsInvitee/startAsMirrorViewer),
    // not a URL - shortener services reject those, and there's no origin
    // prefix to trim off anyway, so skip straight to sending it as-is.
    const shortLink = link.startsWith('http') ? ((await shortenLink(link)) || link) : link;
    if (win) win.location.href = 'https://wa.me/?text=' + encodeURIComponent(shortLink);
    afterShare();
  });

  document.getElementById('btn-apply-answer').addEventListener('click', () => {
    const text = document.getElementById('answer-input').value;
    if (text.trim()) applyAnswer(text);
  });

  document.getElementById('btn-restart').addEventListener('click', () => {
    location.hash = '';
    location.reload();
  });

  // ---------- mirror (relay conversation to another device, read-only) ----------

  function forwardToMirror(item) {
    if (mirrorChannel && mirrorChannel.readyState === 'open') {
      mirrorChannel.send(JSON.stringify({ type: 'mirror-relay', item }));
    }
  }

  async function startMirrorInvite() {
    if (mirrorChannel && mirrorChannel.readyState === 'open') {
      showToast('כבר משוקף למכשיר נוסף');
      return;
    }
    if (mirrorPc && mirrorPc.signalingState === 'have-local-offer') {
      // already mid-pairing - reopen the modal with the existing QR/link
      // instead of abandoning it for a fresh RTCPeerConnection.
      document.getElementById('mirror-modal').hidden = false;
      return;
    }
    mirrorPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    mirrorPc.oniceconnectionstatechange = () => {
      if (mirrorPc.iceConnectionState === 'failed') {
        showToast('החיבור לשיקוף נכשל. נסו שוב.');
      }
    };
    mirrorChannel = mirrorPc.createDataChannel('mirror');
    mirrorChannel.binaryType = 'arraybuffer';
    mirrorChannel.onopen = () => {
      document.getElementById('mirror-modal').hidden = true;
      document.getElementById('mirror-status').hidden = false;
      const history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
      mirrorChannel.send(JSON.stringify({ type: 'mirror-history', items: history }));
    };

    const offer = await mirrorPc.createOffer();
    await mirrorPc.setLocalDescription(offer);
    await waitForIceGatheringComplete(mirrorPc);

    const token = await encodePayload({ t: 'o', s: mirrorPc.localDescription.sdp, m: true });
    const link = buildLink(token);
    document.getElementById('mirror-link').value = link;
    renderQR(document.getElementById('mirror-qr-container'), link);
    document.getElementById('mirror-modal').hidden = false;
  }

  async function applyMirrorAnswer(rawText) {
    if (!mirrorPc) return;
    if (mirrorPc.signalingState !== 'have-local-offer') { showToast('כבר מחוברים'); return; }
    try {
      const token = extractPayloadToken(rawText);
      const obj = await decodePayload(token);
      if (obj.t !== 'a') throw new Error('not-an-answer');
      await mirrorPc.setRemoteDescription({ type: 'answer', sdp: obj.s });
    } catch (err) {
      showToast('הקישור לא תקין או שפג תוקפו');
    }
  }

  document.getElementById('btn-mirror').addEventListener('click', () => startMirrorInvite());
  document.getElementById('btn-mirror-compose').addEventListener('click', () => startMirrorInvite());
  document.getElementById('btn-close-mirror').addEventListener('click', () => {
    document.getElementById('mirror-modal').hidden = true;
  });
  document.getElementById('btn-mirror-copy').addEventListener('click', () => {
    copyToClipboard(document.getElementById('mirror-link').value);
  });
  document.getElementById('btn-mirror-whatsapp').addEventListener('click', async () => {
    const link = document.getElementById('mirror-link').value;
    const win = window.open('', '_blank');
    const shortLink = (await shortenLink(link)) || link;
    if (win) win.location.href = 'https://wa.me/?text=' + encodeURIComponent(shortLink);
  });
  document.getElementById('btn-mirror-apply-answer').addEventListener('click', () => {
    const text = document.getElementById('mirror-answer-input').value;
    if (text.trim()) applyMirrorAnswer(text);
  });

  // ---------- camera QR scanning ----------

  let scanStream = null;
  let scanRAF = null;

  async function startScan(onResult) {
    const modal = document.getElementById('scan-modal');
    const video = document.getElementById('scan-video');
    const canvas = document.getElementById('scan-canvas');

    // Some in-app browsers (WhatsApp/Instagram/Facebook link previews, in
    // particular) run pages in a restricted webview that doesn't expose
    // getUserMedia at all - fails silently as a generic camera error
    // otherwise, which is indistinguishable from a denied permission.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('הדפדפן הזה לא תומך בגישה למצלמה - פתחו את הקישור בספארי/כרום ולא בתוך אפליקציה אחרת');
      return;
    }

    modal.hidden = false;
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (err) {
      console.error('getUserMedia failed:', err.name, err.message);
      const messages = {
        NotAllowedError: 'אין הרשאה למצלמה - אשרו גישה בהגדרות הדפדפן ונסו שוב',
        PermissionDeniedError: 'אין הרשאה למצלמה - אשרו גישה בהגדרות הדפדפן ונסו שוב',
        NotFoundError: 'לא נמצאה מצלמה במכשיר',
        NotReadableError: 'המצלמה תפוסה על ידי אפליקציה אחרת',
        OverconstrainedError: 'לא נמצאה מצלמה מתאימה במכשיר',
      };
      showToast(messages[err.name] || ('לא ניתן לגשת למצלמה (' + err.name + ')'));
      modal.hidden = true;
      return;
    }
    video.srcObject = scanStream;
    await video.play();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function tick() {
      if (!scanStream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          stopScan();
          onResult(code.data);
          return;
        }
      }
      scanRAF = requestAnimationFrame(tick);
    }
    scanRAF = requestAnimationFrame(tick);
  }

  function stopScan() {
    if (scanRAF) cancelAnimationFrame(scanRAF);
    scanRAF = null;
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    document.getElementById('scan-modal').hidden = true;
  }

  document.getElementById('btn-cancel-scan').addEventListener('click', stopScan);

  document.getElementById('btn-scan-instead').addEventListener('click', () => {
    startScan((data) => {
      if (pc) { pc.close(); pc = null; channel = null; }
      route(data);
    });
  });

  document.getElementById('btn-scan-answer').addEventListener('click', () => {
    startScan((data) => applyAnswer(data));
  });

  document.getElementById('btn-mirror-scan-answer').addEventListener('click', () => {
    startScan((data) => applyMirrorAnswer(data));
  });

  // ---------- paste-image QR decode (clipboard screenshot of a barcode) ----------
  //
  // Same jsQR decoder the camera scanner feeds live video frames into,
  // fed a pasted image instead - covers the case of a QR forwarded as a
  // screenshot (e.g. received in WhatsApp Desktop) with no camera handy.

  async function decodeQrFromImageFile(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      return code ? code.data : null;
    } catch (err) {
      return null;
    }
  }

  document.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageItem = Array.from(items).find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imageItem) return; // ordinary text paste - leave it to the browser's default handling

    e.preventDefault();
    const data = await decodeQrFromImageFile(imageItem.getAsFile());
    if (!data) { showToast('לא זוהה ברקוד בתמונה שהודבקה'); return; }

    // Route the decoded text exactly like the matching camera-scan button
    // would, based on which "receive" surface is currently on screen.
    if (!document.getElementById('mirror-modal').hidden) {
      applyMirrorAnswer(data);
    } else if (document.getElementById('screen-waiting').classList.contains('active')
        && !document.getElementById('receive-answer-box').hidden) {
      applyAnswer(data);
    } else if (document.getElementById('screen-invite').classList.contains('active')) {
      if (pc) { pc.close(); pc = null; channel = null; }
      route(data);
    } else {
      showToast('הודבק ברקוד אך אין כרגע מסך שמצפה לו');
    }
  });

  // ---------- init ----------

  window.addEventListener('DOMContentLoaded', () => {
    const hash = location.hash.slice(1);
    if (hash) route(hash); else startAsInviter();
  });
})();
