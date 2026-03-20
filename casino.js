// Heroes of Holdem - Casino Floor
// Phaser 3 top-down casino with UO character sprites

const WORLD_W = 900;
const WORLD_H = 900;
const VIEW_W = 800;
const VIEW_H = 600;
const PLAYER_SPEED = 120;
const PLAYER_BODY_W = 20;
const PLAYER_BODY_H = 16;
const ARRIVE_THRESHOLD = 6;

// Get player name from URL
const urlParams = new URLSearchParams(window.location.search);
const playerName = urlParams.get('name') || 'Adventurer';

// Determined before Phaser init by startGame()
let spriteBody = 'male';
let manifest = null;

// UO direction mapping - angle ranges to 8 directions
// UO: 0=S, 1=SW, 2=W, 3=NW, 4=N, 5=NE, 6=E, 7=SE
function angleTo8Dir(angleRad) {
  let deg = Phaser.Math.RadToDeg(angleRad);
  if (deg < 0) deg += 360;
  if (deg >= 337.5 || deg < 22.5) return 6;   // E
  if (deg >= 22.5 && deg < 67.5) return 7;    // SE
  if (deg >= 67.5 && deg < 112.5) return 0;   // S
  if (deg >= 112.5 && deg < 157.5) return 1;  // SW
  if (deg >= 157.5 && deg < 202.5) return 2;  // W
  if (deg >= 202.5 && deg < 247.5) return 3;  // NW
  if (deg >= 247.5 && deg < 292.5) return 4;  // N
  return 5; // NE
}

// Casino table/zone definitions - positioned to match 1024x1024 casino-floor.jpg
const ZONES = [
  // Blackjack table - left semi-circular table
  {
    id: 'blackjack1',
    label: 'Blackjack',
    x: 418, y: 419,
    w: 127, h: 57,
    type: 'game',
    url: 'https://htmlpreview.github.io/?https://gist.githubusercontent.com/TestamentsTCG/e576c2fcba7f4a1202dd751eee4515bd/raw/blackjack.html'
  },
  // UTH table - right oval table
  {
    id: 'uth',
    label: 'Ultimate Texas\nHold\'em',
    x: 654, y: 421,
    w: 164, h: 58,
    type: 'game',
    url: 'https://htmlpreview.github.io/?https://gist.githubusercontent.com/TestamentsTCG/35d0b3ee2fe47e327215a2c781d7a5ff/raw/uth-test.html'
  },
  // Bar - top area
  {
    id: 'bar',
    label: 'Bar',
    x: 447, y: 99,
    w: 733, h: 130,
    type: 'coming_soon'
  }
];

// Interaction zones (slightly larger than tables for "walk near" detection)
const INTERACT_PADDING = 30;

let spritesLoaded = false;
let currentDir = 0; // facing south by default
let isMoving = false;
let modalOpen = false;
let debugMode = false;

// Torch/sconce sprite config
const TORCH_SPRITE = {
  key: 'torch',
  file: 'sprites/torch_0A15.png',
  frameWidth: 44,
  frameHeight: 44,
  frameCount: 7,
  frameInterval: 6  // UO anim interval
};
const TORCH_POSITIONS = [
  { x: 29,  y: 129, scale: 2 },
  { x: 832, y: 126, scale: 2 },
  { x: 29,  y: 364, scale: 2 },
  { x: 833, y: 363, scale: 2 },
  { x: 29,  y: 697, scale: 2 },
  { x: 833, y: 698, scale: 2 },
  { x: 160, y: 58,  scale: 2 },
  { x: 701, y: 58,  scale: 2 },
];

const CANDLE_SPRITE = {
  key: 'candle_0A10',
  file: 'sprites/torch_0A10.png',
  frameWidth: 44,
  frameHeight: 24,
  frameCount: 2,
  frameInterval: 3
};

// 10 candles - spread around for Mike to reposition via debug
const CANDLE_POSITIONS = [
  { x: 353, y: 139, scale: 1.5 },
  { x: 275, y: 139, scale: 1.5 },
  { x: 370, y: 393, scale: 1   },
  { x: 468, y: 416, scale: 1   },
  { x: 574, y: 415, scale: 1   },
  { x: 715, y: 411, scale: 1   },
  { x: 520, y: 144, scale: 1.5 },
  { x: 369, y: 413, scale: 1   },
  { x: 446, y: 144, scale: 1.5 },
  { x: 661, y: 140, scale: 1.5 },
];

