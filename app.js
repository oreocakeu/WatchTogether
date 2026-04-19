/* ── WatchTogether — app.js ── */

// ── Firebase (safe init) ──
var db = null;
try { db = firebase.database(); } catch(e) { console.warn('Firebase not available:', e); }

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
var isSyncing       = false;
var roomRef         = null;
var chatRef         = null;

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTime(s) {
  s = Math.floor(s || 0);
  var m = Math.floor(s / 60);
  var sec = String(s % 60).padStart(2, '0');
  return m + ':' + sec;
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

  if (!db) {
    addLocalMsg('system', '', 'Firebase not connected — sync disabled.');
    return;
  }

  roomRef = db.ref('rooms/' + room + '/state');
  chatRef = db.ref('rooms/' + room + '/chat');

  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state || isSyncing) return;

    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
    }
    if (state.playing !== isPlaying) {
      if (state.playing) { doPlay(); } else { doPause(); }
    }
    if (typeof state.time === 'number' && Math.abs(currentRawTime - state.time) > 3) {
      seekTo(state.time);
    }
  });

  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m || m.id === myId) return;
    appendChatMsg(m.who, m.text);
  });
}

function copyRoom() {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom)
    .then(function()  { addLocalMsg('system', '', 'Room name "' + currentRoom + '" copied!'); })
    .catch(function() { addLocalMsg('system', '', 'Room: ' + currentRoom); });
}

function pushState(updates) {
  if (!roomRef) return;
  isSyncing = true;
  var data = Object.assign({ updatedAt: Date.now() }, updates);
  roomRef.update(data).then(function() {
    setTimeout(function() { isSyncing = false; }, 300);
  }).catch(function(e) {
    isSyncing = false;
    console.warn('pushState error:', e);
  });
}

// ── Video ──
function loadVideo() {
  var url = getEl('videoInput').value.trim();
  if (!url) return;
  doLoadVideo(url, true);
}

function doLoadVideo(url, pushToRoom) {
  currentVideo = url;
  var embedSrc = null;
  var type     = null;

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = extractYTId(url);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type     = 'youtube';
    embedSrc = 'https://www.youtube.com/embed/' + vid + '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1';
  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type     = 'drive';
    embedSrc = 'https://drive.google.com/file/d/' + fid + '/preview';
  } else {
    alert('Paste a YouTube URL or a Google Drive share link.');
    return;
  }

  videoType = type;

  getEl('playerPlaceholder').style.display = 'none';
  var frame = getEl('videoFrame');
  frame.src = embedSrc;
  frame.style.display = 'block';
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display = (type === 'drive') ? 'block' : 'none';

  var container = getEl('playerContainer');
  if (type === 'drive') {
    container.classList.add('drive-player');
  } else {
    container.classList.remove('drive-player');
  }

  if (type === 'youtube') setupYTMessaging();
  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, time: 0 });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
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

// ── YouTube bridge ──
function setupYTMessaging() {
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    try {
      var d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
      if (d.event === 'onStateChange') {
        if (d.info === 1) { isPlaying = true;  updatePlayBtn(); }
        if (d.info === 2) { isPlaying = false; updatePlayBtn(); }
      }
      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(d.info.currentTime);
      }
    } catch(err) {}
  });
  setTimeout(function() { sendYT('{"event":"listening"}'); }, 800);
}

function sendYT(json) {
  var f = getEl('videoFrame');
  if (f && f.contentWindow) {
    try { f.contentWindow.postMessage(json, '*'); } catch(e) {}
  }
}

function startTimeUpdate() {
  if (timeUpdateTimer) clearInterval(timeUpdateTimer);
  timeUpdateTimer = setInterval(function() {
    if (videoType === 'youtube') {
      sendYT('{"event":"listening"}');
      sendYT(JSON.stringify({ event: 'command', func: 'getCurrentTime', args: '' }));
    }
  }, 1000);
}

// ── Playback ──
function togglePlay() {
  if (isPlaying) {
    doPause();
    if (roomRef) pushState({ playing: false, time: currentRawTime });
  } else {
    doPlay();
    if (roomRef) pushState({ playing: true, time: currentRawTime });
  }
}

function doPlay() {
  isPlaying = true;
  updatePlayBtn();
  if (videoType === 'youtube') sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
}

function doPause() {
  isPlaying = false;
  updatePlayBtn();
  if (videoType === 'youtube') sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
}

function seekTo(t) {
  if (videoType === 'youtube') sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
}

function syncNow() {
  if (!roomRef) return;
  roomRef.once('value', function(snap) {
    var state = snap.val();
    if (!state) return;
    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
    }
    seekTo(state.time || 0);
    if (state.playing) { doPlay(); } else { doPause(); }
    addLocalMsg('system', '', 'Synced to room');
  });
}

function updatePlayBtn() {
  getEl('playIcon').style.display  = isPlaying ? 'none'  : 'block';
  getEl('pauseIcon').style.display = isPlaying ? 'block' : 'none';
  getEl('playLabel').textContent   = isPlaying ? 'Pause' : 'Play';
}

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
  appendChatMsg(myName, txt);
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
    div.className   = 'chat-system';
    div.textContent = text;
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
