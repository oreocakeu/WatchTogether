/* ── WatchTogether — app.js ── */
/* 
  RAVE-STYLE SYNC:
  - Host: logs into Google Drive, picks video via Picker API, controls everything
  - Viewer: joins room, watches in sync, no controls
  - Firebase: syncs play/pause/seek in real time using virtual clock
*/

// ── Config ──
var GOOGLE_CLIENT_ID  = '196643326912-cpjcrt8ce1jlf9v2bi5a566s7l93qruv.apps.googleusercontent.com';
var GOOGLE_API_KEY    = 'AIzaSyBsYIAUYPnDQA5yakvVy-EksETWSheC7h4';
var GOOGLE_SCOPE      = 'https://www.googleapis.com/auth/drive.readonly';
var PICKER_APP_ID     = '196643326912';

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
var myRole          = 'host'; // 'host' or 'viewer'
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
var googleAccessToken = null;
var gapiReady       = false;
var currentSource   = 'youtube';

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

// ── Role ──
function setRole(role) {
  myRole = role;
  getEl('roleHost').classList.toggle('active', role === 'host');
  getEl('roleViewer').classList.toggle('active', role === 'viewer');

  // Show/hide video section based on role
  getEl('videoSection').style.display = role === 'host' ? 'block' : 'none';

  // Show viewer overlay on player
  getEl('viewerOverlay').style.display = role === 'viewer' ? 'flex' : 'none';

  // Hide controls for viewer
  if (role === 'viewer') {
    getEl('playerControls').style.display = 'none';
    // Remove controls from video element
    var v = getEl('driveVideo');
    if (v) v.removeAttribute('controls');
  } else {
    var v = getEl('driveVideo');
    if (v) v.setAttribute('controls', '');
  }

  addLocalMsg('system', '', 'You are ' + (role === 'host' ? '🎬 the host' : '👀 a viewer'));
}

// ── Source tabs ──
function switchSource(source) {
  currentSource = source;
  getEl('tabYoutube').classList.toggle('active', source === 'youtube');
  getEl('tabDrive').classList.toggle('active', source === 'drive');
  getEl('tabOther').classList.toggle('active', source === 'other');
  getEl('sourceYoutube').style.display = source === 'youtube' ? 'block' : 'none';
  getEl('sourceDrive').style.display   = source === 'drive'   ? 'block' : 'none';
  getEl('sourceOther').style.display   = source === 'other'   ? 'block' : 'none';
}

// ── Google Drive OAuth + Picker ──
function connectGoogleDrive() {
  var tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     GOOGLE_SCOPE,
    callback:  function(response) {
      if (response.error) {
        addLocalMsg('system', '', 'Google sign-in failed: ' + response.error);
        return;
      }
      googleAccessToken = response.access_token;
      getEl('driveNotConnected').style.display = 'none';
      getEl('driveConnected').style.display    = 'block';
      addLocalMsg('system', '', '✓ Google Drive connected');
      loadGapi();
    }
  });
  tokenClient.requestAccessToken();
}

function loadGapi() {
  if (gapiReady) return;
  gapi.load('picker', function() {
    gapiReady = true;
  });
}

function openDrivePicker() {
  if (!googleAccessToken) { connectGoogleDrive(); return; }
  if (!gapiReady) { gapi.load('picker', function() { gapiReady = true; openDrivePicker(); }); return; }

  var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setMimeTypes('video/mp4,video/webm,video/ogg,video/quicktime,video/x-msvideo,video/mkv,video/*')
    .setMode(google.picker.DocsViewMode.LIST);

  var picker = new google.picker.PickerBuilder()
    .setAppId(PICKER_APP_ID)
    .setOAuthToken(googleAccessToken)
    .setDeveloperKey(GOOGLE_API_KEY)
    .setCallback(pickerCallback)
    .addView(view)
    .setTitle('Pick a video from your Drive')
    .build();

  picker.setVisible(true);
}

function pickerCallback(data) {
  if (data.action !== google.picker.Action.PICKED) return;
  var file = data.docs[0];
  var fileId   = file.id;
  var fileName = file.name;

  getEl('drivePickedName').textContent = '📽 ' + fileName;
  addLocalMsg('system', '', 'Loading: ' + fileName);

  // Get streamable URL via Drive API
  loadDriveFile(fileId, fileName);
}

function loadDriveFile(fileId, fileName) {
  // Build streaming URL with auth token
  var streamUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId +
                  '?alt=media&supportsAllDrives=true';

  // Store as current video reference in Firebase
  var videoRef = 'gdrive:' + fileId;
  currentVideo = videoRef;

  // Set up HTML5 player with authenticated stream
  setupDriveStream(streamUrl, fileId, fileName);
}