class CasinoScene extends Phaser.Scene {
  constructor() {
    super({ key: 'CasinoScene' });
    this.moveTarget = null;
    this.pendingZone = null;
  }

  preload() {
    this.load.image('casino-floor', 'casino-floor.jpg');

    // Load torch/sconce spritesheet
    this.load.spritesheet(TORCH_SPRITE.key, TORCH_SPRITE.file, {
      frameWidth: TORCH_SPRITE.frameWidth,
      frameHeight: TORCH_SPRITE.frameHeight
    });

    // Load candle spritesheet
    this.load.spritesheet(CANDLE_SPRITE.key, CANDLE_SPRITE.file, {
      frameWidth: CANDLE_SPRITE.frameWidth,
      frameHeight: CANDLE_SPRITE.frameHeight
    });

    // manifest and spriteBody are already set before Phaser init - load sprites directly
    if (manifest && manifest.bodies && manifest.bodies[spriteBody]) {
      this.loadUOSprites();
    }

    this.load.on('loaderror', () => {});
  }

  loadUOSprites() {
    const body = manifest.bodies[spriteBody];
    for (let dir = 0; dir < 8; dir++) {
      const walkInfo = body.walk[dir];
      if (walkInfo) {
        this.load.spritesheet(`walk_${dir}`, `sprites/${walkInfo.file}`, {
          frameWidth: walkInfo.frameWidth,
          frameHeight: walkInfo.frameHeight
        });
      }
      const standInfo = body.stand[dir];
      if (standInfo) {
        this.load.image(`stand_${dir}`, `sprites/${standInfo.file}`);
      }
    }
    spritesLoaded = true;
  }

  create() {
    // Set world bounds to the full world size
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    this.createFloor();
    this.createTorches();
    this.createCandles();
    this.createTables();
    this.createPlayer();
    this.createUI();
    this.createDebugOverlay();
    this.setupInput();
    this.setupModal();

    if (spritesLoaded && manifest) {
      this.createAnimations();
    }

    // Camera setup - follow player, bounded to world
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);

    // Disable right-click context menu on the canvas
    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  createFloor() {
    // Use the real casino art image as the floor background
    this.add.image(0, 0, 'casino-floor').setOrigin(0, 0).setDepth(0);
  }

  createTorches() {
    if (!this.textures.exists(TORCH_SPRITE.key)) return;

    // Create torch flicker animation
    this.anims.create({
      key: 'torch_flicker',
      frames: this.anims.generateFrameNumbers(TORCH_SPRITE.key, {
        start: 0,
        end: TORCH_SPRITE.frameCount - 1
      }),
      frameRate: 10 / (TORCH_SPRITE.frameInterval / 5), // scale UO interval to fps
      repeat: -1
    });

    this.torches = [];
    this.torchLabels = [];
    for (let i = 0; i < TORCH_POSITIONS.length; i++) {
      const pos = TORCH_POSITIONS[i];
      const torch = this.add.sprite(pos.x, pos.y, TORCH_SPRITE.key);
      torch.setScale(pos.scale);
      torch.setDepth(5);
      torch.play('torch_flicker');
      // Stagger start frame so they don't all sync
      torch.anims.setProgress(Math.random());
      torch.torchIndex = i;
      this.torches.push(torch);

      // Debug label for torch (hidden until debug mode)
      const label = this.add.text(pos.x, pos.y - 30, '', {
        fontSize: '9px',
        fontFamily: 'monospace',
        color: '#ffaa00',
        backgroundColor: 'rgba(0,0,0,0.8)',
        padding: { x: 3, y: 1 }
      }).setOrigin(0.5, 1).setDepth(51).setVisible(false);
      this.torchLabels.push(label);
    }
  }

  createCandles() {
    if (!this.textures.exists(CANDLE_SPRITE.key)) return;

    // Create candle flicker animation
    this.anims.create({
      key: 'candle_flicker',
      frames: this.anims.generateFrameNumbers(CANDLE_SPRITE.key, {
        start: 0,
        end: CANDLE_SPRITE.frameCount - 1
      }),
      frameRate: 10 / (CANDLE_SPRITE.frameInterval / 5),
      repeat: -1
    });

    this.candles = [];
    this.candleLabels = [];
    for (let i = 0; i < CANDLE_POSITIONS.length; i++) {
      const pos = CANDLE_POSITIONS[i];
      const candle = this.add.sprite(pos.x, pos.y, CANDLE_SPRITE.key);
      candle.setScale(pos.scale);
      candle.setDepth(5);
      candle.play('candle_flicker');
      candle.anims.setProgress(Math.random());
      candle.candleIndex = i;
      this.candles.push(candle);

      // Debug label for candle (hidden until debug mode)
      const label = this.add.text(pos.x, pos.y - 30, '', {
        fontSize: '9px',
        fontFamily: 'monospace',
        color: '#ffaa00',
        backgroundColor: 'rgba(0,0,0,0.8)',
        padding: { x: 3, y: 1 }
      }).setOrigin(0.5, 1).setDepth(51).setVisible(false);
      this.candleLabels.push(label);
    }
  }

