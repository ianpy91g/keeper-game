/* 守門員大作戰（網頁版）— 頁面啟動：畫面縮放、觸控、鍵盤、Web Bluetooth 健身趣（兩支握力環）、存檔。 */
(function () {
  'use strict';
  // 健身趣（智能握力環 Fit 100，藍牙名稱 FUNFITGRIP）的協定（實測解出）：
  //   寫入 FFF2：0x05＝查詢狀態，要每 0.2 秒左右送一次，握力環才會持續回報
  //   通知 FFF1：0c 01＝握下、0c 00＝放開；04／0b 開頭的狀態訊息第 5 個位元組是次數
  var SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
  var NOTIFY_CHAR = '0000fff1-0000-1000-8000-00805f9b34fb';
  var WRITE_CHAR = '0000fff2-0000-1000-8000-00805f9b34fb';
  var NAME = 'FUNFITGRIP';
  var W = KeeperGame.W, H = KeeperGame.H;
  var canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
  var scale = 1, dpr = 1;
  var bt = !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

  var STORE_KEY = 'keeperGame.v1', RING_KEY = 'keeperGame.rings';
  var storage = {
    get: function () { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem(STORE_KEY, v); } catch (e) { } }
  };
  function loadRingIds() { try { return JSON.parse(localStorage.getItem(RING_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveRingIds() {
    var o = {};
    if (rings.L.device) o.L = rings.L.device.id;
    if (rings.R.device) o.R = rings.R.device.id;
    try { localStorage.setItem(RING_KEY, JSON.stringify(o)); } catch (e) { }
  }

  // ---------- 兩支握力環 ----------
  function newRing(side) {
    return { side: side, device: null, connected: false, busy: false, status: bt ? '尚未連線' : '瀏覽器不支援藍牙',
             attempt: 0, retryTimer: null, pollTimer: null, writeChar: null, pressed: false, lastCount: null, writing: false };
  }
  var rings = { L: newRing('L'), R: newRing('R') };
  var game;   // 下面建立

  function errText(e) { return e ? (e.name || '') + ' ' + (e.message || e) : '未知錯誤'; }
  function withTimeout(p, ms, what) {   // iPad 的連線請求不會自己逾時：每一步都加時間限制
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject({ name: 'Timeout', message: what + '超過 ' + ms / 1000 + ' 秒沒有回應' }); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function stopPoll(r) { clearInterval(r.pollTimer); r.pollTimer = null; r.writeChar = null; }
  function cancelPending(r) { stopPoll(r); try { if (r.device) r.device.gatt.disconnect(); } catch (e) { } }

  function onNotify(r, dv) {
    if (dv.byteLength < 2) return;
    var b0 = dv.getUint8(0), b1 = dv.getUint8(1);
    if (b0 === 0x0c) {
      if (b1 === 0x01 && !r.pressed) { r.pressed = true; game.press(r.side); }
      else if (b1 === 0x00) r.pressed = false;
      return;
    }
    // 剛連線時第一次的 0c 01 可能漏掉：次數增加也當作握下
    if ((b0 === 0x04 || b0 === 0x0b) && dv.byteLength >= 5) {
      var count = dv.getUint8(4);
      if (r.lastCount !== null && count > r.lastCount && !r.pressed) { r.pressed = true; game.press(r.side); }
      r.lastCount = count;
    }
  }

  // 每 0.2 秒送一次 0x05；上一次還沒寫完就跳過，避免 iPad 回報「GATT 操作進行中」
  function startPoll(r) {
    stopPoll(r);
    var cmd = new Uint8Array([0x05]);
    r.pollTimer = setInterval(function () {
      if (!r.writeChar || r.writing) return;
      r.writing = true;
      var w = r.writeChar.writeValueWithoutResponse ? r.writeChar.writeValueWithoutResponse(cmd) : r.writeChar.writeValue(cmd);
      w.then(function () { r.writing = false; }, function () { r.writing = false; });
    }, 200);
  }

  function attach(r, id) {
    var dev = r.device;
    r.busy = true;
    r.status = '連線中…';
    var current = function () { if (id !== r.attempt) throw { name: 'Superseded', message: '已被新的連線取代' }; };
    var svc;
    return withTimeout(dev.gatt.connect(), 10000, '連線')
      .then(function (server) { current(); return withTimeout(server.getPrimaryService(SERVICE), 6000, '讀取服務'); })
      .then(function (s) { current(); svc = s; return withTimeout(svc.getCharacteristic(NOTIFY_CHAR), 6000, '讀取通知通道'); })
      .then(function (ch) {
        current();
        if (!ch._keeperHooked) { ch._keeperHooked = true; ch.addEventListener('characteristicvaluechanged', function (e) { onNotify(r, e.target.value); }); }
        return withTimeout(ch.startNotifications(), 6000, '開始接收');
      })
      .then(function () { current(); return withTimeout(svc.getCharacteristic(WRITE_CHAR), 6000, '讀取指令通道'); })
      .then(function (wc) {
        current();
        r.writeChar = wc; r.pressed = false; r.lastCount = null;
        startPoll(r);
        r.busy = false; r.connected = true; r.status = '已連線';
        saveRingIds();
      }, function (e) {
        if (id === r.attempt) { r.busy = false; cancelPending(r); }
        throw e;
      });
  }
  function reconnect(r) {   // 斷線後在背景自動重連
    clearTimeout(r.retryTimer);
    if (!r.device || r.connected) return;
    if (r.busy) { r.retryTimer = setTimeout(function () { reconnect(r); }, 3000); return; }
    var id = ++r.attempt;
    attach(r, id).catch(function () {
      if (id !== r.attempt) return;
      r.status = '斷線，重新連線中…（握一下喚醒它）';
      r.retryTimer = setTimeout(function () { reconnect(r); }, 4000);
    });
  }
  function hook(r) {
    var dev = r.device;
    if (dev._keeperHooked) return;
    dev._keeperHooked = true;
    dev.addEventListener('gattserverdisconnected', function () {
      if (rings[r.side].device !== dev) return;
      r.connected = false; r.pressed = false; stopPoll(r);
      if (r.busy) return;
      r.status = '斷線，重新連線中…';
      clearTimeout(r.retryTimer);
      r.retryTimer = setTimeout(function () { reconnect(r); }, 1500);
    });
  }
  // 連接左手／右手：必須在使用者觸碰的事件裡呼叫（requestDevice 需要使用者手勢）
  function connectRing(side) {
    var r = rings[side], other = rings[side === 'L' ? 'R' : 'L'];
    if (!bt) { r.status = '不支援藍牙：iPad 請用 Bluefy 開啟'; return; }
    clearTimeout(r.retryTimer);
    var id = ++r.attempt;
    r.busy = false; r.connected = false;
    cancelPending(r);
    r.status = '請在清單選擇要當' + (side === 'L' ? '左手' : '右手') + '的 FUNFITGRIP';
    navigator.bluetooth.requestDevice({ filters: [{ namePrefix: NAME }, { services: [SERVICE] }], optionalServices: [SERVICE] })
      .then(function (dev) {
        if (id !== r.attempt) return;
        if (other.device && other.device.id === dev.id) {   // 選到另一隻手已經在用的那支
          r.status = '這支已經是' + (side === 'L' ? '右手' : '左手') + '了，請選另一支';
          return;
        }
        r.device = dev; hook(r);
        return attach(r, id);
      })
      .catch(function (e) {
        if (id !== r.attempt) return;
        r.busy = false;
        r.status = e && e.name === 'NotFoundError' ? '沒有選到：握一下喚醒握力環再試一次' : '連線失敗：' + errText(e);
      });
  }

  // 重新整理網頁時，Bluefy 會在底層維持連線，握力環就不會出現在新網頁的選擇清單裡：離開前主動斷線
  function release() {
    ['L', 'R'].forEach(function (s) { rings[s].attempt++; clearTimeout(rings[s].retryTimer); cancelPending(rings[s]); });
  }
  window.addEventListener('pagehide', release);
  window.addEventListener('beforeunload', release);

  // 打開網頁就找回之前設定過的左右手（瀏覽器支援 getDevices 時），不用再選
  if (bt && navigator.bluetooth.getDevices) {
    navigator.bluetooth.getDevices().then(function (list) {
      var ids = loadRingIds();
      ['L', 'R'].forEach(function (side) {
        var r = rings[side];
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === ids[side] && !r.device) {
            r.device = list[i]; hook(r);
            r.status = '找到之前的' + (side === 'L' ? '左手' : '右手') + '，自動連線中…';
            (function (r) {
              var id = ++r.attempt;
              attach(r, id).catch(function () {
                if (id !== r.attempt) return;
                r.status = '自動連線失敗：握一下握力環，再按「連接」';
              });
            })(r);
          }
        }
      });
    }, function () { /* 不支援或沒有授權過的裝置 */ });
  }

  game = new KeeperGame.Game({ rings: rings, storage: storage, connectRing: connectRing, bluetoothSupported: bt });

  // ---------- 音效：iOS 要在第一次觸碰時建立 ----------
  var audioReady = false;
  function unlockAudio() {
    if (audioReady) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      var ac = new AC();
      var b = ac.createBuffer(1, 1, 22050), s = ac.createBufferSource();
      s.buffer = b; s.connect(ac.destination); s.start(0);
      if (ac.resume) ac.resume();
      game.setAudio(ac);
      audioReady = true;
    } catch (e) { }
  }

  // ---------- 畫面縮放（等比例，高度跟著螢幕比例，不留上下黑邊） ----------
  function resize() {
    var vw = window.innerWidth, vh = window.innerHeight;
    H = KeeperGame.setHeight(W * vh / vw);
    scale = Math.min(vw / W, vh / H);
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // iPad Air 2 繪圖量少一半，畫質幾乎看不出差別
    var cw = Math.round(W * scale), ch = Math.round(H * scale);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.style.marginLeft = (-cw / 2) + 'px'; canvas.style.marginTop = (-ch / 2) + 'px';
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    document.getElementById('rotate').style.display = vh > vw * 1.1 && !resize.dismissed ? 'flex' : 'none';
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 300); });
  document.getElementById('rotate').addEventListener('click', function () { resize.dismissed = true; resize(); });
  resize();

  function toLogical(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  }
  function playing() { var s = game.state; return s === 'runup' || s === 'flight' || s === 'result' || s === 'intro'; }

  // ---------- 觸控：比賽中手指一碰就撲（不等放開）；選單等畫面在放開時才算點按鈕（藍牙要求使用者手勢） ----------
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    unlockAudio();
    if (!playing()) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], p = toLogical(t.clientX, t.clientY);
      game.tap(p.x, p.y);
    }
  }, { passive: false });
  canvas.addEventListener('touchend', function (e) {
    e.preventDefault();
    if (playing()) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], p = toLogical(t.clientX, t.clientY);
      game.tap(p.x, p.y);
    }
  }, { passive: false });

  // 滑鼠（電腦測試用）
  canvas.addEventListener('mousedown', function (e) {
    unlockAudio();
    var p = toLogical(e.clientX, e.clientY);
    game.tap(p.x, p.y);
  });
  window.addEventListener('keydown', function (e) {
    unlockAudio();
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    if (!e.repeat) game.key(e.code, true);
  });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });   // 防止雙指縮放

  // ---------- 主迴圈 ----------
  var last = 0;
  function frame(t) {
    var dt = last ? Math.min((t - last) / 1000, 0.05) : 0.016;
    last = t;
    game.update(dt);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    game.draw(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
