(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var DEFAULT_LABEL = { owner: 'Owner', jl: 'im just like that' };
  var DEFAULT_COLOR = { owner: '#3ba0ff', jl: '#ed4245' };
  var TOPIC = { general: 'Everyone can post here', links: 'Big words and links. Only owners can post here.' };

  var me = null, users = [], messages = [], dmList = [], dmMsgs = {}, es = null;
  var view = { kind: 'ch', id: 'general' };
  var unread = {};
  var inviteRequired = false, backupsOn = false, mode = 'guest';
  var armed = null, armTimer = null, sending = false, toastTimer = null, importArmed = false;

  // ---------- helpers ----------
  function api(method, url, body, headers) {
    var opts = { method: method, headers: Object.assign({}, headers || {}), credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function toast(t) {
    var el = $('toast'); el.textContent = t; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3500);
  }
  function showMsg(id, text) { var el = $(id); el.textContent = text || ''; el.hidden = !text; }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function avatar(el, uid, name) { el.style.background = 'hsl(' + hue(uid) + ' 45% 40%)'; el.textContent = (name || '?').charAt(0).toUpperCase(); }
  function labelOf(u) { return (u && (u.roleLabel || DEFAULT_LABEL[u.role])) || ''; }
  function colorOf(u) { return (u && (u.nameColor || DEFAULT_COLOR[u.role])) || ''; }
  function colored(el, u) { var c = colorOf(u); if (c) el.style.color = c; return el; }
  function userById(id) {
    for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i];
    for (var j = 0; j < dmList.length; j++) { if (dmList[j].a.id === id) return dmList[j].a; if (dmList[j].b.id === id) return dmList[j].b; }
    return { id: id, name: 'Former member', role: null };
  }
  function otherOf(entry) { return entry.a.id === me.id ? entry.b : entry.a; }
  function convFor(a, b) { return [a, b].sort().join('~'); }
  function key() { return view.kind === 'ch' ? 'ch:' + view.id : 'dm:' + view.id; }
  function entryFor(conv) { for (var i = 0; i < dmList.length; i++) if (dmList[i].conv === conv) return dmList[i]; return null; }
  function overlays() { return ['codeModal', 'dmModal', 'setModal']; }
  function closeOverlays() { overlays().forEach(function (id) { $(id).hidden = true; }); importArmed = false; $('sImport').textContent = 'Restore from file'; }

  // ---------- join ----------
  function remembered() { try { return localStorage.getItem('un') || ''; } catch (e) { return ''; } }
  function remember(n) { try { localStorage.setItem('un', n); } catch (e) {} }
  var INTRO = {
    guest: 'Pick a name to start. No password needed, and names can repeat.',
    'in': 'Sign in with your username and password to get your name, role and messages back on any device.',
    up: 'Make an account with a username and a password (any length, even one letter).'
  };
  function setMode(m) {
    mode = m;
    $('mGuest').setAttribute('aria-selected', m === 'guest');
    $('mIn').setAttribute('aria-selected', m === 'in');
    $('mUp').setAttribute('aria-selected', m === 'up');
    $('fName').hidden = m !== 'guest';
    $('fUser').hidden = m === 'guest';
    $('fPass').hidden = m === 'guest';
    $('inviteWrap').hidden = !(inviteRequired && m !== 'in');
    $('aName').required = m === 'guest';
    $('aUser').required = $('aPass').required = m !== 'guest';
    $('aPass').autocomplete = m === 'up' ? 'new-password' : 'current-password';
    $('authGo').textContent = m === 'guest' ? 'Join' : m === 'in' ? 'Sign in' : 'Create account';
    $('authIntro').textContent = INTRO[m];
    $('authErr').hidden = true;
  }
  function showAuth() {
    stopPolling();
    closeOverlays();
    $('app').hidden = true; $('auth').hidden = false;
    setMode(mode);
    if (!$('aName').value) $('aName').value = remembered();
    (mode === 'guest' ? $('aName') : $('aUser')).focus();
  }
  $('mGuest').addEventListener('click', function () { setMode('guest'); });
  $('mIn').addEventListener('click', function () { setMode('in'); });
  $('mUp').addEventListener('click', function () { setMode('up'); });
  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('authGo').disabled = true; $('authErr').hidden = true;
    var req = mode === 'guest' ? api('POST', '/api/join', { name: $('aName').value, invite: $('aInvite').value })
      : mode === 'in' ? api('POST', '/api/login', { username: $('aUser').value, password: $('aPass').value })
      : api('POST', '/api/register', { username: $('aUser').value, password: $('aPass').value, invite: $('aInvite').value });
    req.then(function (j) {
      remember(j.user.name); $('aPass').value = ''; enter(j.user);
    }).catch(function (err) {
      showMsg('authErr', err.message);
    }).then(function () { $('authGo').disabled = false; });
  });

  // ---------- app ----------
  function enter(user) {
    me = user;
    $('auth').hidden = true; $('app').hidden = false;
    view = { kind: 'ch', id: 'general' }; unread = {}; dmMsgs = {}; dmList = []; messages = [];
    renderMe(); renderNav(); updateView(); renderThread(true);
    loadMessages(); loadUsers(); loadDms();
    connect();
    $('input').focus();
  }
  function renderMe() {
    avatar($('meAv'), me.id, me.name);
    var n = $('meName'); n.textContent = me.name; n.style.color = colorOf(me) || '';
    $('meRole').textContent = labelOf(me) || 'Member';
  }
  function setStatus(t, bad, live) {
    $('status').textContent = t; $('status').className = 'sub' + (bad ? ' bad' : '');
    $('dot').className = 'dot' + (live ? ' live' : '');
  }
  function nearBottom() { var s = $('scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 140; }
  function toBottom() { var s = $('scroller'); s.scrollTop = s.scrollHeight; }
  function lost(err) { if (err && err.status === 401) { me = null; showAuth(); } }

  function loadMessages() {
    return api('GET', '/api/messages').then(function (j) { messages = j.messages; renderThread(); }).catch(lost);
  }
  function loadUsers() { return api('GET', '/api/users').then(function (j) { users = j.users; }).catch(lost); }
  function loadDms() {
    return api('GET', '/api/dms').then(function (j) {
      var local = dmList.filter(function (c) { return !c.last && !j.dms.some(function (d) { return d.conv === c.conv; }); });
      dmList = local.concat(j.dms); renderNav();
    }).catch(lost);
  }
  function loadConv(conv) {
    return api('GET', '/api/dms/' + conv).then(function (j) { dmMsgs[conv] = j.messages; if (view.kind === 'dm' && view.id === conv) renderThread(true); }).catch(function (err) { lost(err); toast(err.message); });
  }
  function refreshMe() {
    return api('GET', '/api/me').then(function (j) {
      if (!j.user) { me = null; showAuth(); return; }
      me = j.user; backupsOn = !!j.backups; renderMe(); updateView(); renderNav();
    }).catch(function () {});
  }

  // ---------- live updates ----------
  var esFails = 0, esTimer = null, pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    setStatus('Connected', false, true);
    pollTimer = setInterval(function () {
      loadMessages(); loadUsers(); loadDms();
      if (view.kind === 'dm') loadConv(view.id);
      api('GET', '/api/me').then(function (j) { if (!j.user) { me = null; showAuth(); } }).catch(function () {});
    }, 5000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function connect() {
    stopPolling(); esFails = 0; clearTimeout(esTimer);
    if (es) { es.close(); es = null; }
    if (typeof EventSource === 'undefined') { startPolling(); return; }
    es = new EventSource('/api/stream');
    esTimer = setTimeout(function () {
      if (es && es.readyState !== 1) { try { es.close(); } catch (e) {} es = null; startPolling(); }
    }, 8000);
    es.onopen = function () {
      clearTimeout(esTimer); esFails = 0; stopPolling();
      setStatus('Live', false, true); loadMessages(); loadDms(); if (view.kind === 'dm') loadConv(view.id);
    };
    es.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 'message') {
        if (!messages.some(function (m) { return m.id === d.message.id; })) {
          messages.push(d.message);
          var c = d.message.ch || 'general';
          if (!(view.kind === 'ch' && view.id === c) && d.message.uid !== me.id) { unread['ch:' + c] = true; renderNav(); }
          if (view.kind === 'ch') renderThread();
        }
      } else if (d.type === 'delete') {
        messages = messages.filter(function (m) { return m.id !== d.id; }); if (view.kind === 'ch') renderThread();
      } else if (d.type === 'dm') {
        onDm(d.message);
      } else if (d.type === 'dmdelete') {
        if (dmMsgs[d.conv]) dmMsgs[d.conv] = dmMsgs[d.conv].filter(function (m) { return m.id !== d.id; });
        if (view.kind === 'dm' && view.id === d.conv) renderThread();
      } else if (d.type === 'refresh') {
        loadMessages(); refreshMe(); loadUsers(); loadDms(); if (view.kind === 'dm') loadConv(view.id);
      }
    };
    es.onerror = function () {
      if (pollTimer) return;
      esFails++;
      setStatus('Reconnecting…', true, false);
      if (esFails >= 3) { try { es.close(); } catch (e) {} es = null; startPolling(); return; }
      api('GET', '/api/me').then(function (j) { if (!j.user) { if (es) es.close(); me = null; showAuth(); } }).catch(function () {});
    };
  }
  function onDm(m) {
    var conv = m.conv;
    if (dmMsgs[conv] && !dmMsgs[conv].some(function (x) { return x.id === m.id; })) dmMsgs[conv].push(m);
    var entry = entryFor(conv);
    var mine = conv.split('~').indexOf(me.id) >= 0;
    if (!entry) { loadDms(); }
    else { entry.last = { ts: m.ts, uid: m.uid, text: m.text.slice(0, 80) }; }
    if (view.kind === 'dm' && view.id === conv) { renderThread(); }
    else if (mine && m.uid !== me.id) { unread['dm:' + conv] = true; }
    renderNav();
  }

  // ---------- navigation ----------
  function navLabel(text, plusFn) {
    var d = document.createElement('div'); d.className = 'label';
    var s = document.createElement('span'); s.textContent = text; d.appendChild(s);
    if (plusFn) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = '+'; b.title = 'New direct message'; b.setAttribute('aria-label', 'New direct message');
      b.addEventListener('click', plusFn); d.appendChild(b);
    }
    return d;
  }
  function navBtn(kind, id, fill) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chan';
    b.setAttribute('aria-current', view.kind === kind && view.id === id);
    fill(b);
    if (unread[kind + ':' + id]) { var p = document.createElement('span'); p.className = 'pip'; b.appendChild(p); }
    b.addEventListener('click', function () { openView(kind, id); });
    return b;
  }
  function renderNav() {
    if (!me) return;
    var nav = $('nav'); nav.textContent = '';
    nav.appendChild(navLabel('Text channels'));
    ['general', 'links'].forEach(function (c) {
      nav.appendChild(navBtn('ch', c, function (b) {
        var h = document.createElement('span'); h.className = 'hash'; h.textContent = '#';
        var n = document.createElement('span'); n.className = 'cname'; n.textContent = c;
        b.appendChild(h); b.appendChild(n);
      }));
    });
    nav.appendChild(navLabel('Direct messages', openDmPicker));
    var recent = function (c) { return c.last ? c.last.ts : Date.now(); };
    var sorted = dmList.slice().sort(function (x, y) { return recent(y) - recent(x); });
    sorted.filter(function (c) { return c.mine; }).forEach(function (c) {
      var o = otherOf(c);
      nav.appendChild(navBtn('dm', c.conv, function (b) {
        var av = document.createElement('div'); av.className = 'av'; avatar(av, o.id, o.name);
        var n = document.createElement('span'); n.className = 'cname'; n.textContent = o.name; colored(n, o);
        b.appendChild(av); b.appendChild(n);
      }));
    });
    var others = sorted.filter(function (c) { return !c.mine; });
    if (me.role === 'owner' && others.length) {
      nav.appendChild(navLabel('All conversations'));
      others.forEach(function (c) {
        nav.appendChild(navBtn('dm', c.conv, function (b) {
          var n = document.createElement('span'); n.className = 'cname'; n.textContent = c.a.name + ' & ' + c.b.name;
          b.appendChild(n);
        }));
      });
    }
  }
  function openView(kind, id) {
    view = { kind: kind, id: id }; unread[kind + ':' + id] = false; armed = null;
    renderNav(); updateView(); renderThread(true);
    if (kind === 'dm' && !dmMsgs[id]) loadConv(id);
    if (canPost()) $('input').focus();
  }
  function canPost() {
    if (view.kind === 'ch') return view.id === 'general' || me.role === 'owner';
    return view.id.split('~').indexOf(me.id) >= 0;
  }
  function viewTitle() {
    if (view.kind === 'ch') return view.id;
    var e = entryFor(view.id);
    if (!e) return 'Conversation';
    return e.mine ? otherOf(e).name : e.a.name + ' & ' + e.b.name;
  }
  function updateView() {
    var isCh = view.kind === 'ch';
    $('chHash').textContent = isCh ? '#' : (entryFor(view.id) && entryFor(view.id).mine ? '@' : '');
    $('chTitle').textContent = viewTitle();
    $('chTopic').textContent = isCh ? TOPIC[view.id] : 'Direct message';
    $('dmNotice').hidden = isCh;
    $('input').placeholder = isCh ? 'Message #' + view.id : 'Message @' + viewTitle();
    var ok = canPost();
    $('form').hidden = !ok; $('denied').hidden = ok;
    $('denied').textContent = view.kind === 'dm'
      ? 'You are viewing this conversation as an owner. Only the two people in it can write here.'
      : 'You do not have permission to send messages in this channel.';
  }

  // ---------- rendering ----------
  var URL_RE = /https?:\/\/[^\s<>"']+/g;
  function appendLinked(el, text) {
    var last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      var raw = m[0];
      var url = raw.replace(/[.,;:!?)\]}]+$/, '');
      var trail = raw.slice(url.length);
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var ok = false;
      try { var u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch (e) {}
      if (ok) {
        var a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'lnk'; a.textContent = url;
        el.appendChild(a);
      } else { el.appendChild(document.createTextNode(url)); }
      if (trail) el.appendChild(document.createTextNode(trail));
      last = m.index + raw.length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(ts) {
    var now = Date.now();
    if (dayKey(ts) === dayKey(now)) return 'Today';
    if (dayKey(ts) === dayKey(now - 86400000)) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function timeStr(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function currentList() {
    if (view.kind === 'dm') return dmMsgs[view.id] || [];
    return messages.filter(function (m) { return (m.ch || 'general') === view.id; });
  }

  function renderThread(forceBottom) {
    if (!me) return;
    var stick = forceBottom || nearBottom();
    var t = $('thread');
    t.className = 'thread' + (view.kind === 'ch' && view.id === 'links' ? ' links' : '');
    t.textContent = '';
    var list = currentList();
    if (!list.length) {
      var e = document.createElement('div'); e.className = 'empty';
      var h = document.createElement('h2'), p = document.createElement('p');
      if (view.kind === 'dm') {
        var ent = entryFor(view.id);
        h.textContent = ent && ent.mine ? 'Your conversation with ' + otherOf(ent).name : 'No messages yet';
        p.textContent = dmMsgs[view.id] === undefined ? 'Loading…' : 'Say hello. Owners can read every direct message.';
      } else {
        h.textContent = view.id === 'links' ? 'Welcome to #links' : 'Welcome to #general';
        p.textContent = view.id === 'links' ? 'Anyone can read this channel. Only owners can add links.' : 'This is the start of the chat. Write the first message below.';
      }
      e.appendChild(h); e.appendChild(p); t.appendChild(e);
      return;
    }
    var lastDay = null, body = null, lastUid = null, lastTs = 0;
    list.forEach(function (m) {
      var k = dayKey(m.ts);
      if (k !== lastDay) {
        var d = document.createElement('div'); d.className = 'day'; d.textContent = dayLabel(m.ts);
        t.appendChild(d); lastDay = k; body = null;
      }
      if (!body || m.uid !== lastUid || m.ts - lastTs > 7 * 60000) {
        var g = document.createElement('div'); g.className = 'group';
        var av = document.createElement('div'); av.className = 'av'; avatar(av, m.uid, m.name);
        body = document.createElement('div'); body.className = 'gbody';
        var head = document.createElement('div'); head.className = 'ghead';
        var nm = document.createElement('span'); nm.className = 'gname'; nm.textContent = m.name; colored(nm, m);
        head.appendChild(nm);
        var lab = labelOf(m);
        if (lab) { var bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = lab; colored(bd, m); head.appendChild(bd); }
        var tm = document.createElement('span'); tm.className = 'when'; tm.textContent = timeStr(m.ts);
        head.appendChild(tm);
        body.appendChild(head); g.appendChild(av); g.appendChild(body); t.appendChild(g);
      }
      var line = document.createElement('div'); line.className = 'line';
      var tx = document.createElement('div'); tx.className = 'text'; appendLinked(tx, m.text);
      line.appendChild(tx);
      if (m.uid === me.id) {
        var del = document.createElement('button'); del.type = 'button';
        del.className = 'del' + (armed === m.id ? ' arm' : '');
        del.textContent = armed === m.id ? 'Delete message?' : 'Delete';
        del.addEventListener('click', function () { onDelete(m.id); });
        line.appendChild(del);
      }
      body.appendChild(line);
      lastUid = m.uid; lastTs = m.ts;
    });
    if (stick) toBottom();
  }
  function onDelete(id) {
    if (armed !== id) {
      armed = id; clearTimeout(armTimer);
      armTimer = setTimeout(function () { armed = null; renderThread(); }, 3500);
      renderThread(); return;
    }
    armed = null; clearTimeout(armTimer);
    api('DELETE', '/api/messages/' + id).then(function () {
      messages = messages.filter(function (m) { return m.id !== id; });
      Object.keys(dmMsgs).forEach(function (c) { dmMsgs[c] = dmMsgs[c].filter(function (m) { return m.id !== id; }); });
      renderThread();
    }).catch(function (err) { toast(err.message); });
  }

  // ---------- sending ----------
  function autosize() { var i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 160) + 'px'; }
  function send() {
    var i = $('input'); var text = i.value.trim();
    if (!text || sending || !canPost()) return;
    var v = { kind: view.kind, id: view.id };
    sending = true; i.value = ''; autosize();
    var req = v.kind === 'ch' ? api('POST', '/api/messages', { text: text, ch: v.id }) : api('POST', '/api/dms/' + v.id, { text: text });
    req.then(function (j) {
      var m = j.message;
      if (v.kind === 'ch') { if (!messages.some(function (x) { return x.id === m.id; })) messages.push(m); }
      else {
        if (!dmMsgs[v.id]) dmMsgs[v.id] = [];
        if (!dmMsgs[v.id].some(function (x) { return x.id === m.id; })) dmMsgs[v.id].push(m);
        var ent = entryFor(v.id); if (ent) ent.last = { ts: m.ts, uid: m.uid, text: m.text.slice(0, 80) };
      }
      if (view.kind === v.kind && view.id === v.id) renderThread(true);
      renderNav(); setStatus('Live', false, true);
    }).catch(function (err) {
      i.value = text; autosize();
      lost(err);
      if (err.status === 403) refreshMe();
      toast(err.message);
    }).then(function () { sending = false; i.focus(); });
  }
  $('form').addEventListener('submit', function (e) { e.preventDefault(); send(); });
  $('input').addEventListener('input', autosize);
  $('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  // ---------- direct message picker ----------
  function openDmPicker() { $('dSearch').value = ''; renderPicker(); $('dmModal').hidden = false; $('dSearch').focus(); }
  function renderPicker() {
    var q = $('dSearch').value.trim().toLowerCase();
    var list = $('dList'); list.textContent = '';
    var found = users.filter(function (u) { return u.id !== me.id && (!q || u.name.toLowerCase().indexOf(q) >= 0); });
    if (!found.length) { var p = document.createElement('p'); p.textContent = users.length <= 1 ? 'No one else is here yet.' : 'No one matches that.'; list.appendChild(p); return; }
    found.slice(0, 200).forEach(function (u) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'pitem';
      var av = document.createElement('div'); av.className = 'av'; avatar(av, u.id, u.name);
      var w = document.createElement('span'); w.className = 'who'; w.textContent = u.name; colored(w, u);
      b.appendChild(av); b.appendChild(w);
      b.addEventListener('click', function () { closeOverlays(); openDmWith(u); });
      list.appendChild(b);
    });
  }
  $('dSearch').addEventListener('input', renderPicker);
  $('dCancel').addEventListener('click', closeOverlays);
  function openDmWith(u) {
    var conv = convFor(me.id, u.id);
    if (!entryFor(conv)) {
      var first = me.id < u.id;
      dmList.unshift({ conv: conv, mine: true, a: first ? pubOf(me) : u, b: first ? u : pubOf(me), last: null });
    }
    openView('dm', conv);
  }
  function pubOf(u) { return { id: u.id, name: u.name, role: u.role, roleLabel: u.roleLabel, nameColor: u.nameColor }; }

  // ---------- code box ----------
  $('ggBtn').addEventListener('click', function () { $('cInput').value = ''; showMsg('cErr', ''); $('codeModal').hidden = false; $('cInput').focus(); });
  $('cCancel').addEventListener('click', closeOverlays);
  $('codeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('cSubmit').disabled = true; showMsg('cErr', '');
    api('POST', '/api/role', { code: $('cInput').value }).then(function (j) {
      me = j.user; renderMe(); updateView(); renderNav(); loadMessages(); loadDms();
      closeOverlays(); toast('You now have the ' + labelOf(me) + ' role.');
    }).catch(function (err) { showMsg('cErr', err.message); $('cInput').select(); })
      .then(function () { $('cSubmit').disabled = false; });
  });

  // ---------- settings ----------
  function openSettings() {
    $('sName').value = me.name;
    $('sRoleBox').hidden = !me.role;
    $('sRole').value = me.roleLabel || ''; $('sRole').placeholder = DEFAULT_LABEL[me.role] || '';
    $('sColor').value = colorOf(me) || '#3ba0ff';
    $('sGuest').hidden = !!me.login; $('sGuestWarn').hidden = !!me.login; $('sMember').hidden = !me.login;
    $('sSignedIn').textContent = me.login ? 'Signed in as ' + me.login + '.' : '';
    $('sUser').value = ''; $('sPass').value = ''; $('sNewPass').value = '';
    $('sBackup').hidden = !(me.role === 'owner' && backupsOn);
    $('sKey').value = ''; $('sFile').value = '';
    ['sProfileErr', 'sAccountErr', 'sAccountOk', 'sBackupErr', 'sBackupOk'].forEach(function (id) { showMsg(id, ''); });
    $('setModal').hidden = false; $('sName').focus();
  }
  $('meBtn').addEventListener('click', openSettings);
  $('sClose').addEventListener('click', closeOverlays);

  $('sSaveProfile').addEventListener('click', function () {
    showMsg('sProfileErr', '');
    var body = { name: $('sName').value };
    if (me.role) {
      body.roleLabel = $('sRole').value.trim();
      var c = $('sColor').value.toLowerCase();
      if (c !== (colorOf(me) || '').toLowerCase()) body.nameColor = c;
    }
    api('POST', '/api/profile', body).then(function (j) {
      me = j.user; remember(me.name); renderMe(); updateView(); renderNav(); toast('Profile saved.');
    }).catch(function (err) { showMsg('sProfileErr', err.message); });
  });
  $('sResetRole').addEventListener('click', function () {
    api('POST', '/api/profile', { roleLabel: '', nameColor: '' }).then(function (j) {
      me = j.user; renderMe(); $('sRole').value = ''; $('sColor').value = colorOf(me) || '#3ba0ff'; toast('Role text and color reset.');
    }).catch(function (err) { showMsg('sProfileErr', err.message); });
  });

  $('sCreate').addEventListener('click', function () {
    showMsg('sAccountErr', ''); showMsg('sAccountOk', '');
    api('POST', '/api/account', { username: $('sUser').value, password: $('sPass').value }).then(function (j) {
      me = j.user; openSettings(); showMsg('sAccountOk', 'Saved. Sign in with this username and password on any device.');
    }).catch(function (err) { showMsg('sAccountErr', err.message); });
  });
  $('sChangePass').addEventListener('click', function () {
    showMsg('sAccountErr', ''); showMsg('sAccountOk', '');
    api('POST', '/api/password', { password: $('sNewPass').value }).then(function () {
      $('sNewPass').value = ''; showMsg('sAccountOk', 'Password changed. Other devices were signed out.');
    }).catch(function (err) { showMsg('sAccountErr', err.message); });
  });
  $('sSignOut').addEventListener('click', function () {
    api('POST', '/api/logout', {}).catch(function () {}).then(function () {
      if (es) { es.close(); es = null; }
      me = null; closeOverlays(); mode = 'in'; showAuth();
    });
  });

  $('sExport').addEventListener('click', function () {
    showMsg('sBackupErr', ''); showMsg('sBackupOk', '');
    fetch('/api/admin/export', { credentials: 'same-origin', headers: { 'X-Admin-Key': $('sKey').value } }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'Could not download the backup.'); });
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      showMsg('sBackupOk', 'Backup downloaded. Keep the file private.');
    }).catch(function (err) { showMsg('sBackupErr', err.message); });
  });
  $('sImport').addEventListener('click', function () {
    showMsg('sBackupErr', ''); showMsg('sBackupOk', '');
    var f = $('sFile').files[0];
    if (!f) { showMsg('sBackupErr', 'Choose a backup file first.'); return; }
    if (!importArmed) { importArmed = true; $('sImport').textContent = 'Click again to replace everything'; return; }
    importArmed = false; $('sImport').textContent = 'Restore from file';
    f.text().then(function (txt) {
      return api('POST', '/api/admin/import', txt, { 'X-Admin-Key': $('sKey').value });
    }).then(function (j) {
      toast('Restored ' + j.users + ' people, ' + j.messages + ' messages and ' + j.dms + ' DMs. Reloading…');
      setTimeout(function () { location.reload(); }, 1200);
    }).catch(function (err) { showMsg('sBackupErr', err.message); });
  });

  // ---------- overlays ----------
  overlays().forEach(function (id) {
    $(id).addEventListener('mousedown', function (e) { if (e.target === $(id)) closeOverlays(); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlays(); });

  // ---------- start ----------
  api('GET', '/api/me').then(function (j) {
    inviteRequired = !!j.inviteRequired; backupsOn = !!j.backups;
    if (j.user) enter(j.user); else showAuth();
  }).catch(function () { showAuth(); showMsg('authErr', 'Could not reach the server.'); });
})();