  createTables() {
    this.tableZones = [];

    for (const zone of ZONES) {
      // Invisible physics body for collision only - no visible graphics
      const tableBody = this.add.rectangle(zone.x, zone.y, zone.w, zone.h);
      tableBody.setVisible(false);
      this.physics.add.existing(tableBody, true);
      tableBody.zoneData = zone;
      this.tableZones.push(tableBody);
    }
  }

  createPlayer() {
    // Player starts at center-bottom of open floor area
    const startX = 512;
    const startY = 750;

    if (spritesLoaded && manifest) {
      this.player = this.add.sprite(startX, startY, 'stand_0');
      this.player.setScale(1);
    } else {
      this.player = this.add.rectangle(startX, startY, 20, 30, 0x4488ff);
    }

    this.physics.add.existing(this.player);
    this.player.body.setSize(PLAYER_BODY_W, PLAYER_BODY_H);
    this.player.body.setOffset(
      (this.player.width - PLAYER_BODY_W) / 2,
      this.player.height - PLAYER_BODY_H
    );
    this.player.body.setCollideWorldBounds(true);
    this.player.setDepth(10);

    for (const table of this.tableZones) {
      this.physics.add.collider(this.player, table, () => {
        this.moveTarget = null;
      });
    }

    this.nameLabel = this.add.text(startX, startY - 40, playerName, {
      fontSize: '11px',
      fontFamily: 'Georgia, serif',
      color: '#ffd700',
      stroke: '#000',
      strokeThickness: 3,
      align: 'center'
    }).setOrigin(0.5).setDepth(11);
  }

  createAnimations() {
    const body = manifest.bodies[spriteBody];
    for (let dir = 0; dir < 8; dir++) {
      const walkInfo = body.walk[dir];
      if (walkInfo && this.textures.exists(`walk_${dir}`)) {
        this.anims.create({
          key: `walk_dir${dir}`,
          frames: this.anims.generateFrameNumbers(`walk_${dir}`, {
            start: 0,
            end: walkInfo.frameCount - 1
          }),
          frameRate: 10,
          repeat: -1
        });
      }
    }
  }

  createUI() {
    // Interaction prompt follows player (set in update)
    this.interactPrompt = this.add.text(0, 0, '', {
      fontSize: '14px',
      fontFamily: 'Georgia, serif',
      color: '#ffd700',
      backgroundColor: 'rgba(0,0,0,0.7)',
      padding: { x: 10, y: 5 },
      stroke: '#000',
      strokeThickness: 1
    }).setOrigin(0.5).setDepth(20).setVisible(false);

    // Title banner - fixed to camera (scrollFactor 0)
    this.add.text(VIEW_W / 2, 8, 'PERILOUS LEGENDS CASINO', {
      fontSize: '10px',
      fontFamily: 'Georgia, serif',
      color: '#c9a84c',
      letterSpacing: 3
    }).setOrigin(0.5, 0).setDepth(15).setScrollFactor(0);
  }

