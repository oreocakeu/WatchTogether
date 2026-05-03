/* ── WatchTogether — app.js ── */

// ── Google OAuth ──
var GOOGLE_CLIENT_ID = '196643326912-cpjcrt8ce1jlf9v2bi5a566s7l93qruv.apps.googleusercontent.com';
var GOOGLE_SCOPE     = 'https://www.googleapis.com/auth/drive.readonly';
var googleAccessToken = null;
var pendingDriveFileId = null;

// ── Firebase ──
var db = null;
try { db = firebase.database(); } catch(e) { console.warn('Firebase error:', e); }

// ── State ──
var currentRoom     = null;
var currentVideo    = null;
var videoType       = null;
var isPlaying       = false;
var myName          = 'You';
var myId            = 'u_' + Math.random().toString(36).slice(2, 8);
var playerExpanded  = false;
var currentRawTime  = 0;
var timeUpdateTimer = null;
var roomRef         = null;
var chatRef         = null;
var membersRef      = null;
var presenceRef     = null;
var clockSyncTimer  = null;
var lastState       = null;
var applyingRemote  = false;
var pushTimeout     = null;
var platformsOpen   = false;
var seekDebounce    = null;
var prevTime        = 0;

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setSyncStatus(msg) {
  var el = getEl('syncStatus');
  if (!el) return;
  el.textContent = msg;
  if (msg) setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2000);
}

// ── Virtual clock ──
function calcExpectedTime(state) {
  if (!state) return 0;
  if (!state.playing || !state.playedAt) return (state.position || 0);
  return (state.position || 0) + (Date.now() - state.playedAt) / 1000;
}

// ── Overlay ──
function openApp() {
  getEl('appOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(function() { getEl('roomInput').focus(); }, 120);
}
function closeApp() {
  getEl('appOverlay').classList.remove('open');
  document.body.style.overflow = '';
}
function scrollToHow() {
  getEl('how').scrollIntoView({ behavior: 'smooth' });
}

// ── Google Drive OAuth ──
function connectGoogleDrive() {
  // Use Google Identity Services token client
  var tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     GOOGLE_SCOPE,
    callback:  function(response) {
      if (response.error) {
        addLocalMsg('system', '', 'Google sign-in failed: ' + response.error);
        return;
      }
      googleAccessToken = response.access_token;
      addLocalMsg('system', '', '✓ Google Drive connected');

      // Now load the pending Drive file
      if (pendingDriveFileId) {
        loadDriveWithToken(pendingDriveFileId);
      }
    }
  });
  tokenClient.requestAccessToken();
}

function loadDriveWithToken(fileId) {
  // Use Drive API to get file metadata + streaming URL
  fetch('https://www.googleapis.com/drive/v3/files/' + fileId +
        '?fields=name,mimeType,size&supportsAllDrives=true', {
    headers: { 'Authorization': 'Bearer ' + googleAccessToken }
  })
  .then(function(r) { return r.json(); })
  .then(function(meta) {
    if (meta.error) {
      addLocalMsg('system', '', 'Drive error: ' + meta.error.message);
      return;
    }

    // Stream URL — authenticated with our token
    var streamUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId +
                    '?alt=media&supportsAllDrives=true';

    addLocalMsg('system', '', 'Loading: ' + (meta.name || 'video'));

    // Hide connect prompt, show player
    getEl('driveConnect').style.display      = 'none';
    getEl('playerPlaceholder').style.display = 'none';

    // Load in HTML5 player with auth header via Blob
    loadDriveStream(streamUrl, fileId);
  })
  .catch(function(e) {
    addLocalMsg('system', '', 'Could not load Drive file: ' + e.message);
  });
}

