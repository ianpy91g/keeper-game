/* 守門員大作戰（網頁版）— 遊戲本體。
 * 用兩支健身趣（智能握力環 FUNFITGRIP）當左右手：握右手往右撲、握左手往左撲。
 * 連續撲到 10 球存一次大招「重影」，兩手一起握下使出，左右的球都擋得住。
 * 共 10 關，球速越來越快；第 3 關起偶爾雙球、第 6 關起有會轉向的變化球。
 * 不直接碰 DOM：由 app.js 提供 env（握力環狀態、存檔、音效、連線），所以也能在 Node 裡測試。
 * iPad iOS 12（Bluefy）相容：不用 ?. ?? 、class 欄位、Array.at、roundRect 等新語法。
 */
(function (root) {
  'use strict';

  var VERSION = '2026.10.23-3';   // 每次發佈都改，畫面右下角會顯示
  var W = 960, H = 720, H_MIN = 540, H_MAX = 760;
  var FONT = '"PingFang TC", "Heiti TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  var TEXT = [240, 238, 245], DIM = [160, 165, 180], GOLD = [255, 205, 70], GREEN = [96, 220, 150], RED = [255, 90, 90], CYAN = [110, 220, 255];

  var NUM_LEVELS = 10, SHOTS_PER_LEVEL = 10, HEARTS = 3, STREAK_FOR_SUPER = 10, MAX_SUPER = 3;
  var BOTH_WINDOW = 0.25;   // 兩手在這個秒數內先後握下＝一起握
  var RUNUP = 1.0, RESULT_TIME = 1.1, DIVE_TIME = 0.28;

  // 第 L 關（1～10）的參數
  function levelParams(L) {
    return {
      flight: 1.5 - (L - 1) * 0.09,                       // 球從罰球點飛到球門的秒數：1.5 → 0.69
      double: L >= 3 ? Math.min(0.35, 0.15 + (L - 3) * 0.03) : 0,  // 雙球機率（只在手上有大招時）
      curve: L >= 6 ? Math.min(0.6, 0.25 + (L - 6) * 0.09) : 0     // 變化球機率
    };
  }

  // ---------- 小工具 ----------
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(x, lo, hi) { if (lo === undefined) { lo = 0; hi = 1; } return Math.max(lo, Math.min(hi, x)); }
  function rgb(c, a) { return a === undefined ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function ellipse(ctx, cx, cy, rx, ry, fill) {
    ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function bezier(p0, c, p1, t) {
    var u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
  }

  // ---------- 音效（Web Audio，程式合成） ----------
  function Sfx(ac) {
    this.ac = ac || null; this.buf = {};
    if (!this.ac) return;
    var rate = this.ac.sampleRate, self = this;
    function noise(dur, decay, vol, lp) {
      var o = [], last = 0;
      for (var i = 0; i < rate * dur; i++) { var v = Math.random() * 2 - 1; last = lp ? last + (v - last) * lp : v; o.push(last * vol * Math.exp(-decay * i / rate)); }
      return o;
    }
    function tone(dur, f, decay, vol) { var o = []; for (var i = 0; i < rate * dur; i++) o.push(Math.sin(2 * Math.PI * f * i / rate) * vol * Math.exp(-decay * i / rate)); return o; }
    function sweep(dur, f0, f1, vol) { var o = [], ph = 0, n = rate * dur; for (var i = 0; i < n; i++) { ph += 2 * Math.PI * lerp(f0, f1, i / n) / rate; o.push(Math.sin(ph) * vol * (1 - i / n)); } return o; }
    function melody(notes, dur, vol) { var o = []; notes.forEach(function (f) { o = o.concat(tone(dur, f, 6, vol)); }); return o; }
    function crowd(dur, vol) {   // 觀眾歡呼：慢慢變大再退去的低通雜訊
      var o = [], last = 0, n = rate * dur;
      for (var i = 0; i < n; i++) { var v = Math.random() * 2 - 1; last += (v - last) * 0.08; o.push(last * vol * Math.sin(Math.PI * i / n)); }
      return o;
    }
    function mix(a, b) { var n = Math.max(a.length, b.length), o = []; for (var i = 0; i < n; i++) o.push((a[i] || 0) + (b[i] || 0)); return o; }
    function make(s) { var b = self.ac.createBuffer(1, s.length, rate), d = b.getChannelData(0); for (var i = 0; i < s.length; i++) d[i] = clamp(s[i], -1, 1); return b; }
    this.buf.kick = make(mix(tone(0.18, 90, 25, 0.7), noise(0.06, 60, 0.4, 0.5)));
    this.buf.dive = make(noise(0.22, 14, 0.25, 0.2));
    this.buf.save = make(mix(mix(tone(0.12, 180, 30, 0.6), noise(0.08, 40, 0.5, 0.6)), crowd(1.2, 1.4)));
    this.buf.goal = make(mix(noise(0.35, 8, 0.35, 0.15), sweep(0.5, 220, 110, 0.25)));
    this.buf.whistle = make(sweep(0.35, 2600, 2400, 0.22));
    this.buf.super = make(mix(sweep(0.5, 400, 1600, 0.25), sweep(0.5, 600, 2000, 0.15)));
    this.buf.charge = make(melody([784, 988, 1175, 1568], 0.08, 0.28));
    this.buf.clear = make(melody([523, 659, 784, 1047, 784, 1047], 0.12, 0.3));
    this.buf.fail = make(melody([392, 330, 262, 196], 0.16, 0.28));
    this.buf.tap = make(tone(0.05, 880, 40, 0.2));
  }
  Sfx.prototype.play = function (name) {
    if (!this.ac || !this.buf[name]) return;
    try { var s = this.ac.createBufferSource(); s.buffer = this.buf[name]; s.connect(this.ac.destination); s.start(0); } catch (e) { }
  };

  // 背景音樂：C 大調輕快的足球場風 8 小節循環（C → G → Am → F），null = 延長前一個音
  var MELODY = [
    72, null, 76, 79, null, 76, 74, 72,    74, null, 71, 74, null, 79, 77, 74,
    76, null, 72, 76, null, 81, 79, 76,    77, null, 76, 74, null, 72, 74, null,
    72, 72, 76, null, 79, null, 84, null,  83, null, 79, 74, null, 71, 74, null,
    76, 77, 79, null, 76, 74, 72, null,    74, null, 76, 74, 72, null, null, null
  ];
  var BASS = [48, 43, 45, 41, 48, 43, 45, 41];
  var BPM = 124;
  function Music(ac) {
    this.ac = ac; this.enabled = false; this.step = 0; this.next = 0;
    this.master = ac.createGain(); this.master.gain.value = 0; this.master.connect(ac.destination);
    var n = Math.floor(ac.sampleRate * 0.05), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n / 6));
    this.noise = b;
  }
  Music.VOLUME = 0.1;
  Music.prototype.setEnabled = function (on) {
    this.enabled = on;
    var t = this.ac.currentTime, self = this;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? Music.VOLUME : 0, t, 0.2);
    clearInterval(this.timer); this.timer = null;
    if (on) { this.next = t + 0.1; this.timer = setInterval(function () { self.tick(); }, 50); }
  };
  Music.prototype.note = function (type, midi, t, dur, vol) {
    var o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  };
  Music.prototype.drum = function (t) {
    var o = this.ac.createOscillator(), g = this.ac.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.2);
  };
  Music.prototype.hat = function (t, vol) {
    var s = this.ac.createBufferSource(), g = this.ac.createGain(), f = this.ac.createBiquadFilter();
    s.buffer = this.noise; f.type = 'highpass'; f.frequency.value = 6500; g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t);
  };
  Music.prototype.tick = function () {
    if (!this.enabled) return;
    var now = this.ac.currentTime, eighth = 60 / BPM / 2;
    if (this.next < now - 0.3) this.next = now + 0.05;
    while (this.next < now + 0.5) {
      var t = this.next, st = this.step, bar = Math.floor(st / 8) % 8, inBar = st % 8, m = MELODY[st];
      if (m !== null) {
        var len = 1;
        while (len < 4 && MELODY[(st + len) % MELODY.length] === null) len++;
        this.note('square', m, t, eighth * len * 0.9, 0.12);
      }
      if (inBar % 2 === 0) this.note('triangle', inBar % 4 === 0 ? BASS[bar] : BASS[bar] + 7, t, eighth * 1.8, 0.5);
      if (inBar === 0 || inBar === 4) this.drum(t);
      if (inBar % 2 === 1) this.hat(t, 0.18);
      this.step = (st + 1) % MELODY.length;
      this.next += eighth;
    }
  };

  // ---------- 遊戲 ----------
  /* env：{ rings: {L:{connected,status,pressedAt}, R:{...}}, storage:{get,set}, connectRing(side), bluetoothSupported, random } */
  function Game(env) {
    this.env = env;
    this.rand = env.random || Math.random;
    this.sfx = new Sfx(null); this.music = null;
    this.t = 0;
    this.state = 'menu'; this.stateT = 1;
    this.buttons = [];
    var saved = {};
    try { saved = JSON.parse(env.storage.get() || '{}') || {}; } catch (e) { }
    this.best = saved.best || 0;
    this.bestLevel = saved.bestLevel || 0;
    this.musicOn = saved.music !== false;
    this.lastPress = { L: -9, R: -9 };
    this.flash = { L: 0, R: 0 };
    this.particles = [];
    this.newGame();
  }

  Game.prototype.save = function () {
    try { this.env.storage.set(JSON.stringify({ best: this.best, bestLevel: this.bestLevel, music: this.musicOn })); } catch (e) { }
  };

  Game.prototype.setAudio = function (ac) {
    this.sfx = new Sfx(ac);
    try { this.music = new Music(ac); this.music.setEnabled(this.musicOn); } catch (e) { this.music = null; }
  };
  Game.prototype.toggleMusic = function () {
    this.musicOn = !this.musicOn;
    if (this.music) this.music.setEnabled(this.musicOn);
    this.save();
  };

  Game.prototype.newGame = function () {
    this.score = 0; this.level = 1; this.streak = 0; this.supers = 0;
    this.totalSaves = 0; this.totalShots = 0;
    this.resetLevel();
  };
  Game.prototype.resetLevel = function () {
    this.shot = 0; this.hearts = HEARTS; this.levelSaves = 0;
    this.balls = []; this.dive = null; this.superActive = false; this.result = null;
  };

  // ---------- 狀態切換 ----------
  Game.prototype.go = function (state) { this.state = state; this.stateT = 0; };
  Game.prototype.startLevel = function () { this.resetLevel(); this.go('intro'); this.sfx.play('whistle'); };
  Game.prototype.nextShot = function () {
    if (this.shot >= SHOTS_PER_LEVEL) return this.levelCleared();
    this.shot++;
    this.balls = []; this.dive = null; this.superActive = this.superQueued || false; this.superQueued = false;
    this.result = null;
    var p = levelParams(this.level), r = this.rand;
    var dbl = this.supers > 0 && r() < p.double;   // 雙球只在手上有大招時出現：這時就是使出重影的時機
    var sides = dbl ? [-1, 1] : [r() < 0.5 ? -1 : 1];
    var self = this;
    sides.forEach(function (side) {
      var curve = !dbl && r() < p.curve;
      self.balls.push({ side: side, fake: curve ? -side : side, curve: curve, targetY: lerp(0.25, 0.8, r()), spin: (r() - 0.5) * 30, done: false });
    });
    this.flight = p.flight;
    this.go('runup');
  };
  Game.prototype.levelCleared = function () {
    var bonus = this.hearts * 300 * this.level;
    this.score += bonus; this.clearBonus = bonus;
    if (this.level > this.bestLevel) this.bestLevel = this.level;
    if (this.score > this.best) this.best = this.score;
    this.save();
    this.sfx.play('clear');
    this.go(this.level >= NUM_LEVELS ? 'win' : 'clear');
  };
  Game.prototype.levelFailed = function () {
    if (this.score > this.best) this.best = this.score;
    this.save();
    this.sfx.play('fail');
    this.go('fail');
  };

  // ---------- 輸入 ----------
  // 握右手／左手（或觸控、鍵盤）都呼叫 press('R' / 'L')
  Game.prototype.press = function (side) {
    var other = side === 'L' ? 'R' : 'L';
    var both = this.t - this.lastPress[other] <= BOTH_WINDOW;
    this.lastPress[side] = this.t;
    this.flash[side] = 1;
    if (this.state === 'runup' || this.state === 'flight') {
      if (both && this.supers > 0 && !this.superActive) return this.useSuper();
      if (!this.dive) {
        this.dive = { side: side === 'L' ? -1 : 1, t: 0 };
        this.sfx.play('dive');
      }
      return;
    }
    if (this.state === 'result' && both && this.supers > 0 && !this.superQueued) {   // 結果畫面時使出：保留給下一球
      this.supers--; this.superQueued = true; this.sfx.play('super');
      return;
    }
    this.advance();   // 其他畫面：握一下＝下一步
  };
  Game.prototype.pressBoth = function () { this.press('L'); this.press('R'); };
  Game.prototype.useSuper = function () {
    this.supers--;
    this.superActive = true;
    this.superT = 0;
    this.sfx.play('super');
  };
  // 選單、過關、失敗畫面的「下一步」
  Game.prototype.advance = function () {
    if (this.stateT < 0.6) return;   // 剛切換畫面時不要被連按誤觸
    if (this.state === 'menu') { this.newGame(); this.startLevel(); }
    else if (this.state === 'intro') this.nextShot();
    else if (this.state === 'clear') { this.level++; this.startLevel(); }
    else if (this.state === 'fail') this.startLevel();
    else if (this.state === 'win') this.go('menu');
  };

  Game.prototype.key = function (code, down) {
    if (!down) return;
    if (code === 'ArrowLeft' || code === 'KeyA') this.press('L');
    else if (code === 'ArrowRight' || code === 'KeyD') this.press('R');
    else if (code === 'ArrowUp' || code === 'Space' || code === 'KeyW') this.pressBoth();
    else if (code === 'Enter') this.advance();
    else if (code === 'KeyM') this.toggleMusic();
    else if (code === 'Escape' && this.state !== 'menu') this.go('menu');
  };

  // 觸控／滑鼠點擊：先看有沒有點到按鈕；遊戲中點左右半邊＝撲左右
  Game.prototype.tap = function (x, y) {
    for (var i = 0; i < this.buttons.length; i++) {
      var b = this.buttons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { this.sfx.play('tap'); b.fn(); return; }
    }
    if (this.state === 'menu') return;
    this.press(x < W / 2 ? 'L' : 'R');
  };

  // ---------- 更新 ----------
  Game.prototype.update = function (dt) {
    this.t += dt;
    this.stateT = (this.stateT || 0) + dt;
    this.flash.L = Math.max(0, this.flash.L - dt * 3);
    this.flash.R = Math.max(0, this.flash.R - dt * 3);
    if (this.dive) this.dive.t += dt;
    if (this.superActive) this.superT += dt;
    var s = this.state;
    if (s === 'intro' && this.stateT > 2.2) this.nextShot();
    else if (s === 'runup' && this.stateT >= RUNUP) { this.go('flight'); this.sfx.play('kick'); }
    else if (s === 'flight' && this.stateT >= this.flight) this.resolve();
    else if (s === 'result' && this.stateT >= RESULT_TIME) {
      if (this.hearts <= 0) this.levelFailed();
      else this.nextShot();
    }
    else if ((s === 'clear') && this.stateT > 3.5) { this.level++; this.startLevel(); }
    // 粒子
    for (var i = this.particles.length - 1; i >= 0; i--) {
      var p = this.particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 600 * dt; p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  };

  // 球到達球門：判定撲到或被踢進
  Game.prototype.resolve = function () {
    var saved = 0, conceded = 0, self = this;
    this.balls.forEach(function (b) {
      b.done = true;
      b.saved = self.superActive || (self.dive && self.dive.side === b.side);
      if (b.saved) saved++; else conceded++;
      self.totalShots++;
    });
    this.result = { saved: saved, conceded: conceded, superUsed: this.superActive };
    if (conceded) {
      this.hearts--;
      this.streak = 0;
      this.sfx.play('goal');
    } else {
      this.sfx.play('save');
    }
    if (saved) {
      this.totalSaves += saved; this.levelSaves += saved;
      this.score += saved * 100 * this.level + (this.superActive && saved > 1 ? 200 * this.level : 0);
      if (!conceded) {
        var before = this.streak;
        this.streak += saved;
        // 每連續撲到 10 球存一次大招
        if (Math.floor(this.streak / STREAK_FOR_SUPER) > Math.floor(before / STREAK_FOR_SUPER) && this.supers < MAX_SUPER) {
          this.supers++;
          this.result.charged = true;
          this.sfx.play('charge');
        }
      }
      var g = this.geom();
      this.balls.forEach(function (b) {
        if (!b.saved) return;
        var end = self.ballTarget(b, g);
        for (var i = 0; i < 14; i++) self.particles.push({ x: end.x, y: end.y, vx: (self.rand() - 0.5) * 420, vy: -self.rand() * 380, life: 0.6, c: b.side < 0 ? GOLD : CYAN });
      });
    }
    if (this.score > this.best) this.best = this.score;
    this.go('result');
  };

  // ---------- 版面 ----------
  Game.prototype.geom = function () {
    var k = H / 720;
    var top = Math.round(H * 0.17), bottom = Math.round(H * 0.17 + 250 * k);
    return { k: k, gx0: 170, gx1: 790, gTop: top, gBot: bottom, spotY: Math.round(H - 105 * k), cx: W / 2 };
  };
  Game.prototype.ballTarget = function (b, g) {
    return { x: g.cx + b.side * 200, y: lerp(g.gTop + 30 * g.k, g.gBot - 18 * g.k, b.targetY) };
  };
  // 球在飛行中的位置與大小：二次貝茲曲線；變化球的控制點偏到另一邊，看起來先往假的方向再轉回來
  Game.prototype.ballPos = function (b, t, g) {
    var p0 = { x: g.cx, y: g.spotY }, p1 = this.ballTarget(b, g);
    var c = b.curve ? { x: g.cx + b.fake * 330, y: lerp(p0.y, p1.y, 0.55) } : { x: lerp(p0.x, p1.x, 0.5), y: lerp(p0.y, p1.y, 0.5) - 60 * g.k };
    var p = bezier(p0, c, p1, t);
    return { x: p.x, y: p.y - Math.sin(Math.PI * t) * 30 * g.k, r: lerp(24, 10, easeOutCubic(t)) * g.k };
  };

  // ---------- 繪圖 ----------
  Game.prototype.text = function (ctx, s, size, color, x, y, o) {
    o = o || {};
    ctx.font = (o.weight || 'bold') + ' ' + size + 'px ' + FONT;
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = 'middle';
    if (o.shadow !== false) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(s, x + 1.5, y + 2); }
    ctx.fillStyle = rgb(color, o.alpha);
    ctx.fillText(s, x, y);
  };
  // 超過寬度就換行（最多兩行），狀態訊息比較長時用
  Game.prototype.wrapText = function (ctx, s, size, color, x, y, maxW) {
    ctx.font = 'normal ' + size + 'px ' + FONT;
    var lines = [''], i;
    for (i = 0; i < s.length; i++) {
      var tryLine = lines[lines.length - 1] + s.charAt(i);
      if (ctx.measureText(tryLine).width > maxW && lines.length < 2) lines.push(s.charAt(i)); else lines[lines.length - 1] = tryLine;
    }
    for (i = 0; i < lines.length; i++) this.text(ctx, lines[i], size, color, x, y + (i - (lines.length - 1) / 2) * (size + 4), { weight: 'normal' });
  };
  Game.prototype.button = function (ctx, label, x, y, w, h, fn, o) {
    o = o || {};
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = o.fill || 'rgba(255,255,255,0.12)'; ctx.fill();
    ctx.strokeStyle = o.stroke || 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.stroke();
    this.text(ctx, label, o.size || 20, o.color || TEXT, x + w / 2, y + h / 2 + 1);
    this.buttons.push({ x: x, y: y, w: w, h: h, fn: fn });
  };

  Game.prototype.draw = function (ctx) {
    this.buttons = [];
    var g = this.geom();
    this.drawStadium(ctx, g);
    this.drawGoal(ctx, g);
    var s = this.state;
    if (s === 'menu') return this.drawMenu(ctx, g);
    this.drawKeeper(ctx, g);
    this.drawShooter(ctx, g);
    this.drawBalls(ctx, g);
    this.drawParticles(ctx);
    this.drawHud(ctx, g);
    if (s === 'intro') this.drawIntro(ctx, g);
    else if (s === 'result') this.drawResult(ctx, g);
    else if (s === 'clear' || s === 'fail' || s === 'win') this.drawEnd(ctx, g);
    this.drawRings(ctx);
  };

  // 看台、觀眾、草地
  Game.prototype.drawStadium = function (ctx, g) {
    var sky = ctx.createLinearGradient(0, 0, 0, g.gTop);
    sky.addColorStop(0, '#0b1730'); sky.addColorStop(1, '#1d3561');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, g.gTop + 10);
    // 觀眾（固定亂數點）
    if (!this.crowd || this.crowdH !== H) {
      this.crowdH = H; this.crowd = [];
      var seed = 7;
      for (var i = 0; i < 420; i++) {
        seed = (seed * 16807) % 2147483647;
        var a = seed / 2147483647;
        seed = (seed * 16807) % 2147483647;
        var b = seed / 2147483647;
        this.crowd.push({ x: a * W, y: lerp(g.gTop * 0.35, g.gTop + 5, b), c: [[220, 70, 70], [70, 120, 220], [240, 240, 240], [250, 200, 60], [90, 180, 110]][Math.floor(a * 997) % 5] });
      }
    }
    var cheer = this.state === 'result' && this.result && !this.result.conceded ? Math.sin(this.stateT * 30) * 2 : 0;
    for (var j = 0; j < this.crowd.length; j++) {
      var c = this.crowd[j];
      ellipse(ctx, c.x, c.y + (j % 2 ? cheer : -cheer), 4, 5, rgb(c.c, 0.75));
    }
    // 燈光
    for (var l = 0; l < 2; l++) {
      var lx = l ? W - 60 : 60;
      var glow = ctx.createRadialGradient(lx, 20, 2, lx, 20, 90);
      glow.addColorStop(0, 'rgba(255,255,230,0.9)'); glow.addColorStop(1, 'rgba(255,255,230,0)');
      ctx.fillStyle = glow; ctx.fillRect(lx - 90, 0, 180, 110);
    }
    // 草地（條紋，往下越寬）
    var grassTop = g.gTop + 6;
    for (var s = 0; s < 9; s++) {
      var y0 = lerp(grassTop, H, Math.pow(s / 9, 1.6)), y1 = lerp(grassTop, H, Math.pow((s + 1) / 9, 1.6));
      ctx.fillStyle = s % 2 ? '#2f8a3e' : '#349846';
      ctx.fillRect(0, y0, W, y1 - y0 + 1);
    }
    // 禁區線
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 3 * g.k;
    ctx.beginPath();
    ctx.moveTo(g.gx0 - 120, g.gBot + 4); ctx.lineTo(g.gx1 + 120, g.gBot + 4);
    ctx.moveTo(g.gx0 - 60, g.gBot + 4); ctx.lineTo(g.gx0 - 150, g.gBot + 70 * g.k);
    ctx.lineTo(g.gx1 + 150, g.gBot + 70 * g.k); ctx.lineTo(g.gx1 + 60, g.gBot + 4);
    ctx.stroke();
    ellipse(ctx, g.cx, g.spotY + 6 * g.k, 7 * g.k, 3.5 * g.k, 'rgba(255,255,255,0.85)');
  };

  // 球門與球網（被踢進時網子鼓起）
  Game.prototype.drawGoal = function (ctx, g) {
    var bulge = 0, bx = g.cx;
    if (this.state === 'result' && this.result && this.result.conceded) {
      var self = this;
      this.balls.forEach(function (b) { if (!b.saved) bx = self.ballTarget(b, g).x; });
      bulge = Math.sin(Math.min(1, this.stateT * 3) * Math.PI) * 14;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(g.gx0, g.gTop, g.gx1 - g.gx0, g.gBot - g.gTop);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
    for (var x = g.gx0; x <= g.gx1; x += 20) {
      var d = bulge * Math.exp(-Math.pow((x - bx) / 70, 2));
      ctx.beginPath(); ctx.moveTo(x, g.gTop); ctx.quadraticCurveTo(x, (g.gTop + g.gBot) / 2 - d, x, g.gBot); ctx.stroke();
    }
    for (var y = g.gTop; y <= g.gBot; y += 18) {
      ctx.beginPath(); ctx.moveTo(g.gx0, y); ctx.lineTo(g.gx1, y); ctx.stroke();
    }
    // 門柱
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(g.gx0 - 9, g.gTop - 9, 9, g.gBot - g.gTop + 9);
    ctx.fillRect(g.gx1, g.gTop - 9, 9, g.gBot - g.gTop + 9);
    ctx.fillRect(g.gx0 - 9, g.gTop - 9, g.gx1 - g.gx0 + 18, 9);
  };

  // 守門員：站中間；撲出時往左右飛出去。重影時左右各出現一個半透明分身
  Game.prototype.drawKeeper = function (ctx, g) {
    var d = this.dive, side = 0, prog = 0;
    if (d) { side = d.side; prog = easeOutCubic(clamp(d.t / DIVE_TIME)); }
    if (this.state === 'result' && this.stateT > RESULT_TIME * 0.75) prog *= 1 - (this.stateT - RESULT_TIME * 0.75) / (RESULT_TIME * 0.25);
    if (this.superActive) {
      var a = 0.45 + 0.15 * Math.sin(this.t * 14), sp = easeOutCubic(clamp(this.superT / 0.2));
      this.drawKeeperBody(ctx, g, -1, sp, a, true);
      this.drawKeeperBody(ctx, g, 1, sp, a, true);
    }
    this.drawKeeperBody(ctx, g, side, prog, 1, false);
  };
  Game.prototype.drawKeeperBody = function (ctx, g, side, prog, alpha, ghost) {
    var k = g.k, footY = g.gBot - 4;
    var x = g.cx + side * 190 * prog, y = footY - 40 * k * prog;
    var ang = side * prog * 1.25;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(ang);
    var jersey = ghost ? 'rgb(110,220,255)' : '#f2b705', dark = ghost ? 'rgb(60,150,210)' : '#c78c00', skin = ghost ? 'rgb(170,235,255)' : '#f0c8a0';
    var glove = ghost ? 'rgb(220,250,255)' : '#ffffff';
    if (!ghost) ellipse(ctx, 0, 2, 34 * k, 8 * k, 'rgba(0,0,0,0.25)');
    // 腿
    ctx.strokeStyle = ghost ? 'rgb(60,150,210)' : '#1f2a44'; ctx.lineCap = 'round'; ctx.lineWidth = 15 * k;
    var spread = 18 + 20 * prog;
    ctx.beginPath(); ctx.moveTo(-10 * k, -62 * k); ctx.lineTo(-spread * k, 0); ctx.moveTo(10 * k, -62 * k); ctx.lineTo(spread * k, 0); ctx.stroke();
    // 身體
    roundRect(ctx, -28 * k, -120 * k, 56 * k, 64 * k, 14 * k);
    ctx.fillStyle = jersey; ctx.fill();
    ctx.fillStyle = dark; ctx.fillRect(-28 * k, -72 * k, 56 * k, 10 * k);
    // 手臂（撲出時往上伸）
    var armUp = lerp(0.35, 1.1, prog);
    ctx.strokeStyle = jersey; ctx.lineWidth = 13 * k;
    var ax = 46 * k, ay = -112 * k - 46 * k * armUp;
    ctx.beginPath(); ctx.moveTo(-22 * k, -112 * k); ctx.lineTo(-ax, ay); ctx.moveTo(22 * k, -112 * k); ctx.lineTo(ax, ay); ctx.stroke();
    ellipse(ctx, -ax, ay, 12 * k, 13 * k, glove);
    ellipse(ctx, ax, ay, 12 * k, 13 * k, glove);
    // 頭
    ellipse(ctx, 0, -138 * k, 17 * k, 18 * k, skin);
    if (!ghost) { ellipse(ctx, 0, -150 * k, 17 * k, 9 * k, '#3a2a1a'); }
    ctx.restore();
  };

  // 罰球的人（從背後看）：助跑往前，踢球後停住
  Game.prototype.drawShooter = function (ctx, g) {
    var k = g.k, s = this.state, run = 0;
    if (s === 'runup') run = clamp(this.stateT / RUNUP);
    else if (s === 'flight' || s === 'result') run = 1;
    var x = g.cx - 60 * k + 40 * k * run, y = H - 10 + (1 - run) * 30 * k, sc = 1.15 * k;
    var stride = s === 'runup' ? Math.sin(this.stateT * 18) * 10 : 0;
    ctx.save(); ctx.translate(x, y);
    ellipse(ctx, 0, 0, 32 * sc, 8 * sc, 'rgba(0,0,0,0.25)');
    ctx.strokeStyle = '#222'; ctx.lineCap = 'round'; ctx.lineWidth = 16 * sc;
    ctx.beginPath(); ctx.moveTo(-10 * sc, -60 * sc); ctx.lineTo((-14 + stride) * sc, 0); ctx.moveTo(10 * sc, -60 * sc); ctx.lineTo((14 - stride) * sc, run >= 1 ? -18 * sc : 0); ctx.stroke();
    roundRect(ctx, -26 * sc, -122 * sc, 52 * sc, 66 * sc, 12 * sc);
    ctx.fillStyle = '#c62828'; ctx.fill();
    this.text(ctx, '10', 22 * sc, [255, 255, 255], 0, -92 * sc, { shadow: false });
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 12 * sc;
    ctx.beginPath(); ctx.moveTo(-22 * sc, -112 * sc); ctx.lineTo(-36 * sc, -70 * sc); ctx.moveTo(22 * sc, -112 * sc); ctx.lineTo(36 * sc, -70 * sc); ctx.stroke();
    ellipse(ctx, 0, -140 * sc, 16 * sc, 17 * sc, '#3b2a1a');
    ctx.restore();
  };

  Game.prototype.drawBallAt = function (ctx, x, y, r, rot) {
    ellipse(ctx, x + r * 0.2, y + r * 1.1, r * 0.9, r * 0.3, 'rgba(0,0,0,0.25)');
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ellipse(ctx, 0, 0, r, r, '#fafafa');
    ctx.fillStyle = '#222';
    for (var i = 0; i < 5; i++) {
      var a = i * Math.PI * 2 / 5;
      ellipse(ctx, Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62, r * 0.2, r * 0.2, '#222');
    }
    ellipse(ctx, 0, 0, r * 0.28, r * 0.28, '#222');
    ctx.restore();
  };
  Game.prototype.drawBalls = function (ctx, g) {
    var s = this.state, self = this;
    if (s === 'runup' || s === 'intro') { this.drawBallAt(ctx, g.cx, g.spotY, 24 * g.k, 0); return; }
    if (s !== 'flight' && s !== 'result') return;
    this.balls.forEach(function (b) {
      if (s === 'flight') {
        var t = clamp(self.stateT / self.flight), p = self.ballPos(b, t, g);
        if (b.curve && t > 0.3) {   // 變化球：拖一條弧線提示
          ctx.strokeStyle = 'rgba(255,220,120,' + (0.5 * (t - 0.3)) + ')'; ctx.lineWidth = p.r * 0.8;
          ctx.beginPath();
          for (var q = Math.max(0, t - 0.25); q <= t; q += 0.02) { var pp = self.ballPos(b, q, g); if (q === Math.max(0, t - 0.25)) ctx.moveTo(pp.x, pp.y); else ctx.lineTo(pp.x, pp.y); }
          ctx.stroke();
        }
        self.drawBallAt(ctx, p.x, p.y, p.r, self.t * b.spin);
      } else {
        var end = self.ballTarget(b, g), r = 10 * g.k, u = clamp(self.stateT / 0.5);
        if (b.saved) self.drawBallAt(ctx, end.x + b.side * 120 * u, end.y - 60 * g.k * Math.sin(u * Math.PI) + 40 * u, r, self.t * 6);
        else self.drawBallAt(ctx, end.x, end.y - 4 * u, r * 0.95, 0);
      }
    });
  };
  Game.prototype.drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      ellipse(ctx, p.x, p.y, 4, 4, rgb(p.c, clamp(p.life / 0.6)));
    }
  };

  // ---------- 畫面上的資訊 ----------
  Game.prototype.drawHud = function (ctx, g) {
    // 左上：關卡與球數
    roundRect(ctx, 12, 10, 250, 64, 12); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
    this.text(ctx, '第 ' + this.level + ' 關', 24, TEXT, 24, 30, { align: 'left' });
    this.text(ctx, '第 ' + Math.max(1, this.shot) + ' / ' + SHOTS_PER_LEVEL + ' 球', 17, DIM, 24, 56, { align: 'left', weight: 'normal' });
    for (var i = 0; i < HEARTS; i++) this.drawHeart(ctx, 165 + i * 30, 32, i < this.hearts);
    // 右上：分數
    roundRect(ctx, W - 212, 10, 200, 64, 12); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
    this.text(ctx, String(this.score), 26, GOLD, W - 24, 32, { align: 'right' });
    this.text(ctx, '最高 ' + this.best, 15, DIM, W - 24, 58, { align: 'right', weight: 'normal' });
    // 上方中間：連續撲救進度與大招
    var bx = W / 2 - 150, by = 14, bw = 300, prog = (this.streak % STREAK_FOR_SUPER) / STREAK_FOR_SUPER;
    if (this.supers >= MAX_SUPER) prog = 1;
    roundRect(ctx, bx, by, bw, 22, 11); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
    if (prog > 0) { roundRect(ctx, bx + 3, by + 3, (bw - 6) * prog, 16, 8); ctx.fillStyle = rgb(CYAN); ctx.fill(); }
    this.text(ctx, '連續撲救 ' + this.streak + (this.supers >= MAX_SUPER ? '（大招已滿）' : '　再 ' + (STREAK_FOR_SUPER - this.streak % STREAK_FOR_SUPER) + ' 球存大招'), 13, TEXT, W / 2, by + 11, { weight: 'normal' });
    for (var j = 0; j < MAX_SUPER; j++) this.drawSuperIcon(ctx, W / 2 - 40 + j * 40, by + 44, j < this.supers);
    if (this.supers > 0 && (this.state === 'runup' || this.state === 'flight') && !this.superActive) {
      this.text(ctx, '兩手一起握＝重影', 15, CYAN, W / 2, by + 80, { alpha: 0.6 + 0.4 * Math.sin(this.t * 6) });
    }
    if (this.superActive) this.text(ctx, '重影！', 34, CYAN, W / 2, g.gTop - 26);
    var p = levelParams(this.level);
    if ((this.state === 'runup' || this.state === 'flight') && this.balls.length > 1 && !this.superActive) this.text(ctx, '雙球！兩手一起握使出重影', 26, RED, W / 2, g.gBot + 40 * g.k, { alpha: 0.6 + 0.4 * Math.sin(this.t * 10) });
    if (p.curve > 0 && this.state === 'intro') { /* intro 裡說明 */ }
    this.text(ctx, '版本 ' + VERSION, 11, DIM, W - 10, H - 12, { align: 'right', weight: 'normal', shadow: false });
  };
  Game.prototype.drawHeart = function (ctx, x, y, full) {
    ctx.save(); ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 9); ctx.bezierCurveTo(-14, -2, -9, -14, 0, -6); ctx.bezierCurveTo(9, -14, 14, -2, 0, 9);
    ctx.fillStyle = full ? '#ff5a6e' : 'rgba(255,255,255,0.18)'; ctx.fill();
    ctx.restore();
  };
  Game.prototype.drawSuperIcon = function (ctx, x, y, full) {   // 兩個重疊的守門員剪影
    ctx.save(); ctx.translate(x, y);
    var c = full ? CYAN : [90, 100, 120];
    ellipse(ctx, 0, 0, 15, 15, full ? 'rgba(110,220,255,0.25)' : 'rgba(255,255,255,0.08)');
    for (var i = -1; i <= 1; i += 2) {
      ellipse(ctx, i * 5, -6, 3.5, 3.5, rgb(c, full ? 1 : 0.6));
      roundRect(ctx, i * 5 - 3.5, -2, 7, 10, 2); ctx.fillStyle = rgb(c, full ? 1 : 0.6); ctx.fill();
    }
    ctx.restore();
  };
  // 下方：左右手握力環狀態（握的時候亮起）
  Game.prototype.drawRings = function (ctx) {
    var rings = this.env.rings || {};
    var sides = [['L', '左手', 20, 'left'], ['R', '右手', W - 20, 'right']];
    for (var i = 0; i < 2; i++) {
      var s = sides[i], r = rings[s[0]] || {}, f = this.flash[s[0]];
      var col = r.connected ? (f > 0 ? GOLD : GREEN) : DIM;
      var w = 120, x = s[3] === 'left' ? s[2] : s[2] - w, y = H - 52;
      if (this.state === 'menu') continue;
      roundRect(ctx, x, y, w, 32, 10); ctx.fillStyle = 'rgba(0,0,0,' + (0.4 + f * 0.3) + ')'; ctx.fill();
      ellipse(ctx, x + 18, y + 16, 7, 7, rgb(col));
      this.text(ctx, s[1] + (r.connected ? '' : ' 未連線'), 15, TEXT, x + 32, y + 17, { align: 'left', weight: 'normal' });
    }
  };

  Game.prototype.panel = function (ctx, w, h) {
    var x = W / 2 - w / 2, y = H / 2 - h / 2;
    roundRect(ctx, x, y, w, h, 18); ctx.fillStyle = 'rgba(10,18,35,0.88)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2; ctx.stroke();
    return { x: x, y: y };
  };
  Game.prototype.drawIntro = function (ctx) {
    var p = levelParams(this.level), lines = ['球飛到球門約 ' + p.flight.toFixed(1) + ' 秒'];
    if (p.double) lines.push('手上有大招時會出現雙球：兩手一起握使出重影');
    if (this.level === 6) lines.push('★ 新挑戰：變化球！球飛到一半會轉向');
    else if (p.curve) lines.push('變化球變多了');
    var b = this.panel(ctx, 520, 150 + lines.length * 30);
    this.text(ctx, '第 ' + this.level + ' 關', 44, GOLD, W / 2, b.y + 52);
    for (var i = 0; i < lines.length; i++) this.text(ctx, lines[i], 19, TEXT, W / 2, b.y + 108 + i * 30, { weight: 'normal' });
    this.text(ctx, '握一下開始', 16, DIM, W / 2, b.y + 128 + lines.length * 30, { weight: 'normal' });
  };
  Game.prototype.drawResult = function (ctx, g) {
    var r = this.result; if (!r) return;
    var a = clamp(this.stateT * 4), y = g.gTop + (g.gBot - g.gTop) / 2;
    var label = r.conceded ? (r.saved ? '擋下一球！被踢進一球' : '進球…') : (r.superUsed && r.saved > 1 ? '重影全擋！' : '撲到了！');
    this.text(ctx, label, 46, r.conceded ? RED : GREEN, W / 2, y, { alpha: a });
    if (r.charged) this.text(ctx, '連續 ' + this.streak + ' 球！存了一次大招', 22, CYAN, W / 2, y + 48, { alpha: a });
  };
  Game.prototype.drawEnd = function (ctx) {
    var s = this.state, b = this.panel(ctx, 560, 300);
    if (s === 'clear') {
      this.text(ctx, '第 ' + this.level + ' 關 過關！', 40, GOLD, W / 2, b.y + 60);
      this.text(ctx, '撲到 ' + this.levelSaves + ' 球　剩 ' + this.hearts + ' 顆心', 22, TEXT, W / 2, b.y + 120, { weight: 'normal' });
      this.text(ctx, '過關加分 +' + this.clearBonus, 22, GREEN, W / 2, b.y + 160, { weight: 'normal' });
      this.text(ctx, '握一下進入下一關', 18, DIM, W / 2, b.y + 240, { weight: 'normal' });
    } else if (s === 'fail') {
      this.text(ctx, '第 ' + this.level + ' 關 失敗', 40, RED, W / 2, b.y + 60);
      this.text(ctx, '目前分數 ' + this.score, 22, TEXT, W / 2, b.y + 120, { weight: 'normal' });
      this.text(ctx, '握一下再挑戰這一關', 20, TEXT, W / 2, b.y + 180, { weight: 'normal' });
      var self = this;
      this.button(ctx, '回選單', W / 2 - 70, b.y + 222, 140, 48, function () { self.go('menu'); });
    } else {
      this.text(ctx, '🏆', 50, GOLD, W / 2, b.y + 56, { shadow: false });
      this.text(ctx, '10 關全部過關！', 38, GOLD, W / 2, b.y + 118);
      this.text(ctx, '總分 ' + this.score + '　撲救 ' + this.totalSaves + ' / ' + this.totalShots, 22, TEXT, W / 2, b.y + 172, { weight: 'normal' });
      this.text(ctx, '握一下回選單', 18, DIM, W / 2, b.y + 250, { weight: 'normal' });
    }
  };

  Game.prototype.drawMenu = function (ctx) {
    var self = this, env = this.env, rings = env.rings || {};
    ctx.fillStyle = 'rgba(5,10,25,0.55)'; ctx.fillRect(0, 0, W, H);
    this.text(ctx, '守門員大作戰', 58, GOLD, W / 2, H * 0.16);
    this.text(ctx, '握右手往右撲、握左手往左撲；連續撲到 10 球存大招，兩手一起握使出「重影」', 17, TEXT, W / 2, H * 0.16 + 56, { weight: 'normal' });
    this.text(ctx, '共 10 關：球越來越快，第 3 關起有雙球，第 6 關起有變化球', 17, DIM, W / 2, H * 0.16 + 84, { weight: 'normal' });
    // 連接左右手
    var y = H * 0.16 + 130, sides = [['L', '左手', W / 2 - 290], ['R', '右手', W / 2 + 10]];
    for (var i = 0; i < 2; i++) {
      var s = sides[i], r = rings[s[0]] || {};
      roundRect(ctx, s[2], y, 280, 150, 16); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
      this.text(ctx, s[1] + '握力環', 24, TEXT, s[2] + 140, y + 30);
      ellipse(ctx, s[2] + 26, y + 30, 8, 8, rgb(r.connected ? (this.flash[s[0]] > 0 ? GOLD : GREEN) : DIM));
      this.wrapText(ctx, r.connected ? '已連線（握一下試試看）' : (r.status || '尚未連線'), 13, r.connected ? GREEN : [230, 200, 140], s[2] + 140, y + 60, 256);
      (function (side) {
        self.button(ctx, r.connected ? '重新連接' : '連接' + (side === 'L' ? '左手' : '右手'), s[2] + 40, y + 88, 200, 46, function () { env.connectRing(side); });
      })(s[0]);
    }
    if (!env.bluetoothSupported) this.text(ctx, '這個瀏覽器不支援藍牙：iPad 請用 Bluefy 開啟。沒有握力環也能用觸控玩（點左半邊／右半邊）', 15, RED, W / 2, y + 172, { weight: 'normal' });
    this.button(ctx, '開始遊戲', W / 2 - 130, y + 196, 260, 64, function () { self.newGame(); self.startLevel(); }, { fill: 'rgba(255,205,70,0.9)', color: [40, 30, 0], size: 26, stroke: 'rgba(255,230,150,1)' });
    this.text(ctx, '兩支都連好後，握一下也能開始', 15, DIM, W / 2, y + 282, { weight: 'normal' });
    this.text(ctx, '最高分 ' + this.best + (this.bestLevel ? '　最遠第 ' + this.bestLevel + ' 關' : ''), 18, GOLD, W / 2, y + 318);
    this.button(ctx, this.musicOn ? '音樂：開' : '音樂：關', W - 150, 16, 130, 40, function () { self.toggleMusic(); }, { size: 16 });
    this.text(ctx, '沒有握力環：點左半邊／右半邊撲球，兩邊同時點＝重影　電腦：← → 撲球、↑ 重影', 14, DIM, W / 2, H - 40, { weight: 'normal' });
    this.text(ctx, '版本 ' + VERSION, 11, DIM, W - 10, H - 12, { align: 'right', weight: 'normal', shadow: false });
  };

  // 選單上的「開始遊戲」要能被握力環觸發：兩支都連好時握一下就開始
  Game.prototype.menuCanStartByGrip = function () {
    var r = this.env.rings || {};
    return !!((r.L && r.L.connected) || (r.R && r.R.connected));
  };

  function setHeight(h) { H = Math.round(clamp(h, H_MIN, H_MAX)); api.H = H; return H; }   // 由 app.js 依螢幕比例設定
  var api = { VERSION: VERSION, Game: Game, W: W, H: H, setHeight: setHeight, levelParams: levelParams,
              NUM_LEVELS: NUM_LEVELS, SHOTS_PER_LEVEL: SHOTS_PER_LEVEL, HEARTS: HEARTS, STREAK_FOR_SUPER: STREAK_FOR_SUPER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeeperGame = api;
})(typeof window !== 'undefined' ? window : this);