  createDebugOverlay() {
    const debugColors = {
      blackjack1: { fill: 0xff0000, alpha: 0.2, stroke: 0xff0000 },
      uth:        { fill: 0x0066ff, alpha: 0.2, stroke: 0x0066ff },
      bar:        { fill: 0xffff00, alpha: 0.2, stroke: 0xffff00 }
    };

    this.debugGraphics = [];
    this.debugLabels = [];
    this.debugHandles = []; // array of arrays, one per zone
    this.debugCoordReadouts = [];
    this._debugDragging = false;

    for (let i = 0; i < ZONES.length; i++) {
      const zone = ZONES[i];
      const colors = debugColors[zone.id] || { fill: 0x00ff00, alpha: 0.2, stroke: 0x00ff00 };

      // Filled rectangle - interactive and draggable
      const rect = this.add.rectangle(zone.x, zone.y, zone.w, zone.h, colors.fill, colors.alpha);
      rect.setStrokeStyle(2, colors.stroke, 0.8);
      rect.setDepth(50);
      rect.setVisible(false);
      rect.setInteractive({ draggable: true, cursor: 'move' });
      rect.zoneIndex = i;
      this.debugGraphics.push(rect);

      // Label with zone id and coordinates
      const labelText = `${zone.id}\n(${zone.x}, ${zone.y}, ${zone.w}x${zone.h})`;
      const label = this.add.text(zone.x, zone.y, labelText, {
        fontSize: '10px',
        fontFamily: 'monospace',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.7)',
        padding: { x: 4, y: 2 },
        align: 'center'
      }).setOrigin(0.5).setDepth(51).setVisible(false);
      this.debugLabels.push(label);

      // Floating coordinate readout (shown while dragging/resizing)
      const readout = this.add.text(zone.x, zone.y - zone.h / 2 - 20, '', {
        fontSize: '10px',
        fontFamily: 'monospace',
        color: '#00ff00',
        backgroundColor: 'rgba(0,0,0,0.85)',
        padding: { x: 4, y: 2 }
      }).setOrigin(0.5, 1).setDepth(60).setVisible(false);
      this.debugCoordReadouts.push(readout);

      // Resize handles - 4 corners (TL, TR, BL, BR)
      const handleSize = 10;
      const corners = [
        { cx: -1, cy: -1 }, // TL
        { cx:  1, cy: -1 }, // TR
        { cx: -1, cy:  1 }, // BL
        { cx:  1, cy:  1 }  // BR
      ];
      const handles = [];
      for (const corner of corners) {
        const hx = zone.x + corner.cx * (zone.w / 2);
        const hy = zone.y + corner.cy * (zone.h / 2);
        const handle = this.add.rectangle(hx, hy, handleSize, handleSize, 0xffffff, 0.9);
        handle.setStrokeStyle(1, 0x000000, 1);
        handle.setDepth(52);
        handle.setVisible(false);
        handle.setInteractive({ draggable: true, cursor: 'nwse-resize' });
        handle.zoneIndex = i;
        handle.cornerX = corner.cx; // -1 or 1
        handle.cornerY = corner.cy; // -1 or 1
        handles.push(handle);
      }
      this.debugHandles.push(handles);
    }

    // Setup drag events for debug boxes and torches
    this.input.on('dragstart', (pointer, gameObject) => {
      if (!debugMode) return;
      if (gameObject.zoneIndex === undefined && gameObject.torchIndex === undefined && gameObject.candleIndex === undefined) return;
      this._debugDragging = true;
    });

    this.input.on('drag', (pointer, gameObject, dragX, dragY) => {
      if (!debugMode) return;

      // Torch dragging
      if (gameObject.torchIndex !== undefined) {
        const idx = gameObject.torchIndex;
        const pos = TORCH_POSITIONS[idx];
        pos.x = Math.round(dragX);
        pos.y = Math.round(dragY);
        gameObject.setPosition(pos.x, pos.y);
        this.updateTorchLabel(idx);
        this.updateDebugPanelText();
        return;
      }

      // Candle dragging
      if (gameObject.candleIndex !== undefined) {
        const idx = gameObject.candleIndex;
        const pos = CANDLE_POSITIONS[idx];
        pos.x = Math.round(dragX);
        pos.y = Math.round(dragY);
        gameObject.setPosition(pos.x, pos.y);
        this.updateCandleLabel(idx);
        this.updateDebugPanelText();
        return;
      }

      if (gameObject.zoneIndex === undefined) return;

      const idx = gameObject.zoneIndex;
      const zone = ZONES[idx];

      if (gameObject.cornerX !== undefined) {
        // This is a resize handle
        const cx = gameObject.cornerX;
        const cy = gameObject.cornerY;
        const rect = this.debugGraphics[idx];

        // Opposite corner stays fixed
        const fixedX = zone.x - cx * (zone.w / 2);
        const fixedY = zone.y - cy * (zone.h / 2);

        // New width/height from fixed corner to drag position
        const newW = Math.max(20, Math.abs(dragX - fixedX));
        const newH = Math.max(20, Math.abs(dragY - fixedY));
        const newCenterX = (fixedX + dragX) / 2;
        const newCenterY = (fixedY + dragY) / 2;

        zone.x = Math.round(newCenterX);
        zone.y = Math.round(newCenterY);
        zone.w = Math.round(newW);
        zone.h = Math.round(newH);
      } else {
        // This is a box drag
        zone.x = Math.round(dragX);
        zone.y = Math.round(dragY);
      }

      this.refreshDebugZone(idx);
    });