function setupDriveStream(streamUrl, fileId, fileName) {
  getEl('playerPlaceholder').style.display = 'none';

  var old   = getEl('driveVideo');
  var fresh = document.createElement('video');
  fresh.id  = 'driveVideo';
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('preload', 'metadata');
  if (myRole === 'host') fresh.setAttribute('controls', '');
  fresh.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; background:#000;';

  // Direct stream with token in URL — starts immediately like Rave
  fresh.src = streamUrl + '&access_token=' + googleAccessToken;
  old.parentNode.replaceChild(fresh, old);
  fresh.load();
  setupVideoListeners(fresh);

  videoType = 'html5';
  getEl('playerControls').style.display = myRole === 'host' ? 'flex' : 'none';
  startTimeUpdate();
  addLocalMsg('system', '', '✓ ' + (fileName || 'Video') + ' ready!');

  if (roomRef) {
    pushState({ video: currentVideo, playing: false, position: 0, playedAt: null, fileName: fileName });
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
  vimeo:       '🔵 <b>Vimeo</b> — Paste any vimeo.com video link.',
  dailymotion: '🔵 <b>Dailymotion</b> — Paste any dailymotion.com video link.',
  bilibili:    '🔵 <b>Bilibili</b> — Paste any bilibili.com or bilibili.tv link.',
  twitch:      '🟣 <b>Twitch VOD</b> — Paste a twitch.tv/videos/... link.',
  odysee:      '🔴 <b>Odysee</b> — Paste any odysee.com video link.',
  onedrive:    '🔵 <b>OneDrive</b> — Share → Copy link → paste here.',
  dropbox:     '📦 <b>Dropbox</b> — Share → Copy link → paste here.',
  archive:     '📚 <b>Internet Archive</b> — Paste archive.org/details/... link.',
  mp4:         '▤ <b>Direct .mp4</b> — Any public direct video URL (.mp4, .webm, .ogg).'
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
  getEl('roleSection').style.display  = 'block';
  getEl('videoSection').style.display = myRole === 'host' ? 'block' : 'none';

  addLocalMsg('system', '', 'Joined room #' + room);

  if (!db) { addLocalMsg('system', '', 'Firebase not connected.'); return; }

  roomRef    = db.ref('rooms/' + room + '/state');
  chatRef    = db.ref('rooms/' + room + '/chat');
  membersRef = db.ref('rooms/' + room + '/members');

  // ── Presence ──
  presenceRef = membersRef.child(myId);
  presenceRef.set({ name: myName, role: myRole, joinedAt: Date.now() });
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

  // ── Room state listener ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state) return;
    if (state.pushedBy === myId) return; // ignore own echo

    lastState = state;

    // Show filename in chat if viewer and new video loaded
    if (state.fileName && state.video !== currentVideo) {
      addLocalMsg('system', '', '🎬 Now playing: ' + state.fileName);
    }

    // Viewers always follow host — apply every state change
    // Hosts only apply remote seek/play if they're not the one who pushed
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

function pushState(data) {
  if (!roomRef) return;
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(function() {
    var payload = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, data);
    roomRef.update(payload).catch(function(e) { console.warn('Push error:', e); });
  }, 80);
}

// ── Video loading (YouTube + other platforms) ──
function loadVideo() {
  var url = getEl('videoInput').value.trim();
  if (!url) return;
  processUrl(url, true);
}

function loadOtherVideo() {
  var url = getEl('videoInputOther').value.trim();
  if (!url) return;
  processUrl(url, true);
}

function processUrl(url, pushToRoom) {
  currentVideo = url;
  stopClockSync();

  getEl('videoFrame').src           = '';
  getEl('videoFrame').style.display = 'none';
  var oldVideo = getEl('driveVideo');
  if (oldVideo) { oldVideo.style.display = 'none'; oldVideo.src = ''; }
  getEl('playerPlaceholder').style.display = 'none';

  var type  = null;
  var frame = getEl('videoFrame');

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type = 'youtube';
    frame.src = 'https://www.youtube.com/embed/' + vid[1] +
                '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1&iv_load_policy=3';
    frame.style.display = 'block';
    if (myRole === 'host') setupYTMessaging();

  } else if (/vimeo\.com/.test(url)) {
    var vId = url.match(/vimeo\.com\/(\d+)/);
    if (!vId) { alert('Could not parse Vimeo ID.'); return; }
    type = 'embed';
    frame.src = 'https://player.vimeo.com/video/' + vId[1] + '?autoplay=0&controls=1&dnt=1';
    frame.style.display = 'block';

  } else if (/dailymotion\.com/.test(url)) {
    var dmId = url.match(/video\/([a-zA-Z0-9]+)/);
    if (!dmId) { alert('Could not parse Dailymotion ID.'); return; }
    type = 'embed';
    frame.src = 'https://geo.dailymotion.com/player.html?video=' + dmId[1] + '&sharing-enable=false&queue-enable=false';
    frame.style.display = 'block';

  } else if (/bilibili\.com|bilibili\.tv/.test(url)) {
    type = 'embed';
    var bSrc = '';
    if (/bilibili\.tv/.test(url)) {
      var btvId = url.match(/\/video\/(\d+)/);
      if (!btvId) { alert('Could not parse Bilibili TV ID.'); return; }
      bSrc = 'https://player.bilibili.tv/player.html?aid=' + btvId[1] + '&autoplay=0';
    } else if (/\/bangumi\/play\/(ep|ss)(\d+)/.test(url)) {
      var bg = url.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
      bSrc = 'https://player.bilibili.com/player.html?' + bg[1] + 'id=' + bg[2] + '&autoplay=0&danmaku=0';
    } else {
      var bv = url.match(/video\/(BV[a-zA-Z0-9]+|av\d+)/);
      if (!bv) { alert('Could not parse Bilibili ID.'); return; }
      bSrc = 'https://player.bilibili.com/player.html?bvid=' + bv[1] + '&autoplay=0&danmaku=0';
    }
    frame.src = bSrc; frame.style.display = 'block';

  } else if (/twitch\.tv\/videos/.test(url)) {
    var twId = url.match(/videos\/(\d+)/);
    if (!twId) { alert('Could not parse Twitch VOD ID.'); return; }
    type = 'embed';
    frame.src = 'https://player.twitch.tv/?video=' + twId[1] + '&parent=' + window.location.hostname + '&autoplay=false';
    frame.style.display = 'block';

  } else if (/odysee\.com|lbry\.tv/.test(url)) {
    type = 'embed';
    frame.src = url.replace('odysee.com/', 'odysee.com/$/embed/').replace('lbry.tv/', 'odysee.com/$/embed/') + '?autoplay=0';
    frame.style.display = 'block';

  } else if (/dropbox\.com/.test(url)) {
    type = 'html5';
    var dUrl = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0','').replace('?raw=1','');
    setupHtml5Player(dUrl);

  } else if (/1drv\.ms|onedrive\.live\.com/.test(url)) {
    type = 'html5';
    var oUrl = /1drv\.ms/.test(url) ? url + (url.includes('?')?'&':'?') + 'download=1' : url.replace('redir?','download?');
    setupHtml5Player(oUrl);

  } else if (/archive\.org/.test(url)) {
    type = 'html5';
    var aUrl = url;
    if (url.includes('/details/')) {
      var iid = url.split('/details/')[1].split('/')[0].split('?')[0];
      aUrl = 'https://archive.org/download/' + iid + '/' + iid + '.mp4';
    }
    setupHtml5Player(aUrl);

  } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
    type = 'html5';
    setupHtml5Player(url);

  } else {
    alert('Unsupported link. Check supported platforms.');
    return;
  }

  videoType = type || 'embed';
  getEl('playerControls').style.display = myRole === 'host' ? 'flex' : 'none';
  getEl('playPauseBtn').style.display   = (type === 'html5') ? 'none' : 'flex';
  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone');
  } else if (lastState) {
    setTimeout(function() { if (lastState) forceApplyState(lastState); }, 1500);
  }
}