function loadDriveStream(streamUrl, fileId) {
  // Use direct streaming URL with access token — starts playing immediately
  var tokenUrl = streamUrl + '&access_token=' + googleAccessToken;
  
  addLocalMsg('system', '', 'Starting video stream...');
  setupHtml5Player(tokenUrl, null);
  videoType = 'html5';
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display      = 'none';
  getEl('playPauseBtn').style.display   = 'none';
  startTimeUpdate();

  if (currentRoom && roomRef) {
    pushState({ video: currentVideo, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video ready — full sync enabled!');
  }
}

// ── Platform hints ──
function togglePlatforms() {
  platformsOpen = !platformsOpen;
  var grid = getEl('platformsGrid');
  var btn  = document.querySelector('.platforms-toggle');
  var hint = getEl('platformHintBox');
  grid.style.display = platformsOpen ? 'grid' : 'none';
  if (btn) btn.classList.toggle('open', platformsOpen);
  if (!platformsOpen && hint) hint.style.display = 'none';
}
var platformHints = {
  youtube:     '🔴 <b>YouTube</b> — Paste any youtube.com or youtu.be link. Full sync.',
  bilibili:    '🔵 <b>Bilibili</b> — Paste any bilibili.com or bilibili.tv link. Embed sync.',
  vimeo:       '🔵 <b>Vimeo</b> — Paste any vimeo.com video link. Embed sync.',
  dailymotion: '🔵 <b>Dailymotion</b> — Paste any dailymotion.com video link. Embed sync.',
  twitch:      '🟣 <b>Twitch VOD</b> — Paste a twitch.tv/videos/... link. Embed sync.',
  odysee:      '🔴 <b>Odysee</b> — Paste any odysee.com video link. Embed sync.',
  onedrive:    '🔵 <b>OneDrive</b> — Share → Copy link → paste here. Full sync.',
  archive:     '📚 <b>Internet Archive</b> — Paste archive.org/details/... link. Full sync.',
  dropbox:     '📦 <b>Dropbox</b> — Share → Copy link → paste here. Full sync.',
  drive:       '🟢 <b>Google Drive</b> — Paste share link → Connect Google → Full sync!',
  mp4:         '▤ <b>Direct .mp4</b> — Any public direct video URL (.mp4, .webm, .ogg). Full sync.'
};
function setPlatformHint(key) {
  var box = getEl('platformHintBox');
  if (!box) return;
  box.innerHTML = platformHints[key] || '';
  box.style.display = 'block';
}

// ── Room ──
function joinRoom() {
  var name = getEl('nameInput').value.trim() || 'Anonymous';
  var room = getEl('roomInput').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!room) { alert('Please enter a room name.'); return; }

  myName      = name;
  currentRoom = room;

  getEl('roomBadge').style.display    = 'flex';
  getEl('roomBadgeLabel').textContent = '# ' + room;
  getEl('chatRoomTag').textContent    = '#' + room;

  addLocalMsg('system', '', 'Joined room #' + room);

  if (!db) { addLocalMsg('system', '', 'Firebase not connected.'); return; }

  roomRef    = db.ref('rooms/' + room + '/state');
  chatRef    = db.ref('rooms/' + room + '/chat');
  membersRef = db.ref('rooms/' + room + '/members');

  // ── Presence ──
  presenceRef = membersRef.child(myId);
  presenceRef.set({ name: myName, joinedAt: Date.now() });
  presenceRef.onDisconnect().remove();

  membersRef.on('value', function(snap) {
    var count = snap.numChildren();
    var el    = getEl('memberCountNum');
    var badge = getEl('memberCount');
    if (el) el.textContent = count;
    if (badge) {
      if (count > 1) badge.classList.add('active');
      else badge.classList.remove('active');
    }
  });

  // ── Main state listener ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state) return;
    if (state.pushedBy === myId) return;

    lastState = state;

    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
      return;
    }

    forceApplyState(state);
  });

  // ── Chat ──
  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m) return;
    appendChatMsg(m.who, m.text);
  });
}

function copyRoom() {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom)
    .then(function()  { addLocalMsg('system', '', 'Room name "' + currentRoom + '" copied!'); })
    .catch(function() { addLocalMsg('system', '', 'Room: ' + currentRoom); });
}

// ── Force apply state ──
function forceApplyState(state) {
  if (!state) return;
  var expected = calcExpectedTime(state);

  applyingRemote = true;
  forceSeek(expected);

  setTimeout(function() {
    if (state.playing) forcePlay();
    else forcePause();
    setTimeout(function() { applyingRemote = false; }, 600);
  }, 200);

  setSyncStatus('syncing...');
  setTimeout(function() { setSyncStatus(''); }, 1500);

  if (state.playing) startClockSync(state);
  else stopClockSync();
}