    this.input.on('dragend', (pointer, gameObject) => {
      if (gameObject.zoneIndex === undefined && gameObject.torchIndex === undefined && gameObject.candleIndex === undefined) return;
      this._debugDragging = false;
      if (gameObject.zoneIndex !== undefined) {
        const idx = gameObject.zoneIndex;
        this.debugCoordReadouts[idx].setVisible(false);
      }
    });

    // Scroll wheel for torch scaling in debug mode
    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      if (!debugMode) return;
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      // Check if hovering over a torch
      for (const torch of this.torches) {
        const bounds = torch.getBounds();
        if (bounds.contains(worldPoint.x, worldPoint.y)) {
          const idx = torch.torchIndex;
          const pos = TORCH_POSITIONS[idx];
          const delta = deltaY > 0 ? -0.5 : 0.5;
          pos.scale = Phaser.Math.Clamp(pos.scale + delta, 0.5, 8.0);
          torch.setScale(pos.scale);
          this.updateTorchLabel(idx);
          this.updateDebugPanelText();
          return;
        }
      }
      // Check if hovering over a candle
      if (this.candles) {
        for (const candle of this.candles) {
          const bounds = candle.getBounds();
          if (bounds.contains(worldPoint.x, worldPoint.y)) {
            const idx = candle.candleIndex;
            const pos = CANDLE_POSITIONS[idx];
            const delta = deltaY > 0 ? -0.5 : 0.5;
            pos.scale = Phaser.Math.Clamp(pos.scale + delta, 0.5, 8.0);
            candle.setScale(pos.scale);
            this.updateCandleLabel(idx);
            this.updateDebugPanelText();
            return;
          }
        }
      }
    });

    // DEBUG ON indicator - fixed to camera
    this.debugIndicator = this.add.text(8, 24, 'DEBUG ON', {
      fontSize: '12px',
      fontFamily: 'monospace',
      color: '#00ff00',
      backgroundColor: 'rgba(0,0,0,0.7)',
      padding: { x: 6, y: 3 }
    }).setDepth(55).setScrollFactor(0).setVisible(false);

    // Debug output panel - fixed bottom-right
    this.createDebugPanel();
  }

  updateTorchLabel(idx) {
    const pos = TORCH_POSITIONS[idx];
    const label = this.torchLabels[idx];
    label.setText(`torch${idx}: x=${pos.x} y=${pos.y} scale=${pos.scale}`);
    label.setPosition(pos.x, pos.y - 30);
  }

  updateCandleLabel(idx) {
    const pos = CANDLE_POSITIONS[idx];
    const label = this.candleLabels[idx];
    label.setText(`candle${idx}: x=${pos.x} y=${pos.y} scale=${pos.scale}`);
    label.setPosition(pos.x, pos.y - 30);
  }

  refreshDebugZone(idx) {
    const zone = ZONES[idx];
    const rect = this.debugGraphics[idx];
    const label = this.debugLabels[idx];
    const readout = this.debugCoordReadouts[idx];
    const handles = this.debugHandles[idx];
    const tableBody = this.tableZones[idx];

    // Update debug rect
    rect.setPosition(zone.x, zone.y);
    rect.setSize(zone.w, zone.h);

    // Update label
    label.setText(`${zone.id}\n(${zone.x}, ${zone.y}, ${zone.w}x${zone.h})`);
    label.setPosition(zone.x, zone.y);

    // Update floating readout
    readout.setText(`x:${zone.x} y:${zone.y} w:${zone.w} h:${zone.h}`);
    readout.setPosition(zone.x, zone.y - zone.h / 2 - 10);
    readout.setVisible(true);

    // Update resize handles
    const corners = [
      { cx: -1, cy: -1 },
      { cx:  1, cy: -1 },
      { cx: -1, cy:  1 },
      { cx:  1, cy:  1 }
    ];
    for (let j = 0; j < 4; j++) {
      handles[j].setPosition(
        zone.x + corners[j].cx * (zone.w / 2),
        zone.y + corners[j].cy * (zone.h / 2)
      );
    }

    // Update physics body position and size
    tableBody.setPosition(zone.x, zone.y);
    tableBody.setSize(zone.w, zone.h);
    tableBody.body.updateFromGameObject();

    // Update panel text
    this.updateDebugPanelText();
  }

  createDebugPanel() {
    const panelW = 280;
    const panelH = 380;
    const panelX = VIEW_W - panelW - 8;
    const panelY = VIEW_H - panelH - 8;

    // Panel background
    this.debugPanelBg = this.add.rectangle(panelX + panelW / 2, panelY + panelH / 2, panelW, panelH, 0x000000, 0.85);
    this.debugPanelBg.setStrokeStyle(1, 0x00ff00, 0.6);
    this.debugPanelBg.setDepth(55);
    this.debugPanelBg.setScrollFactor(0);
    this.debugPanelBg.setVisible(false);

    // Panel text
    this.debugPanelText = this.add.text(panelX + 8, panelY + 6, '', {
      fontSize: '10px',
      fontFamily: 'monospace',
      color: '#00ff00',
      lineSpacing: 4
    }).setDepth(56).setScrollFactor(0).setVisible(false);

    // COPY button
    this.debugCopyBtn = this.add.text(panelX + panelW - 50, panelY + panelH - 22, ' COPY ', {
      fontSize: '10px',
      fontFamily: 'monospace',
      color: '#000000',
      backgroundColor: '#00ff00',
      padding: { x: 4, y: 2 }
    }).setDepth(56).setScrollFactor(0).setVisible(false);
    this.debugCopyBtn.setInteractive({ cursor: 'pointer' });
    this.debugCopyBtn.on('pointerdown', () => {
      const data = {};
      for (const zone of ZONES) {
        data[zone.id] = { x: zone.x, y: zone.y, w: zone.w, h: zone.h };
      }
      data.torches = TORCH_POSITIONS.map((p, i) => ({
        id: `torch${i}`, x: p.x, y: p.y, scale: p.scale
      }));
      data.candles = CANDLE_POSITIONS.map((p, i) => ({
        id: `candle${i}`, x: p.x, y: p.y, scale: p.scale
      }));
      navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
        this.debugCopyBtn.setText('COPIED');
        this.time.delayedCall(1000, () => this.debugCopyBtn.setText(' COPY '));
      });
    });

    this.updateDebugPanelText();
  }

  updateDebugPanelText() {
    if (!this.debugPanelText) return;
    const maxIdLen = Math.max(...ZONES.map(z => z.id.length));
    const lines = ZONES.map(z => {
      const padded = z.id.padEnd(maxIdLen);
      return `${padded}: x=${String(z.x).padStart(3)} y=${String(z.y).padStart(3)} w=${String(z.w).padStart(3)} h=${String(z.h).padStart(3)}`;
    });
    lines.push('--- TORCHES ---');
    for (let i = 0; i < TORCH_POSITIONS.length; i++) {
      const p = TORCH_POSITIONS[i];
      lines.push(`torch${i}: x=${String(p.x).padStart(3)} y=${String(p.y).padStart(3)} scale=${p.scale}`);
    }
    lines.push('--- CANDLES ---');
    for (let i = 0; i < CANDLE_POSITIONS.length; i++) {
      const p = CANDLE_POSITIONS[i];
      lines.push(`candle${i}: x=${String(p.x).padStart(3)} y=${String(p.y).padStart(3)} scale=${p.scale}`);
    }
    this.debugPanelText.setText(lines.join('\n'));
  }

  toggleDebug() {
    debugMode = !debugMode;
    for (const rect of this.debugGraphics) {
      rect.setVisible(debugMode);
    }
    for (const label of this.debugLabels) {
      label.setVisible(debugMode);
    }
    for (const handles of this.debugHandles) {
      for (const h of handles) h.setVisible(debugMode);
    }
    this.debugIndicator.setVisible(debugMode);
    this.debugPanelBg.setVisible(debugMode);
    this.debugPanelText.setVisible(debugMode);
    this.debugCopyBtn.setVisible(debugMode);

    // Toggle torch debug: interactive/draggable + labels
    for (let i = 0; i < this.torches.length; i++) {
      const torch = this.torches[i];
      if (debugMode) {
        torch.setInteractive({ draggable: true, cursor: 'move' });
        this.input.setDraggable(torch, true);
        this.updateTorchLabel(i);
        this.torchLabels[i].setVisible(true);
      } else {
        torch.disableInteractive();
        this.torchLabels[i].setVisible(false);
      }
    }

    // Toggle candle debug: interactive/draggable + labels
    if (this.candles) {
      for (let i = 0; i < this.candles.length; i++) {
        const candle = this.candles[i];
        if (debugMode) {
          candle.setInteractive({ draggable: true, cursor: 'move' });
          this.input.setDraggable(candle, true);
          this.updateCandleLabel(i);
          this.candleLabels[i].setVisible(true);
        } else {
          candle.disableInteractive();
          this.candleLabels[i].setVisible(false);
        }
      }
    }

    // Stop player movement when entering debug mode
    if (debugMode) {
      this.moveTarget = null;
      this.player.body.setVelocity(0, 0);
      isMoving = false;
      this.updateDebugPanelText();
    }
    // Hide any lingering readouts
    for (const readout of this.debugCoordReadouts) {
      readout.setVisible(false);
    }
  }

  setupInput() {
    this.escKey = this.input.keyboard.addKey('ESC');
    this.eKey = this.input.keyboard.addKey('E');
    this.dKey = this.input.keyboard.addKey('D');

    // Right-click to move; hold and drag to continuously update direction
    this.input.on('pointerdown', (pointer) => {
      if (!pointer.rightButtonDown()) return;
      if (modalOpen) return;
      if (debugMode) return;
      this.setMoveTarget(pointer);
    });

    this.input.on('pointermove', (pointer) => {
      if (!pointer.rightButtonDown()) return;
      if (modalOpen) return;
      if (debugMode) return;
      this.setMoveTarget(pointer);
    });
  }

  setMoveTarget(pointer) {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const targetX = Phaser.Math.Clamp(worldPoint.x, 0, WORLD_W);
    const targetY = Phaser.Math.Clamp(worldPoint.y, 0, WORLD_H);

    // Walk to edge of zone if targeting one; otherwise walk directly
    const clickedZone = this.getZoneAt(targetX, targetY);
    if (clickedZone) {
      const edgePoint = this.getZoneEdgePoint(clickedZone, this.player.x, this.player.y);
      this.moveTarget = { x: edgePoint.x, y: edgePoint.y };
      this.pendingZone = clickedZone;
    } else {
      this.moveTarget = { x: targetX, y: targetY };
      this.pendingZone = null;
    }
  }

  getZoneAt(wx, wy) {
    for (const zone of ZONES) {
      if (wx >= zone.x - zone.w / 2 && wx <= zone.x + zone.w / 2 &&
          wy >= zone.y - zone.h / 2 && wy <= zone.y + zone.h / 2) {
        return zone;
      }
    }
    return null;
  }

  getZoneEdgePoint(zone, px, py) {
    const pad = INTERACT_PADDING - 2;
    const angle = Math.atan2(py - zone.y, px - zone.x);
    const halfW = zone.w / 2 + pad;
    const halfH = zone.h / 2 + pad;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const tx = cosA !== 0 ? halfW / Math.abs(cosA) : Infinity;
    const ty = sinA !== 0 ? halfH / Math.abs(sinA) : Infinity;
    const t = Math.min(tx, ty);

    return {
      x: zone.x + cosA * t,
      y: zone.y + sinA * t
    };
  }

  setupModal() {
    const closeBtn = document.getElementById('modal-close');
    const csClose = document.getElementById('coming-soon-close');

    closeBtn.addEventListener('click', () => this.closeModal());
    csClose.addEventListener('click', () => this.closeComingSoon());
  }

  openGame(zone) {
    if (zone.type === 'game') {
      const modal = document.getElementById('game-modal');
      const iframe = document.getElementById('game-iframe');
      iframe.src = zone.url;
      modal.classList.add('active');
      modalOpen = true;
    } else {
      const cs = document.getElementById('coming-soon');
      document.getElementById('coming-soon-text').textContent =
        `${zone.label.replace('\n', ' ')} is under construction. Check back soon!`;
      cs.classList.add('active');
      modalOpen = true;
    }
  }

  closeModal() {
    const modal = document.getElementById('game-modal');
    const iframe = document.getElementById('game-iframe');
    modal.classList.remove('active');
    iframe.src = '';
    modalOpen = false;
  }

  closeComingSoon() {
    document.getElementById('coming-soon').classList.remove('active');
    modalOpen = false;
  }

  getNearbyZone() {
    const px = this.player.x;
    const py = this.player.y;

    for (const zone of ZONES) {
      const dx = Math.abs(px - zone.x);
      const dy = Math.abs(py - zone.y);
      if (dx < zone.w / 2 + INTERACT_PADDING && dy < zone.h / 2 + INTERACT_PADDING) {
        return zone;
      }
    }
    return null;
  }

  update() {
    if (modalOpen) {
      if (Phaser.Input.Keyboard.JustDown(this.escKey)) {
        this.closeModal();
        this.closeComingSoon();
      }
      this.player.body.setVelocity(0, 0);
      return;
    }

    // D key to toggle debug overlay
    if (Phaser.Input.Keyboard.JustDown(this.dKey)) {
      this.toggleDebug();
    }

    // E key to interact with nearby zone
    if (Phaser.Input.Keyboard.JustDown(this.eKey)) {
      const nearZone = this.getNearbyZone();
      if (nearZone && !isMoving) {
        this.openGame(nearZone);
        return;
      }
    }

    // Freeze player movement in debug mode
    if (debugMode) {
      this.player.body.setVelocity(0, 0);
      isMoving = false;
      this.nameLabel.setPosition(this.player.x, this.player.y - 40);
      return;
    }

    // Click-to-move
    if (this.moveTarget) {
      const dx = this.moveTarget.x - this.player.x;
      const dy = this.moveTarget.y - this.player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < ARRIVE_THRESHOLD) {
        this.player.body.setVelocity(0, 0);
        this.moveTarget = null;
        isMoving = false;

        if (this.pendingZone) {
          this.pendingZone = null;
        }
      } else {
        const angle = Math.atan2(dy, dx);
        currentDir = angleTo8Dir(angle);

        const vx = Math.cos(angle) * PLAYER_SPEED;
        const vy = Math.sin(angle) * PLAYER_SPEED;
        this.player.body.setVelocity(vx, vy);
        isMoving = true;
      }
    } else {
      this.player.body.setVelocity(0, 0);
      isMoving = false;
    }

    // Update sprite
    if (spritesLoaded && manifest) {
      if (isMoving) {
        const animKey = `walk_dir${currentDir}`;
        if (this.anims.exists(animKey)) {
          this.player.play(animKey, true);
        }
      } else {
        this.player.stop();
        const standKey = `stand_${currentDir}`;
        if (this.textures.exists(standKey)) {
          this.player.setTexture(standKey);
        }
      }
    }

    // Update name label position
    this.nameLabel.setPosition(this.player.x, this.player.y - 40);

    // Check interaction zone
    const nearZone = this.getNearbyZone();
    if (nearZone && !isMoving) {
      this.interactPrompt.setText(`Press E to sit at ${nearZone.label.replace('\n', ' ')}`);
      this.interactPrompt.setPosition(this.player.x, this.player.y - 55);
      this.interactPrompt.setVisible(true);

      if (!this._nearZoneClickRegistered) {
        this._nearZoneClickRegistered = true;
        this._nearZoneClickHandler = (pointer) => {
          if (modalOpen || !pointer.rightButtonDown()) return;
          const wp = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
          const clickedZone = this.getZoneAt(wp.x, wp.y);
          const stillNear = this.getNearbyZone();
          if (stillNear && clickedZone && clickedZone.id === stillNear.id) {
            this.openGame(stillNear);
          }
        };
        this.input.on('pointerdown', this._nearZoneClickHandler);
      }
    } else {
      this.interactPrompt.setVisible(false);
      if (this._nearZoneClickRegistered) {
        this.input.off('pointerdown', this._nearZoneClickHandler);
        this._nearZoneClickRegistered = false;
        this._nearZoneClickHandler = null;
      }
    }
  }
}

// Fetch manifest and determine sprite body BEFORE creating Phaser game
async function startGame() {
  try {
    const resp = await fetch('sprites/manifest.json?v=' + Date.now());
    manifest = await resp.json();
    const nameLower = playerName.toLowerCase();
    spriteBody = (manifest.bodies && manifest.bodies[nameLower]) ? nameLower : 'male';
  } catch (e) {
    // Manifest fetch failed - fall back to defaults (no character sprites)
    manifest = null;
    spriteBody = 'male';
  }

  // Phaser config - viewport is 800x600, world is 1024x1024
  const config = {
    type: Phaser.AUTO,
    width: VIEW_W,
    height: VIEW_H,
    parent: 'game-container',
    backgroundColor: '#1a0a00',
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { y: 0 },
        debug: false
      }
    },
    scene: CasinoScene,
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: VIEW_W,
      height: VIEW_H
    }
  };

  const game = new Phaser.Game(config);
}

startGame();