// ── HTML5 player setup ──
function setupHtml5Player(src) {
  var old   = getEl('driveVideo');
  var fresh = document.createElement('video');
  fresh.id  = 'driveVideo';
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('preload', 'metadata');
  if (myRole === 'host') fresh.setAttribute('controls', '');
  fresh.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; background:#000;';
  fresh.src = src;
  old.parentNode.replaceChild(fresh, old);
  fresh.load();
  setupVideoListeners(fresh);
  videoType = 'html5';
  getEl('playerControls').style.display = myRole === 'host' ? 'flex' : 'none';
}

function setupVideoListeners(video) {
  video.addEventListener('play', function() {
    if (applyingRemote || myRole !== 'host') return;
    isPlaying = true; updatePlayBtn();
    pushState({ playing: true, position: video.currentTime, playedAt: Date.now() });
  });

  video.addEventListener('pause', function() {
    if (applyingRemote || myRole !== 'host') return;
    if (document.visibilityState === 'hidden') return;
    isPlaying = false; updatePlayBtn();
    pushState({ playing: false, position: video.currentTime, playedAt: null });
  });

  video.addEventListener('seeked', function() {
    if (applyingRemote || myRole !== 'host') return;
    currentRawTime = video.currentTime;
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(function() {
      pushState({ playing: !video.paused, position: video.currentTime, playedAt: !video.paused ? Date.now() : null });
      setSyncStatus('position shared ✓');
    }, 200);
  });

  video.addEventListener('timeupdate', function() {
    currentRawTime = video.currentTime;
    getEl('timeDisplay').textContent = fmtTime(video.currentTime);
  });

  video.addEventListener('error', function() {
    addLocalMsg('system', '', 'Could not load video. Check the link is accessible.');
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
      addLocalMsg('system', '', '▶ Tap the video to play');
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
    if (v.readyState >= 1) { v.currentTime = t; }
    else { v.addEventListener('loadedmetadata', function onMeta() { v.removeEventListener('loadedmetadata', onMeta); v.currentTime = t; }); }
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
        if (d.info === 1 && !applyingRemote && myRole === 'host') {
          isPlaying = true; updatePlayBtn();
          pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
        }
        if (d.info === 2 && !applyingRemote && myRole === 'host' && document.visibilityState !== 'hidden') {
          isPlaying = false; updatePlayBtn();
          pushState({ playing: false, position: currentRawTime, playedAt: null });
        }
      }
      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        prevTime       = currentRawTime;
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(currentRawTime);
        if (!applyingRemote && myRole === 'host' && Math.abs(currentRawTime - (prevTime + 0.6)) > 2) {
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
  if (myRole !== 'host') return;
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