function startClockSync(state) {
  stopClockSync();
  clockSyncTimer = setInterval(function() {
    if (!state || !state.playing || applyingRemote) return;
    var expected = calcExpectedTime(state);
    var drift    = Math.abs(currentRawTime - expected);
    if (drift > 2 && drift < 120) {
      applyingRemote = true;
      forceSeek(expected);
      setTimeout(function() { applyingRemote = false; }, 500);
    }
  }, 3000);
}
function stopClockSync() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

// ── Push state ──
function pushState(data) {
  if (!roomRef) return;
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(function() {
    var payload = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, data);
    roomRef.update(payload).catch(function(e) { console.warn('Push error:', e); });
  }, 80);
}

// ── Video loading ──
function loadVideo() {
  var url = getEl('videoInput').value.trim();
  if (!url) return;
  doLoadVideo(url, true);
}

function doLoadVideo(url, pushToRoom) {
  currentVideo = url;
  stopClockSync();

  getEl('videoFrame').src            = '';
  getEl('videoFrame').style.display  = 'none';
  getEl('driveVideo').style.display  = 'none';
  getEl('driveVideo').src            = '';
  getEl('driveConnect').style.display    = 'none';
  getEl('playerPlaceholder').style.display = 'none';

  var type = null;

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = extractYTId(url);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type = 'youtube';
    var frame = getEl('videoFrame');
    frame.src = 'https://www.youtube.com/embed/' + vid +
                '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1&iv_load_policy=3';
    frame.style.display = 'block';
    setupYTMessaging();

  } else if (/vimeo\.com/.test(url)) {
    var vimeoId = url.match(/vimeo\.com\/(\d+)/);
    if (!vimeoId) { alert('Could not parse Vimeo video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.vimeo.com/video/' + vimeoId[1] + '?autoplay=0&controls=1&dnt=1';
    frame.style.display = 'block';

  } else if (/dailymotion\.com/.test(url)) {
    var dmId = url.match(/video\/([a-zA-Z0-9]+)/);
    if (!dmId) { alert('Could not parse Dailymotion video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://geo.dailymotion.com/player.html?video=' + dmId[1] +
                '&mute=false&sharing-enable=false&queue-enable=false';
    frame.style.display = 'block';

  } else if (/bilibili\.com|bilibili\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var biliSrc = '';
    if (/bilibili\.tv/.test(url)) {
      var btvId = url.match(/\/video\/(\d+)/);
      if (!btvId) { alert('Could not parse Bilibili TV video ID.'); return; }
      biliSrc = 'https://player.bilibili.tv/player.html?aid=' + btvId[1] + '&autoplay=0';
    } else if (/\/bangumi\/play\/(ep|ss)(\d+)/.test(url)) {
      var bangumi = url.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
      biliSrc = 'https://player.bilibili.com/player.html?' + bangumi[1] + 'id=' + bangumi[2] + '&autoplay=0&danmaku=0';
    } else {
      var bvid = url.match(/video\/(BV[a-zA-Z0-9]+|av\d+)/);
      if (!bvid) { alert('Could not parse Bilibili video ID.'); return; }
      biliSrc = 'https://player.bilibili.com/player.html?bvid=' + bvid[1] + '&autoplay=0&danmaku=0';
    }
    frame.src = biliSrc;
    frame.style.display = 'block';

  } else if (/twitch\.tv\/videos/.test(url)) {
    var twitchId = url.match(/videos\/(\d+)/);
    if (!twitchId) { alert('Could not parse Twitch VOD ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.twitch.tv/?video=' + twitchId[1] +
                '&parent=' + window.location.hostname + '&autoplay=false';
    frame.style.display = 'block';

  } else if (/odysee\.com|lbry\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var odyseeUrl = url
      .replace('odysee.com/', 'odysee.com/$/embed/')
      .replace('lbry.tv/', 'odysee.com/$/embed/');
    frame.src = odyseeUrl + '?autoplay=0';
    frame.style.display = 'block';

  } else if (/drive\.google\.com/.test(url)) {
    // Google Drive — show connect prompt or load directly if token exists
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'drive-pending';
    pendingDriveFileId = fid;

    if (googleAccessToken) {
      // Already connected — load directly
      loadDriveWithToken(fid);
    } else {
      // Show connect prompt
      getEl('driveConnect').style.display = 'flex';
      if (pushToRoom && roomRef) {
        pushState({ video: url, playing: false, position: 0, playedAt: null });
      }
    }

  } else if (/dropbox\.com/.test(url)) {
    var dropUrl = url
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '').replace('?raw=1', '');
    type = 'html5';
    setupHtml5Player(dropUrl, null);

  } else if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(url)) {
    type = 'html5';
    var odUrl = /1drv\.ms/.test(url)
      ? url + (url.includes('?') ? '&' : '?') + 'download=1'
      : url.replace('redir?', 'download?').replace('embed?', 'download?');
    setupHtml5Player(odUrl, null);

  } else if (/archive\.org/.test(url)) {
    type = 'html5';
    var archUrl = url;
    if (url.includes('/details/')) {
      var itemId = url.split('/details/')[1].split('/')[0].split('?')[0];
      archUrl = 'https://archive.org/download/' + itemId + '/' + itemId + '.mp4';
    }
    setupHtml5Player(archUrl, null);

  } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
    type = 'html5';
    setupHtml5Player(url, null);

  } else {
    alert('Unsupported link. Check supported platforms below.');
    return;
  }

  if (type !== 'drive-pending') {
    videoType = type;
    getEl('playerControls').style.display = 'flex';
    getEl('driveNote').style.display      = (type === 'html5') ? 'block' : 'none';
    getEl('playPauseBtn').style.display   = (type === 'html5') ? 'none' : 'flex';
    startTimeUpdate();

    if (pushToRoom && roomRef) {
      pushState({ video: url, playing: false, position: 0, playedAt: null });
      addLocalMsg('system', '', 'Video loaded for everyone in the room');
    } else if (lastState) {
      setTimeout(function() { if (lastState) forceApplyState(lastState); }, 1500);
    }
  }
}

function extractYTId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function extractDriveId(url) {
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── HTML5 player ──
function setupHtml5Player(src, driveFileId) {
  var old = getEl('driveVideo');
  var fresh = document.createElement('video');
  fresh.id       = 'driveVideo';
  fresh.controls = true;
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('preload', 'metadata');
  fresh.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; background:#000;';
  old.parentNode.replaceChild(fresh, old);
  fresh.src = src;
  fresh.load();

  fresh.addEventListener('play', function() {
    if (applyingRemote) return;
    isPlaying = true; updatePlayBtn();
    pushState({ playing: true, position: fresh.currentTime, playedAt: Date.now() });
  });

  fresh.addEventListener('pause', function() {
    if (applyingRemote) return;
    if (document.visibilityState === 'hidden') return;
    isPlaying = false; updatePlayBtn();
    pushState({ playing: false, position: fresh.currentTime, playedAt: null });
  });

  fresh.addEventListener('seeked', function() {
    if (applyingRemote) return;
    currentRawTime = fresh.currentTime;
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(function() {
      pushState({
        playing:  !fresh.paused,
        position: fresh.currentTime,
        playedAt: !fresh.paused ? Date.now() : null
      });
      setSyncStatus('position shared ✓');
    }, 200);
  });

  fresh.addEventListener('timeupdate', function() {
    currentRawTime = fresh.currentTime;
    getEl('timeDisplay').textContent = fmtTime(fresh.currentTime);
  });

  fresh.addEventListener('error', function() {
    if (driveFileId) {
      fresh.style.display = 'none';
      var frame = getEl('videoFrame');
      frame.src = 'https://drive.google.com/file/d/' + driveFileId + '/preview';
      frame.style.display = 'block';
      videoType = 'embed';
      addLocalMsg('system', '', 'Falling back to Drive preview mode.');
    } else {
      addLocalMsg('system', '', 'Could not load video. Check the link is publicly accessible.');
    }
  });
}

// ── Force controls ──
function forcePlay() {
  isPlaying = true; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v && v.src) v.play().catch(function() {
      isPlaying = false; updatePlayBtn();
      addLocalMsg('system', '', '▶ Tap Play — video position updated');
    });
  }
}
function forcePause() {
  isPlaying = false; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) v.pause();
  }
}
function forceSeek(t) {
  if (isNaN(t) || t < 0) return;
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (!v) return;
    if (v.readyState >= 1) {
      v.currentTime = t;
    } else {
      v.addEventListener('loadedmetadata', function onMeta() {
        v.removeEventListener('loadedmetadata', onMeta);
        v.currentTime = t;
      });
    }
  }
}

