// Perilous Legends - Slots (in-house) - bridge-integrated.
//
// Replaces 1Stake's air-gapped obfuscated lib. Uses the same symbol
// PNGs, wheel.png, and audio cues. Every wager and payout flows
// through PL.wager('slots', bet) / PL.settle('slots', payout) so the
// casino balance is server-authoritative.
//
// Layout:
//   - 5 reels × 3 visible rows
//   - 20 paylines (standard 5-reel arrangements)
//   - Bet controls (-/+) and lines selector (1/5/10/15/20)
//   - Spin button + auto-spin toggle (TODO v1)
//   - Paytable overlay
//   - Bonus wheel overlay triggered by 3+ scatters
//
// Reels strips and symbol payouts come from /config.js (the previous
// slotMachineConfig — kept for backward compatibility with memory
// values like reel strips and symbol weights).

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────
  // Config (mirrors the previous slotMachineConfig shape)
  // ────────────────────────────────────────────────────────────────────
  const CFG = {
    minBet:  100,
    maxBet:  10000,
    defaultBet: 100,
    betStep: 100,
    lineCount: 20,
    symbols: [
      // Low tier
      { file: 'j.png',        scatter: false, wild: false, w3: 12, w4: 24, w5: 49 },
      { file: 'q.png',        scatter: false, wild: false, w3: 12, w4: 24, w5: 49 },
      { file: 'a.png',        scatter: false, wild: false, w3: 12, w4: 24, w5: 49 },
      // Mid-low
      { file: 'clubs.png',    scatter: false, wild: false, w3: 18, w4: 34, w5: 68 },
      { file: 'spades.png',   scatter: false, wild: false, w3: 18, w4: 34, w5: 68 },
      // Mid
      { file: 'hearts.png',   scatter: false, wild: false, w3: 24, w4: 47, w5: 93 },
      { file: 'diamonds.png', scatter: false, wild: false, w3: 24, w4: 47, w5: 93 },
      { file: 'k.png',        scatter: false, wild: false, w3: 24, w4: 47, w5: 93 },
      // Jackpot
      { file: 'seven.png',    scatter: false, wild: false, w3: 49, w4: 97, w5: 194 },
      // Wild — substitutes for any non-scatter
      { file: 'wild.png',     scatter: false, wild: true,  w3: 0,  w4: 0,  w5: 0   },
      // Scatter — pays anywhere
      { file: 'scatter.png',  scatter: true,  wild: false, w3: 13, w4: 31, w5: 100 },
    ],
    // Reel strips. Frequencies tuned so 3 scatters ~= 1.68%, 4 ~= 0.13%,
    // 5 ~= 0.004% per memory. Strips here have 3 scatters in 23 stops
    // (3/23 per reel, matching the locked spec).
    reels: [
      [7,1,4,8,0,4,5,1,0,9,5,0,7,6,10,6,3,1,8,2,2,3,2],
      [8,7,3,0,2,10,1,2,6,4,4,0,5,5,8,6,2,7,0,1,9,3,1],
      [7,3,8,5,1,6,2,0,4,1,0,6,4,10,2,2,8,9,5,7,1,0,3],
      [0,3,3,5,1,5,8,2,2,9,6,2,8,1,4,7,6,7,0,0,10,1,4],
      [2,5,1,2,1,3,3,7,8,1,7,10,9,2,4,0,8,5,4,6,0,0,6],
    ],
    // Standard 20-payline patterns (rows 0-2 indexed by reel column).
    paylines: [
      [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2],
      [0,1,2,1,0], [2,1,0,1,2],
      [0,0,1,0,0], [2,2,1,2,2],
      [1,0,0,0,1], [1,2,2,2,1],
      [1,0,1,0,1], [1,2,1,2,1],
      [0,1,1,1,0], [2,1,1,1,2],
      [0,1,0,1,0], [2,1,2,1,2],
      [1,1,0,1,1], [1,1,2,1,1],
      [0,0,2,0,0], [2,2,0,2,2],
      [1,0,1,2,1],
    ],
  };

  // Bonus wheel slices (15 slots, alternating red/white) per memory spec.
  // Each is a payout descriptor: numeric = absolute gold; '*N' = N×bet.
  const WHEEL_PRIZES = [
    { kind: 'flat', label: '5,000',     amount: 5000 },
    { kind: 'flat', label: '10,000',    amount: 10000 },
    { kind: 'flat', label: '25,000',    amount: 25000 },
    { kind: 'flat', label: '5,000',     amount: 5000 },
    { kind: 'flat', label: '50,000',    amount: 50000 },
    { kind: 'flat', label: '10,000',    amount: 10000 },
    { kind: 'mult', label: '2× BET',    mult: 2 },
    { kind: 'flat', label: '5,000',     amount: 5000 },
    { kind: 'flat', label: '100,000',   amount: 100000 },
    { kind: 'flat', label: '10,000',    amount: 10000 },
    { kind: 'mult', label: '5× BET',    mult: 5 },
    { kind: 'flat', label: '25,000',    amount: 25000 },
    { kind: 'jackpot', label: 'JACKPOT 500,000', amount: 500000 },
    { kind: 'mult', label: '10× BET',   mult: 10 },
    { kind: 'freespin', label: 'FREE SPIN +50,000', amount: 50000 },
  ];

  const SCATTERS_TO_SPINS = { 3: 1, 4: 3, 5: 5 };

  // ────────────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────────────
  let balance     = 0;
  let bet         = CFG.defaultBet;
  const lines     = CFG.lineCount;            // fixed at 20 (original spec)
  let spinning    = false;
  let bridgeReady = false;
  let lastWin     = 0;
  let bonusSpinsLeft = 0;
  let bonusBet    = 0;

  // ────────────────────────────────────────────────────────────────────
  // DOM bootstrap
  // ────────────────────────────────────────────────────────────────────
  const SYMBOL_PATH = 'assets/images/symbols/';
  const AUDIO_PATH  = 'assets/audio/';
  const BONUS_PATH  = 'assets/bonus/';

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  let _initialized = false;
  function init() {
    if (_initialized) return;
    _initialized = true;
    buildUI();
    bindControls();
    initBridge();
    drawReelsInitial();
  }

  // ────────────────────────────────────────────────────────────────────
  // PL bridge integration
  // ────────────────────────────────────────────────────────────────────
  async function initBridge() {
    const banner = document.getElementById('pl-banner');
    function showBanner(msg, color) {
      banner.textContent = msg;
      banner.style.background = color || '#a30000';
      banner.style.display = 'block';
    }
    if (!window.PL) {
      showBanner('PL casino bridge not loaded.');
      return;
    }
    try {
      const info = await PL.init();
      balance = info.balance;
      bridgeReady = true;
      PL.onBalanceChanged((b) => { balance = b; renderBalance(); });
      renderBalance();
    } catch (e) {
      showBanner('Casino offline: ' + (e && e.message || e) +
                 ' — close this tab and buy in from a Casino Stone.');
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // UI build
  // ────────────────────────────────────────────────────────────────────
  function buildUI() {
    const root = document.getElementById('slot-root');
    const ASSETS = 'assets/images/slot-machine/';
    function imgBtn(id, base, extraClass) {
      return `<button class="img-btn ${extraClass||''}" id="${id}"
                       style="background-image:url('${ASSETS}${base}.png');"
                       data-base="${base}"
                       onmouseover="this.style.backgroundImage='url(${ASSETS}${base}-hover.png)'"
                       onmouseout="this.style.backgroundImage='url(${ASSETS}${base}.png)'"
                       onmousedown="this.style.backgroundImage='url(${ASSETS}${base}-active.png)'"
                       onmouseup="this.style.backgroundImage='url(${ASSETS}${base}-hover.png)'"
              ></button>`;
    }
    root.innerHTML = `
      <div class="machine">
        <div class="hud">
          <div class="hud-cell"><span class="hud-label">Bank</span><span id="balance" class="hud-value">…</span><span class="hud-suffix">g</span></div>
          <div class="hud-cell"><span class="hud-label">Bet</span><span id="totalBet" class="hud-value">…</span><span class="hud-suffix">g</span></div>
          <div class="hud-cell"><span class="hud-label">Win</span><span id="lastWin" class="hud-value">0</span><span class="hud-suffix">g</span></div>
        </div>
        <div class="reels" id="reels"></div>
        <div class="msg" id="resultMsg"></div>
        <div class="controls">
          ${imgBtn('paytableBtn', 'btn_paytable')}
          <div class="bet-stack">
            ${imgBtn('betMinus', 'btn_bet_minus')}
            <div class="bet-display">
              <span class="bet-cap">Bet / line</span>
              <span class="bet-num" id="betDisplay">${CFG.defaultBet}</span>
            </div>
            ${imgBtn('betPlus', 'btn_bet_plus')}
          </div>
          ${imgBtn('maxBetBtn', 'btn_max')}
          ${imgBtn('spinBtn', 'btn_spin', 'spin')}
          ${imgBtn('muteBtn', 'btn_sound_on', 'mute')}
        </div>
      </div>

      <div class="paytable-overlay" id="paytableOverlay">
        <div class="paytable">
          <h2>Pay Table</h2>
          <p class="pt-note">Wins pay left → right from Reel 1. Match 3+ in a row.
             <b>Wild</b> substitutes for any non-scatter.
             3+ <b>Scatter</b> anywhere triggers the Bonus Wheel.</p>
          <div class="pt-grid" id="ptGrid"></div>
          <button class="text-btn" id="ptCloseBtn">Close</button>
        </div>
      </div>

      <div class="bonus-overlay" id="bonusOverlay">
        <h1 class="bonus-title">BONUS WHEEL</h1>
        <p class="bonus-sub" id="bonusSub">3 scatters — 1 spin</p>
        <canvas id="wheelCanvas" width="600" height="600"></canvas>
        <div class="bonus-msg" id="bonusMsg"></div>
        <button class="text-btn spin-btn" id="bonusSpinBtn">SPIN WHEEL</button>
        <button class="text-btn" id="bonusCloseBtn" style="display:none;">COLLECT &amp; CONTINUE</button>
      </div>
    `;

    // Build reels DOM (5 cols × 3 rows of <img>)
    const reelsEl = document.getElementById('reels');
    for (let r = 0; r < 5; r++) {
      const col = document.createElement('div');
      col.className = 'reel';
      col.dataset.reel = r;
      for (let row = 0; row < 3; row++) {
        const slot = document.createElement('div');
        slot.className = 'symbol';
        slot.dataset.row = row;
        const img = document.createElement('img');
        slot.appendChild(img);
        col.appendChild(slot);
      }
      reelsEl.appendChild(col);
    }

    // Build paytable
    const pt = document.getElementById('ptGrid');
    for (const sym of CFG.symbols) {
      if (sym.scatter) continue; // hidden per design
      const cell = document.createElement('div');
      cell.className = 'pt-cell';
      cell.innerHTML = `
        <img src="${SYMBOL_PATH}${sym.file}" />
        <div class="pt-rows">
          <div>5×: <b>${sym.w5}</b></div>
          <div>4×: <b>${sym.w4}</b></div>
          <div>3×: <b>${sym.w3}</b></div>
        </div>
      `;
      pt.appendChild(cell);
    }
  }

  function bindControls() {
    document.getElementById('spinBtn').addEventListener('click', onSpin);
    document.getElementById('betMinus').addEventListener('click', () => changeBet(-CFG.betStep));
    document.getElementById('betPlus').addEventListener('click',  () => changeBet(+CFG.betStep));
    document.getElementById('maxBetBtn').addEventListener('click', () => { bet = CFG.maxBet; renderBet(); });
    document.getElementById('paytableBtn').addEventListener('click', () => togglePaytable(true));
    document.getElementById('ptCloseBtn').addEventListener('click',  () => togglePaytable(false));
    document.getElementById('muteBtn').addEventListener('click', toggleMute);
    document.getElementById('bonusSpinBtn').addEventListener('click', spinBonusWheel);
    document.getElementById('bonusCloseBtn').addEventListener('click', closeBonus);
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ' && !spinning && document.getElementById('bonusOverlay').style.display !== 'flex') {
        e.preventDefault();
        onSpin();
      }
    });
  }

  function changeBet(delta) {
    if (spinning) return;
    bet = Math.max(CFG.minBet, Math.min(CFG.maxBet, bet + delta));
    renderBet();
  }
  function renderBet() {
    document.getElementById('betDisplay').textContent = bet.toLocaleString();
    renderTotalBet();
  }
  function totalBet() { return bet * lines; }
  function renderBalance() { document.getElementById('balance').textContent = balance.toLocaleString(); }
  function renderTotalBet() { document.getElementById('totalBet').textContent = totalBet().toLocaleString(); }

  // ────────────────────────────────────────────────────────────────────
  // Reel rendering
  // ────────────────────────────────────────────────────────────────────
  function drawReelsInitial() {
    // Place 3 random symbols per reel as the initial visible state.
    for (let r = 0; r < 5; r++) {
      const strip = CFG.reels[r];
      const startStop = Math.floor(Math.random() * strip.length);
      paintReel(r, startStop);
    }
    renderTotalBet();
  }

  function paintReel(reelIdx, stopIdx) {
    const strip = CFG.reels[reelIdx];
    const slots = document.querySelectorAll(`.reel[data-reel="${reelIdx}"] .symbol img`);
    for (let row = 0; row < 3; row++) {
      const sym = CFG.symbols[strip[(stopIdx + row) % strip.length]];
      slots[row].src = SYMBOL_PATH + sym.file;
      slots[row].dataset.symIdx = strip[(stopIdx + row) % strip.length];
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Spin / payout
  // ────────────────────────────────────────────────────────────────────
  async function onSpin() {
    if (spinning) return;
    if (!bridgeReady) return;
    const total = totalBet();
    if (total > balance) {
      showMessage('Insufficient bank.', 'lose');
      return;
    }

    // Wager up front. If the server rejects (race / insufficient),
    // abort the spin entirely.
    spinning = true;
    document.getElementById('spinBtn').disabled = true;
    try {
      await PL.wager('slots', total);
    } catch (e) {
      spinning = false;
      document.getElementById('spinBtn').disabled = false;
      showMessage(e instanceof PL.errors.PLInsufficientFunds
        ? 'Insufficient bank.'
        : 'Wager error: ' + (e && e.message || e), 'lose');
      return;
    }

    playSound('spin');
    showMessage('', 'info');
    setLastWin(0);

    // Pick stops for each reel.
    const stops = CFG.reels.map(strip => Math.floor(Math.random() * strip.length));

    // Animate then settle.
    await animateSpin(stops);
    playSound('stop');

    // Resolve wins.
    const result = computePayout(stops, bet, lines);
    let payout = result.linePayout + result.scatterPayout;

    if (result.scatterCount >= 3) {
      // The bonus round adds its own credits via separate settle calls.
      await PL.settle('slots', payout);
      bonusBet = bet;
      bonusSpinsLeft = SCATTERS_TO_SPINS[result.scatterCount] || 1;
      document.getElementById('bonusSub').textContent =
        result.scatterCount + ' scatters — ' + bonusSpinsLeft + ' spin' + (bonusSpinsLeft > 1 ? 's' : '');
      playSound('bonus-banner');
      openBonus();
    } else {
      await PL.settle('slots', payout);
      if (payout > 0) {
        playSound('win');
        showMessage('+' + payout.toLocaleString() + 'g', 'win');
        setLastWin(payout);
        flashWinningPaylines(result.winningLines);
      }
    }

    spinning = false;
    document.getElementById('spinBtn').disabled = false;
  }

  function animateSpin(finalStops) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const totalMs = 1800;
      const reelStopMs = [1000, 1200, 1400, 1600, 1800]; // reels stop 1 by 1
      let frame = 0;

      function tick() {
        const elapsed = Date.now() - startTime;
        for (let r = 0; r < 5; r++) {
          if (elapsed < reelStopMs[r]) {
            // Spinning — pick a random stop offset each frame
            const strip = CFG.reels[r];
            const fakeStop = (frame + r * 7) % strip.length;
            paintReel(r, fakeStop);
          } else if (Math.abs(elapsed - reelStopMs[r]) < 30) {
            // Snap to final stop
            paintReel(r, finalStops[r]);
          }
        }
        frame++;
        if (elapsed < totalMs) {
          requestAnimationFrame(tick);
        } else {
          // Final paint to be safe
          for (let r = 0; r < 5; r++) paintReel(r, finalStops[r]);
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  // Compute the payout for a given final-stop array.
  function computePayout(stops, betPerLine, linesActive) {
    // Build the 3-row × 5-col grid of symbol indices.
    const grid = [];
    for (let row = 0; row < 3; row++) {
      const r = [];
      for (let col = 0; col < 5; col++) {
        const strip = CFG.reels[col];
        r.push(strip[(stops[col] + row) % strip.length]);
      }
      grid.push(r);
    }

    // Count scatters anywhere on the grid.
    let scatterCount = 0;
    for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
      if (CFG.symbols[grid[row][col]].scatter) scatterCount++;
    }
    const scatterSym = CFG.symbols.find(s => s.scatter);
    const scatterMult = scatterCount >= 5 ? scatterSym.w5
                       : scatterCount === 4 ? scatterSym.w4
                       : scatterCount === 3 ? scatterSym.w3
                       : 0;
    const scatterPayout = scatterMult * (betPerLine * linesActive);

    // Walk paylines for line wins.
    let linePayout = 0;
    const winningLines = [];
    for (let li = 0; li < linesActive; li++) {
      const line = CFG.paylines[li];
      const symIdx0 = grid[line[0]][0];
      const sym0 = CFG.symbols[symIdx0];
      if (sym0.scatter) continue; // no scatter line wins (paid via anywhere)
      // Determine the matched symbol — wilds at start substitute for the first non-wild.
      let matchSym = symIdx0;
      let matchSymObj = sym0;
      let startCol = 0;
      if (sym0.wild) {
        // Look for first non-wild non-scatter for the match symbol.
        for (let col = 1; col < 5; col++) {
          const s = CFG.symbols[grid[line[col]][col]];
          if (!s.wild && !s.scatter) {
            matchSym = grid[line[col]][col];
            matchSymObj = s;
            break;
          }
        }
      }
      let count = 0;
      for (let col = 0; col < 5; col++) {
        const sIdx = grid[line[col]][col];
        const s = CFG.symbols[sIdx];
        if (sIdx === matchSym || s.wild) count++;
        else break;
      }
      if (count >= 3 && !matchSymObj.scatter) {
        const payKey = 'w' + count; // w3/w4/w5
        const mult = matchSymObj[payKey] || 0;
        if (mult > 0) {
          linePayout += mult * betPerLine;
          winningLines.push({ lineIdx: li, count: count, sym: matchSymObj });
        }
      }
    }
    return { linePayout, scatterPayout, scatterCount, winningLines };
  }

  function flashWinningPaylines(lines) {
    // TODO v1: draw connecting lines + symbol pulse. v0 just outlines wins.
    document.querySelectorAll('.symbol.winning').forEach(el => el.classList.remove('winning'));
    for (const w of lines) {
      const pattern = CFG.paylines[w.lineIdx];
      for (let col = 0; col < w.count; col++) {
        const slot = document.querySelector(
          `.reel[data-reel="${col}"] .symbol[data-row="${pattern[col]}"]`);
        if (slot) slot.classList.add('winning');
      }
    }
    setTimeout(() => {
      document.querySelectorAll('.symbol.winning').forEach(el => el.classList.remove('winning'));
    }, 2000);
  }

  // ────────────────────────────────────────────────────────────────────
  // Bonus wheel
  // ────────────────────────────────────────────────────────────────────
  function openBonus() {
    document.getElementById('bonusOverlay').style.display = 'flex';
    drawBonusWheel(0);
  }
  function closeBonus() {
    document.getElementById('bonusOverlay').style.display = 'none';
    document.getElementById('bonusSpinBtn').style.display = '';
    document.getElementById('bonusCloseBtn').style.display = 'none';
    document.getElementById('bonusMsg').textContent = '';
  }

  let bonusSpinning = false;
  async function spinBonusWheel() {
    if (bonusSpinning || bonusSpinsLeft <= 0) return;
    bonusSpinning = true;
    document.getElementById('bonusSpinBtn').disabled = true;
    document.getElementById('bonusMsg').textContent = '';

    playSound('wheel-spin', /*loop*/ true);

    const slice = Math.floor(Math.random() * WHEEL_PRIZES.length);
    const totalRotation = (5 + Math.random() * 3) * 360 + (slice * (360 / WHEEL_PRIZES.length));
    const dur = 4500;
    const start = Date.now();

    await new Promise(resolve => {
      function tick() {
        const t = Math.min(1, (Date.now() - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        drawBonusWheel(eased * totalRotation);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });

    stopSound('wheel-spin');
    const prize = WHEEL_PRIZES[slice];
    let payout = 0;
    let label = prize.label;
    if (prize.kind === 'flat' || prize.kind === 'jackpot') payout = prize.amount;
    else if (prize.kind === 'mult') payout = prize.mult * bonusBet;
    else if (prize.kind === 'freespin') {
      payout = prize.amount;
      bonusSpinsLeft++; // give back the spin we're about to consume
    }

    if (payout > 0) {
      try { await PL.settle('slots', payout); }
      catch (e) { console.error('bonus settle failed', e); }
      playSound('win');
      document.getElementById('bonusMsg').textContent =
        `${label} → +${payout.toLocaleString()}g`;
    } else {
      document.getElementById('bonusMsg').textContent = label;
    }

    bonusSpinsLeft--;
    if (bonusSpinsLeft <= 0) {
      document.getElementById('bonusSpinBtn').style.display = 'none';
      document.getElementById('bonusCloseBtn').style.display = '';
    } else {
      document.getElementById('bonusSpinBtn').disabled = false;
      document.getElementById('bonusSub').textContent = bonusSpinsLeft + ' spin' + (bonusSpinsLeft > 1 ? 's' : '') + ' remaining';
    }
    bonusSpinning = false;
  }

  function drawBonusWheel(angleDeg) {
    const cv = document.getElementById('wheelCanvas');
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const cx = w / 2, cy = h / 2;
    const r  = w / 2 - 10;
    ctx.clearRect(0, 0, w, h);

    const slices = WHEEL_PRIZES.length;
    const sliceAngle = (Math.PI * 2) / slices;
    const baseAngle = (angleDeg % 360) * Math.PI / 180 - Math.PI / 2;

    for (let i = 0; i < slices; i++) {
      const a0 = baseAngle + i * sliceAngle;
      const a1 = a0 + sliceAngle;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = (i % 2 === 0) ? '#cc2222' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Slice label
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a0 + sliceAngle / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = (i % 2 === 0) ? '#fff' : '#000';
      ctx.font = 'bold 14px Georgia, serif';
      ctx.fillText(WHEEL_PRIZES[i].label, r - 12, 5);
      ctx.restore();
    }

    // Pointer at top
    ctx.beginPath();
    ctx.moveTo(cx - 14, 6);
    ctx.lineTo(cx + 14, 6);
    ctx.lineTo(cx, 32);
    ctx.closePath();
    ctx.fillStyle = '#ffd700';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ────────────────────────────────────────────────────────────────────
  // Audio
  // ────────────────────────────────────────────────────────────────────
  let _muted = false;
  const _audioCache = {};
  function audioFor(name, loop) {
    let key = name + (loop ? '_loop' : '');
    if (!_audioCache[key]) {
      let path;
      if (name.startsWith('bonus-banner')) path = BONUS_PATH + 'bonus-banner.mp3';
      else if (name === 'wheel-spin')      path = BONUS_PATH + 'wheel-spin.mp3';
      else if (name === 'scatter')         path = BONUS_PATH + 'scatter.mp3';
      else if (name === 'fireworks')       path = BONUS_PATH + 'fireworks.mp3';
      else                                  path = AUDIO_PATH + name + '.wav';
      const a = new Audio(path);
      a.loop = !!loop;
      _audioCache[key] = a;
    }
    return _audioCache[key];
  }
  function playSound(name, loop) {
    if (_muted) return;
    try {
      const a = audioFor(name, loop);
      a.currentTime = 0;
      a.play().catch(() => {});
    } catch (_) {}
  }
  function stopSound(name) {
    try {
      const a = audioFor(name, true);
      a.pause();
      a.currentTime = 0;
    } catch (_) {}
  }
  function toggleMute() {
    _muted = !_muted;
    const btn = document.getElementById('muteBtn');
    const base = _muted ? 'btn_sound_off' : 'btn_sound_on';
    btn.dataset.base = base;
    const ASSETS = 'assets/images/slot-machine/';
    btn.style.backgroundImage = `url('${ASSETS}${base}.png')`;
    btn.onmouseover = () => { btn.style.backgroundImage = `url('${ASSETS}${base}-hover.png')`; };
    btn.onmouseout  = () => { btn.style.backgroundImage = `url('${ASSETS}${base}.png')`; };
    if (_muted) Object.values(_audioCache).forEach(a => { a.pause(); });
  }

  // ────────────────────────────────────────────────────────────────────
  // UI helpers
  // ────────────────────────────────────────────────────────────────────
  function showMessage(text, kind) {
    const el = document.getElementById('resultMsg');
    el.textContent = text;
    el.className = 'msg ' + (kind || '');
    if (text) {
      setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'msg'; } }, 2200);
    }
  }
  function setLastWin(amount) {
    lastWin = amount;
    document.getElementById('lastWin').textContent = amount.toLocaleString();
  }
  function togglePaytable(open) {
    document.getElementById('paytableOverlay').style.display = open ? 'flex' : 'none';
  }
})();