// ── YouTube bridge ──
var ytListenerAdded = false;
function setupYTMessaging() {
  if (ytListenerAdded) return;
  ytListenerAdded = true;
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    try {
      var d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
      if (d.event === 'onStateChange') {
        if (d.info === 1 && !applyingRemote) {
          isPlaying = true; updatePlayBtn();
          pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
        }
        if (d.info === 2 && !applyingRemote && document.visibilityState !== 'hidden') {
          isPlaying = false; updatePlayBtn();
          pushState({ playing: false, position: currentRawTime, playedAt: null });
        }
      }
      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        prevTime       = currentRawTime;
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(currentRawTime);
        var expectedProgress = prevTime + 0.6;
        var isSeek = Math.abs(currentRawTime - expectedProgress) > 2;
        if (!applyingRemote && isSeek) {
          if (seekDebounce) clearTimeout(seekDebounce);
          seekDebounce = setTimeout(function() {
            pushState({ playing: isPlaying, position: currentRawTime, playedAt: isPlaying ? Date.now() : null });
            setSyncStatus('position shared ✓');
          }, 200);
        }
      }
    } catch(err) {}
  });
  setTimeout(function() { sendYT('{"event":"listening"}'); }, 800);
}

function sendYT(json) {
  var f = getEl('videoFrame');
  if (f && f.contentWindow) try { f.contentWindow.postMessage(json, '*'); } catch(e) {}
}

function startTimeUpdate() {
  if (timeUpdateTimer) clearInterval(timeUpdateTimer);
  timeUpdateTimer = setInterval(function() {
    if (videoType === 'youtube') {
      sendYT('{"event":"listening"}');
      sendYT(JSON.stringify({ event: 'command', func: 'getCurrentTime', args: '' }));
    }
  }, 500);
}

// ── Play/Pause button ──
function togglePlay() {
  if (isPlaying) {
    forcePause();
    pushState({ playing: false, position: currentRawTime, playedAt: null });
  } else {
    forcePlay();
    pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
  }
}

function updatePlayBtn() {
  getEl('playIcon').style.display  = isPlaying ? 'none'  : 'block';
  getEl('pauseIcon').style.display = isPlaying ? 'block' : 'none';
  getEl('playLabel').textContent   = isPlaying ? 'Pause' : 'Play';
}

// ── Tab visibility ──
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && lastState) {
    setTimeout(function() { forceApplyState(lastState); }, 300);
  }
});

// ── Expand ──
function toggleExpand() {
  playerExpanded = !playerExpanded;
  getEl('playerContainer').classList.toggle('expanded', playerExpanded);
  var modal = document.querySelector('.app-modal');
  if (modal) modal.classList.toggle('player-expanded', playerExpanded);
  getEl('expandIcon').style.display   = playerExpanded ? 'none'  : 'block';
  getEl('collapseIcon').style.display = playerExpanded ? 'block' : 'none';
  getEl('expandLabel').textContent    = playerExpanded ? 'Collapse' : 'Expand';
}

// ── Chat ──
function sendChat() {
  var inp = getEl('chatInput');
  var txt = inp.value.trim();
  if (!txt) return;
  if (!chatRef) { addLocalMsg('system', '', 'Join a room first!'); return; }
  inp.value = '';
  myName = getEl('nameInput').value.trim() || 'Anonymous';
  chatRef.push({ who: myName, text: txt, id: myId, ts: Date.now() });
}

function appendChatMsg(who, text) {
  var box = getEl('chatBody');
  var div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = '<span class="who">' + esc(who) + '</span> ' + esc(text);
  box.appendChild(div);
  while (box.children.length > 80) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function addLocalMsg(type, who, text) {
  var box = getEl('chatBody');
  var div = document.createElement('div');
  if (type === 'system') {
    div.className = 'chat-system'; div.textContent = text;
  } else {
    div.className = 'chat-msg';
    div.innerHTML = '<span class="who">' + esc(who) + '</span> ' + esc(text);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── Event listeners ──
document.getElementById('appOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeApp();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeApp();
});
