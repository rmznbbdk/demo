// ---- Sabit oyun çözünürlüğü (siteye gömülü pencere için) ----
// Önceden oyun tüm ekranı kaplıyordu (RESIZE modu); artık game.html'deki
// #game-frame (1280x720 oranlı, ortalanmış, etrafı siyah + altında footer
// olan) kutunun içine tam oturuyor. Phaser bu sabit çözünürlüğü o kutuya
// göre otomatik ölçekliyor (Scale.FIT) — oranı bozmadan büyütüp küçültür.
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;

let config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    autoRound: true
  },
  scene: {
    preload: preload,
    create: create,
    update: update
  },
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 } }
  }
};

let game;
let SELECTED_SERVER_ID = null;

// ---- Sunucu seçim ekranı ----
// Oyun artık hemen başlamıyor; önce oyuncuya "hangi sunucu" seçimi
// gösteriliyor (AQW tarzı oda listesi). Seçim yapılınca gerçek Phaser
// oyunu (startGame) başlıyor. Not: bu sadece görsel bir seçim — arka
// planda tüm oyuncular hâlâ aynı paylaşımlı oyun dünyasında oynuyor,
// seçilen sunucu sadece sayaç/etiket olarak socket bağlantısına ekleniyor.
function startGame() {
  if (game) return; // zaten başlamışsa tekrar başlatma
  game = new Phaser.Game(config);
}

function renderServerRoomsUI(data) {
  const grid = document.getElementById('ss-grid');
  const subtitle = document.getElementById('ss-subtitle');
  if (!grid || !data || !Array.isArray(data.rooms)) return;

  if (subtitle) {
    subtitle.textContent = `${data.totalOnline.toLocaleString('tr-TR')} oyuncu şu an maceraya atılıyor!`;
  }

  grid.innerHTML = '';
  data.rooms.forEach(room => {
    const row = document.createElement('div');
    row.className = 'ss-row' + (room.full ? ' full' : '');

    const nameEl = document.createElement('div');
    nameEl.className = 'ss-name';
    nameEl.innerHTML = `<span>⚔️</span> ${room.name}`;

    const countEl = document.createElement('div');
    countEl.className = 'ss-count';
    countEl.innerHTML = room.full
      ? `<b>DOLU</b>Başka oda dene`
      : `<b>${room.count.toLocaleString('tr-TR')}</b>Sohbet Açık`;

    row.appendChild(nameEl);
    row.appendChild(countEl);

    if (!room.full) {
      row.addEventListener('click', () => chooseServer(room.id));
    }
    grid.appendChild(row);
  });
}

let serverRoomsPollTimer = null;

function chooseServer(roomId) {
  SELECTED_SERVER_ID = roomId;
  if (serverRoomsPollTimer) { clearInterval(serverRoomsPollTimer); serverRoomsPollTimer = null; }
  const overlay = document.getElementById('server-select-overlay');
  if (overlay) overlay.classList.add('hidden');
  const chatContainer = document.getElementById('chat-container');
  if (chatContainer) chatContainer.style.display = '';
  startGame();
}

function fetchServerRooms() {
  fetch('/api/server-rooms')
    .then(res => res.json())
    .then(data => renderServerRoomsUI(data))
    .catch(() => {
      // Sunucudan yanıt alınamazsa (ör. eski server.js hâlâ ayaktaysa) yine de
      // seçim ekranı kilitli kalmasın diye basit bir yedek liste gösteriyoruz.
      renderServerRoomsUI({
        totalOnline: 2510,
        rooms: [
          { id: 'oda1', name: 'Anka', count: 1240, full: false },
          { id: 'oda2', name: 'Kaan', count: 860, full: false },
          { id: 'oda3', name: 'Zümrüt', count: 410, full: false }
        ]
      });
    });
}

function initServerSelectScreen() {
  fetchServerRooms();
  serverRoomsPollTimer = setInterval(fetchServerRooms, 5000);
}
let socket;
let player;
let playerNameText;
let otherPlayers = {};
let otherPlayersNames = {};
let otherPlayersHealthBars = {}; // id -> { bar, label }
let chatMessages = {}; // id -> bubble container
let lastChatAt = 0; // istemci tarafı 5 sn sohbet cooldown
let cursors;
let token;
let target = null;
let healthText;
let health = 100;
let healthBar;
let countdownText;
let restartButton;
let isDead = false;
let attackEffects = {};
let gold = 0;
let playerLevel = 1;
let bossKills = 0;
let playerProfile;
let inventoryOpen = false;
let inventoryContainer;
let inventoryItems = [];
let swordSprite;
let equippedItems = { weapon: null, armor: null, accessory: null };
let isAttacking = false; // csa1/csa2/csa3 vuruş animasyonu oynarken true
let isChatFocused = false;
let pvpEnabled = false;
let totalBossKills = 0;
let claimedQuests = [];
let sideMenuContainer;
let shopContainer;
let questsContainer;
let infoContainer;
let activeInventoryTab = 'weapon';
let pvpButtonText = null;
let shopScene = null;
let questsScene = null;
let playerDefense = 0;
let playerDirection = 'right';
let npc;
let exclamationMark;
let mapContainer;
let boss;
let bossNameText;
let bossHealthText;
let bossHealthBar;
let bossHealthBarBg;
let bossHealthBarBorder;
let currentMap = 'main';
let mainMap;

// ------- Skill Sistemi (AQW tarzı 5 skilllik savaş çubuğu) -------
// Görsel eklemene gerek yok; ikonlar Phaser çizimleriyle oluşturuluyor.
// dmgMult: temel saldırı gücünün çarpanı. type 'heal' olan skill kendi canını yeniler.
const SKILLS = [
  { id: 1, keyName: 'ONE',   digit: '1', name: 'Kılıç Vuruşu',  color: 0xff5555, cooldown: 800,   range: 100, type: 'attack', dmgMult: 1,   desc: 'Hızlı temel saldırı' },
  { id: 2, keyName: 'TWO',   digit: '2', name: 'Ateş Topu',     color: 0xff9900, cooldown: 3000,  range: 220, type: 'attack', dmgMult: 1.8, desc: 'Yanan hasar' },
  { id: 3, keyName: 'THREE', digit: '3', name: 'Buz Zinciri',   color: 0x33ccff, cooldown: 5000,  range: 220, type: 'attack', dmgMult: 1.4, desc: 'Dondurucu hasar' },
  { id: 4, keyName: 'FOUR',  digit: '4', name: 'Şifa Dalgası',  color: 0x33ff77, cooldown: 8000,  range: 0,   type: 'heal',   healAmount: 30, desc: 'Kendini iyileştirir' },
  { id: 5, keyName: 'FIVE',  digit: '5', name: 'Yıkım Darbesi', color: 0xaa33ff, cooldown: 12000, range: 260, type: 'attack', dmgMult: 3,   desc: 'Güçlü nihai saldırı' }
];
let skillBarContainer;
let skillSlots = []; // { root, cooldownOverlay, cooldownText }
let skillReadyAt = [0, 0, 0, 0, 0]; // scene.time.now zaman damgaları

// ------- Eşya Sistemi (rarity/nadirlik) - server.js ITEM_CATALOG ile birebir eşleşmeli -------
// textureKey: mevcut .png dosyalarından biri (yeni görsel gerekmez).
// icon: procedural (kod içinde çizilen) ikon anahtarı, generateIconTextures() içinde üretilir.
// tint: aynı görseli farklı nadirlik renginde göstermek için (yeni dosya gerektirmez).
// Oyun artık tek eşyalı: sadece kılıç (sw1.png). Diğer tüm eşyalar
// (zırh, iksir, yüzük, tılsım, ekstra kılıçlar) kaldırıldı.
const ITEM_VISUALS = {
  sword: { textureKey: 'sw1' }
};
const ITEM_NAMES = {
  sword: 'Kılıç'
};
const RARITY_COLORS = { common: 0x999999, rare: 0x3399ff, epic: 0xaa33ff, legendary: 0xffaa00 };
const RARITY_LABELS = { common: 'Sıradan', rare: 'Nadir', epic: 'Destansı', legendary: 'Efsanevi' };

// ---------------- AQW TARZI SÜSLÜ ÇERÇEVE YARDIMCILARI ----------------
// Bu üç fonksiyon envanter/mağaza/skill barındaki tüm kutuların ortak görsel
// dilini oluşturuyor: koyu metalik taban + nadirlik renginde çift kontur
// (bevel hissi) + köşelerde küçük elmas aksanlar. Sadece görsel katman
// ekliyorlar; hiçbir tıklama/oyun mantığını değiştirmiyorlar.
function drawDiamond(g, cx, cy, r, color) {
  g.fillStyle(color, 1);
  g.beginPath();
  g.moveTo(cx, cy - r);
  g.lineTo(cx + r, cy);
  g.lineTo(cx, cy + r);
  g.lineTo(cx - r, cy);
  g.closePath();
  g.fillPath();
}

// Küçük/orta kutular için (envanter yuvası, mağaza kartı, skill ikonu).
// size = genişlik; opts.height verilirse dikdörtgen (kare değil) kutu çizer.
function drawFancyFrame(scene, container, cx, cy, size, rarityColor, opts) {
  opts = opts || {};
  const r = opts.radius != null ? opts.radius : 8;
  const w = size;
  const h = opts.height != null ? opts.height : size;
  const frame = scene.add.graphics();

  // Koyu metalik taban + üstte hafif parlama şeridi (ışık yansıması hissi)
  frame.fillStyle(0x0d0d12, 0.95);
  frame.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
  frame.fillStyle(0xffffff, 0.06);
  frame.fillRoundedRect(cx - w / 2 + 2, cy - h / 2 + 2, w - 4, h * 0.32, Math.max(2, r * 0.6));

  // Nadirlik rengi: dış parlak kontur + iç ince koyu kontur (bevel/gömme hissi)
  frame.lineStyle(2.5, rarityColor, 1);
  frame.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
  frame.lineStyle(1, 0x000000, 0.65);
  frame.strokeRoundedRect(cx - w / 2 + 3, cy - h / 2 + 3, w - 6, h - 6, Math.max(2, r - 3));

  container.add(frame);

  if (!opts.noCorners && w >= 40 && h >= 40) {
    const accents = scene.add.graphics();
    const cs = w >= 56 ? 4 : 3;
    [
      [cx - w / 2 + 4, cy - h / 2 + 4],
      [cx + w / 2 - 4, cy - h / 2 + 4],
      [cx - w / 2 + 4, cy + h / 2 - 4],
      [cx + w / 2 - 4, cy + h / 2 - 4]
    ].forEach(([px, py]) => drawDiamond(accents, px, py, cs, rarityColor));
    container.add(accents);
  }

  return frame;
}

// Büyük paneller için (envanter/mağaza pencereleri): çift kontur + 4 köşede
// büyükçe altın elmas aksan, klasik "süslü pencere" hissi verir.
function drawPanelFrame(scene, container, w, h, borderColor) {
  const bg = scene.add.graphics();
  bg.fillStyle(0x0a0a0a, 0.93);
  bg.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
  bg.lineStyle(2, borderColor, 0.95);
  bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
  bg.lineStyle(1, 0x000000, 0.7);
  bg.strokeRoundedRect(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 10);
  container.add(bg);

  const accents = scene.add.graphics();
  [
    [-w / 2 + 12, -h / 2 + 12],
    [w / 2 - 12, -h / 2 + 12],
    [-w / 2 + 12, h / 2 - 12],
    [w / 2 - 12, h / 2 - 12]
  ].forEach(([px, py]) => drawDiamond(accents, px, py, 6, borderColor));
  container.add(accents);

  return bg;
}

// Skill fırlatma efekti için texture key. Şimdilik procedural (koddan çizilen)
// bir görsel kullanıyoruz; ileride kendi PNG'ini eklersen preload() içine
// this.load.image('skill_projectile', 'senin-dosyan.png') satırını ekleyip
// bu texture'ı otomatik override edebilirsin, başka hiçbir yeri değiştirmene
// gerek kalmaz.
const SKILL_PROJECTILE_TEXTURE = 'skill_projectile';

function itemDisplayName(id) { return ITEM_NAMES[id] || id; }
function getItemVisual(id) { return ITEM_VISUALS[id] || { icon: 'icon_potion' }; }

// Mağazada satılan eşyalar (server.js SHOP_ITEM_IDS + ITEM_CATALOG ile aynı değerler).
// Artık tek ürün var: bedava kılıç (sw1.png).
const SHOP_CATALOG = [
  { id: 'sword', type: 'weapon', rarity: 'common', price: 0, attackPower: 10, desc: 'Başlangıç kılıcı' }
];

// Görevler (server.js QUESTS ile aynı id/target/reward).
const QUESTS = [
  { id: 'q1', name: 'Çırak Avcı', target: 3, reward: 15 },
  { id: 'q2', name: 'Canavar Avcısı', target: 10, reward: 40 },
  { id: 'q3', name: 'Şampiyon', target: 25, reward: 100 },
  { id: 'q4', name: 'Efsane Savaşçı', target: 50, reward: 250 }
];

// 5 Boss Haritası ayarları (server.js ile aynı id/isimler).
// Görselleri değiştirmek için sadece bu dosya adlarındaki .png'leri
// kendi resimlerinle değiştir, kod tarafına dokunmana gerek yok:
//   boss_map1.png / boss1.png ... boss_map5.png / boss5.png
const BOSS_MAPS = [
  { id: 'boss1', name: 'Ejderha Vadisi',  mapImageKey: 'boss_map1', bossImageKey: 'boss1', spawnX: 1000, spawnY: 500, color: 0xff4444 },
  { id: 'boss2', name: 'Buz Mağarası',    mapImageKey: 'boss_map2', bossImageKey: 'boss2', spawnX: 1000, spawnY: 500, color: 0x44c8ff },
  
];
const BOSS_MAP_IDS = BOSS_MAPS.map(m => m.id);

// ---------------- YÜRÜNEBİLİR ALAN (sadece yollar) ----------------
// Bir haritaya kısıt eklemek için WALK_AREAS içine o haritanın id'sini
// yazman yeterli. Koordinatlar ORİJİNAL harita resminin piksel değerleridir
// (boss_map2.png = 1429x736). Oyun ekranına oranlanarak otomatik çevrilir,
// yani ekran boyutu değişse de doğru çalışır.
//   area    = karakterin ayaklarının basabileceği yol/zemin poligonu
//   blocked = yol içindeki engeller (çalı, kaya, fener, şeker bastonu)
// WALK_AREAS'ta olmayan haritalarda hiçbir kısıt yoktur.
// refW/refH = o haritanın orijinal resim boyutu.
// 'main' = lobi (maps.png), 'boss1' = boss_map.png, 'boss2' = boss_map2.png
const WALK_AREAS = {
  main: {
    refW: 1373, refH: 691,
    area: [
      [0,691],[0,540],[200,515],[240,475],[612,470],[612,425],[700,418],
      [735,430],[800,405],[880,402],[1000,412],[1090,445],[1090,548],
      [1373,548],[1373,691]
    ],
    blocked: []
  },
  boss1: {
    refW: 1439, refH: 720,
    area: [
      [0,720],[0,455],[180,448],[350,440],[650,432],[700,445],[760,500],
      [850,500],[940,492],[1130,492],[1200,472],[1439,472],[1439,720]
    ],
    blocked: []
  },
  boss2: {
    refW: 1429, refH: 736,
    area: [
      [0,736],[0,376],[230,398],[305,390],[305,290],[332,266],[420,244],
      [500,228],[545,222],[565,238],[690,240],[700,268],[800,272],[830,270],
      [830,332],[930,340],[958,366],[1210,366],[1290,372],[1429,372],[1429,736]
    ],
    blocked: [
      [[75,310],[185,310],[185,405],[80,405]],                                   // sol çalı
      [[605,395],[725,395],[730,490],[700,522],[630,520],[605,480]],             // orta çalı
      [[500,510],[615,510],[615,545],[500,545]],                                 // büyük kaya
      [[175,522],[252,522],[252,546],[175,546]],                                 // sol kaya
      [[1085,330],[1160,330],[1160,392],[1085,392]],                             // fener
      [[1145,300],[1195,300],[1195,432],[1148,432]],                             // şeker bastonu
      [[1175,340],[1290,340],[1295,466],[1175,470]]                              // sağ çalı
    ]
  }
};

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function getWalkMapImage(mapId) {
  return mapId === 'main' ? mainMap : bossMapImages[mapId];
}

function hasWalkLimit(mapId) {
  return !!(WALK_AREAS[mapId] && getWalkMapImage(mapId));
}

// Oyun koordinatındaki (gx, gy) noktası yol üzerinde mi?
function isWalkableAt(mapId, gx, gy) {
  const cfg = WALK_AREAS[mapId];
  const img = getWalkMapImage(mapId);
  if (!cfg || !img) return true; // kısıt yoksa her yer serbest
  const left = img.x - img.displayWidth / 2;
  const top = img.y - img.displayHeight / 2;
  const ix = ((gx - left) / img.displayWidth) * cfg.refW;
  const iy = ((gy - top) / img.displayHeight) * cfg.refH;
  if (!pointInPolygon(ix, iy, cfg.area)) return false;
  for (const b of cfg.blocked) {
    if (pointInPolygon(ix, iy, b)) return false;
  }
  return true;
}

// Karakterin "ayak" noktası (sprite merkezinin biraz altı).
function getPlayerFeet(px, py) {
  const h = player ? player.displayHeight : 0;
  return { x: px, y: py + h / 2 - 4 };
}

function canPlayerStandAt(px, py) {
  const f = getPlayerFeet(px, py);
  return isWalkableAt(currentMap, f.x, f.y);
}

// Karakter yasak bölgedeyse (ışınlanma/yeniden doğma vb.) en yakın yola taşır.
function snapPlayerToWalkable() {
  if (canPlayerStandAt(player.x, player.y)) return false;
  for (let r = 6; r <= 700; r += 6) {
    for (let a = 0; a < 360; a += 15) {
      const nx = player.x + Math.cos(Phaser.Math.DegToRad(a)) * r;
      const ny = player.y + Math.sin(Phaser.Math.DegToRad(a)) * r;
      if (canPlayerStandAt(nx, ny)) {
        player.x = nx;
        player.y = ny;
        return true;
      }
    }
  }
  return false;
}

// Hedefe doğru yürütür ama yol dışına çıkacaksa engeller (kenar boyunca
// kayabilir, hiç ilerleyemiyorsa durur).
function movePlayerToward(scene, speed) {
  if (!hasWalkLimit(currentMap)) {
    scene.physics.moveTo(player, target.x, target.y, speed);
    return;
  }
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const L = 8; // ileriye bakma mesafesi (px)

  if (canPlayerStandAt(player.x + ux * L, player.y + uy * L)) {
    scene.physics.moveTo(player, target.x, target.y, speed);
  } else if (Math.abs(dx) > 4 && canPlayerStandAt(player.x + Math.sign(dx) * L, player.y)) {
    player.setVelocity(Math.sign(dx) * speed, 0);
  } else if (Math.abs(dy) > 4 && canPlayerStandAt(player.x, player.y + Math.sign(dy) * L)) {
    player.setVelocity(0, Math.sign(dy) * speed);
  } else {
    player.setVelocity(0);
    target = null;
  }
}
let bossMapImages = {};   // mapId -> Phaser Image (harita görseli)
let bossDataMap = {};     // mapId -> son alınan boss verisi (health, vs.)

function preload() {
  this.load.image('main_map', 'maps.png');

  // Tek karakter: c1/c2/c3 = kılıçsız yürüme efekti kareleri (c1 = duruş/idle).
  this.load.image('c1', 'c1.png');
  this.load.image('c2', 'c2.png');
  this.load.image('c3', 'c3.png');
  // csw1/csw2/csw3 = kılıç kuşanınca yürüme efekti kareleri (csw1 = duruş/idle).
  this.load.image('csw1', 'csw1.png');
  this.load.image('csw2', 'csw2.png');
  this.load.image('csw3', 'csw3.png');
  // csa1/csa2/csa3 = kılıçla vuruş (saldırı) efekti kareleri.
  this.load.image('csa1', 'csa1.png');
  this.load.image('csa2', 'csa2.png');
  this.load.image('csa3', 'csa3.png');
  // sw1 = mağaza/envanterdeki kılıç ikonu. 'sword' anahtarı da aynı görsele
  // bağlanır (eski kod bazı yerlerde hâlâ bu anahtarı kullanıyor).
  this.load.image('sw1', 'sw1.png');
  this.load.image('sword', 'sw1.png');

  this.load.image('inventory_bg', 'inventory_bg.png');
  this.load.image('attackEffect', 'attack_effect.png');
  this.load.image('npc', 'npc.png');
  this.load.image('exclamation', 'exclamation.png');
  this.load.image('map_ui', 'map_ui.png');

  // 5 boss haritası + boss görseli. boss1/boss_map1 eski tek boss ile
  // aynı dosya adlarını kullanıyor (boss.png, boss_map.png) yani hiçbir
  // dosya kaybı olmuyor; boss2-5 için 4 yeni görsel çifti eklemen yeterli.
  this.load.image('boss_map1', 'boss_map.png');
  this.load.image('boss1', 'boss.png');
  this.load.image('boss_map2', 'boss_map2.png');
  this.load.image('boss2', 'boss2.png');
  this.load.image('boss_map3', 'boss_map3.png');
  this.load.image('boss3', 'boss3.png');
  this.load.image('boss_map4', 'boss_map4.png');
  this.load.image('boss4', 'boss4.png');
  this.load.image('boss_map5', 'boss_map5.png');
  this.load.image('boss5', 'boss5.png');
}

// Yeni görsel dosyası eklemeden (potion/yüzük/tılsım gibi) eşyalar için basit
// ikonlar üretir. Sadece bir kere çalışır (texture zaten varsa atlar).
function generateIconTextures(scene) {
  const make = (key, size, drawFn) => {
    if (scene.textures.exists(key)) return;
    const g = scene.add.graphics();
    drawFn(g, size);
    g.generateTexture(key, size, size);
    g.destroy();
  };
  make('icon_potion', 32, (g, s) => {
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(s * 0.32, s * 0.12, s * 0.36, s * 0.22, 3);
    g.fillStyle(0xff4444, 1);
    g.fillRoundedRect(s * 0.18, s * 0.38, s * 0.64, s * 0.5, 6);
    g.lineStyle(2, 0x220000, 1);
    g.strokeRoundedRect(s * 0.18, s * 0.38, s * 0.64, s * 0.5, 6);
    // Cam parlaması: sol üstte hafif beyaz şerit
    g.fillStyle(0xffffff, 0.35);
    g.fillRoundedRect(s * 0.24, s * 0.44, s * 0.1, s * 0.3, 3);
  });
  make('icon_ring', 32, (g, s) => {
    g.lineStyle(4, 0xffd700, 1);
    g.strokeCircle(s / 2, s * 0.58, s * 0.28);
    g.lineStyle(1.5, 0xfff2a8, 0.8);
    g.strokeCircle(s / 2, s * 0.58, s * 0.2);
    g.fillStyle(0x66ccff, 1);
    g.fillCircle(s / 2, s * 0.24, s * 0.1);
    g.fillStyle(0xffffff, 0.6);
    g.fillCircle(s / 2 - s * 0.03, s * 0.21, s * 0.03);
  });
  make('icon_amulet', 32, (g, s) => {
    g.lineStyle(3, 0xcccccc, 1);
    g.strokeCircle(s / 2, s * 0.26, s * 0.12);
    g.fillStyle(0x66ccff, 1);
    g.fillTriangle(s * 0.5, s * 0.32, s * 0.28, s * 0.86, s * 0.72, s * 0.86);
    g.lineStyle(1.5, 0x224466, 1);
    g.strokeTriangle(s * 0.5, s * 0.32, s * 0.28, s * 0.86, s * 0.72, s * 0.86);
    g.fillStyle(0xffffff, 0.5);
    g.fillTriangle(s * 0.5, s * 0.4, s * 0.42, s * 0.66, s * 0.5, s * 0.66);
  });
  // Skill "fırlatma" (projectile) için GEÇİCİ görsel — parlayan bir top.
  // Gerçek PNG'lerini eklediğinde SKILL_PROJECTILE_TEXTURE sabitini kendi
  // texture key'inle değiştirmen yeterli, geri kalan sistem aynı kalır.
  make(SKILL_PROJECTILE_TEXTURE, 24, (g, s) => {
    g.fillStyle(0xffffff, 0.35);
    g.fillCircle(s / 2, s / 2, s / 2);
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(s / 2, s / 2, s * 0.28);
  });
}

function isAnyPanelOpen() {
  return inventoryOpen || !!mapContainer || !!shopContainer || !!questsContainer || !!infoContainer;
}

function closeAllPanels() {
  closeInventory();
  closeMap();
  closeShop();
  closeQuests();
  closeInfoPopup();
}

function create() {
  generateIconTextures(this);
  token = localStorage.getItem('token');
  const x = parseInt(localStorage.getItem('x')) || GAME_WIDTH / 2;
  const y = parseInt(localStorage.getItem('y')) || GAME_HEIGHT / 2;
  gold = parseInt(localStorage.getItem('gold')) || 0;
  playerLevel = parseInt(localStorage.getItem('level')) || 1;
  bossKills = parseInt(localStorage.getItem('bossKills')) || 0;
  equippedItems = JSON.parse(localStorage.getItem('equipped')) || { weapon: null, armor: null, accessory: null };

  if (!token) {
    window.location.href = '/';
    return;
  }

  socket = io({ query: { server: SELECTED_SERVER_ID || 'oda1' } });

  mainMap = this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'main_map').setVisible(true);
  coverImage(mainMap, GAME_WIDTH, GAME_HEIGHT);
  BOSS_MAPS.forEach(cfg => {
    bossMapImages[cfg.id] = this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, cfg.mapImageKey).setVisible(false);
    coverImage(bossMapImages[cfg.id], GAME_WIDTH, GAME_HEIGHT);
  });

  player = this.physics.add.sprite(x, y, equippedItems.weapon ? 'csw1' : 'c1');
  player.setCollideWorldBounds(true);
  player.setScale(1);

  // Karakter animasyonları: kılıçsız yürüme (c1/c2/c3), kılıçlı yürüme
  // (csw1/csw2/csw3) ve kılıçla vuruş (csa1/csa2/csa3, bir kere oynar).
  createCharacterAnims(this);

  // Eski "yüzen kılıç" sprite'ı artık görsel olarak kullanılmıyor (kılıç
  // artık karakterin kendi animasyon karelerinde gösteriliyor), ama diğer
  // kodun bu değişkene referans veren yerlerinin bozulmaması için nesne
  // olarak tutuluyor — applyWeaponVisual() onu her zaman gizli tutar.
  swordSprite = this.add.sprite(x + (playerDirection === 'right' ? 20 : -20), y, 'sword').setVisible(false);
  swordSprite.setScale(playerDirection === 'right' ? 1 : -1);
  swordSprite.setDepth(2);
  applyWeaponVisual(swordSprite, equippedItems);

  const playerHeight = player.displayHeight;
  playerNameText = this.add.text(x, y - playerHeight / 2 - 28, '', {
    fontSize: '14px', color: '#FFD700', fontStyle: 'bold',
    stroke: '#000000', strokeThickness: 3
  }).setOrigin(0.5).setDepth(3);
  healthBar = this.add.rectangle(x, y - playerHeight / 2 - 12, 52, 7, 0xff0000).setDepth(3);
  player.setDepth(1);

  playerProfile = createPlayerProfile(this, GAME_WIDTH - PROFILE_W / 2 - 14, PROFILE_H / 2 + 14, '');
  playerProfile.setVisible(false);

  sideMenuContainer = createSideMenu(this);
  positionSideMenu(GAME_WIDTH);
  sideMenuContainer.setVisible(false);

  healthText = this.add.text(10, 10, `Can: ${health}`, { fontSize: '20px', color: '#ffffff' });

  skillBarContainer = createSkillBar(this);

  npc = this.add.sprite(550, 300, 'npc').setScale(1).setInteractive();
  exclamationMark = this.add.sprite(560, 220, 'exclamation').setScale(0.5).setInteractive();
  npc.setDepth(1);
  exclamationMark.setDepth(2);

  // NPC üzerindeki eski harita açma işlevini kaldırıyoruz, artık M tuşuyla olacak
  exclamationMark.on('pointerdown', () => {
    // NPC'ye başka bir işlev ekleyebilirsin, şimdilik boş bırakıyorum
  });

  cursors = this.input.keyboard.createCursorKeys();
  // createCursorKeys() SPACE tuşunu da otomatik olarak "capture" eder — yani
  // Phaser tarayıcının varsayılan davranışını (input kutusuna boşluk yazmak
  // dahil) SESSİZCE engeller, chat kutusu odakta olsa bile. cursors zaten
  // hareket için kullanılmıyor (tıklayarak hareket sistemi var), o yüzden bu
  // capture'ı kaldırıyoruz — asıl "chat'te boşluk çalışmıyor" sorununun kök
  // nedeni buydu.
  this.input.keyboard.removeCapture('SPACE');

  // M tuşuna basınca harita açılması
  this.input.keyboard.on('keydown-M', () => {
    if (!isDead && !isChatFocused) {
      if (mapContainer) {
        closeMap();
      } else if (!isAnyPanelOpen()) {
        openMap(this);
      }
    }
  });

  this.input.keyboard.on('keydown-E', () => {
    if (!isDead && !isChatFocused) {
      if (inventoryOpen) {
        closeInventory();
      } else if (!isAnyPanelOpen()) {
        openInventory(this, inventoryItems, equippedItems);
      }
    }
  });

  // 1-5 tuşları: skill çubuğundaki 5 skilli kullan (AQW tarzı savaş)
  SKILLS.forEach((skill, index) => {
    this.input.keyboard.on(`keydown-${skill.keyName}`, () => {
      useSkill(this, index);
    });
  });

  // Ekran boyutu değiştiğinde (döndürme, tarayıcı yeniden boyutlandırma vb.)
  // arayüzü ve haritayı yeniden konumlandırarak görüntünün bozulmasını engeller.
  this.scale.on('resize', (gameSize) => {
    handleResize(this, gameSize.width, gameSize.height);
  });
  handleResize(this, GAME_WIDTH, GAME_HEIGHT); // ilk açılışta dünya sınırlarını/kamerayı garantiye al

  this.input.on('pointerdown', (pointer) => {
    if (player && !isDead) {
      if (!isAnyPanelOpen()) {
        target = { x: pointer.x, y: pointer.y };
        if (target.x > player.x) {
          playerDirection = 'right';
          player.scaleX = 1;
          swordSprite.x = player.x + 20;
          swordSprite.scaleX = 1;
        } else if (target.x < player.x) {
          playerDirection = 'left';
          player.scaleX = -1;
          swordSprite.x = player.x - 20;
          swordSprite.scaleX = -1;
        }
      }
    }
  });

  // Boşluk tuşu ile kılıç saldırısı SADECE sohbet kutusu boşta iken çalışır.
  // Phaser varsayılan olarak SPACE tuşunu "capture" edip tarayıcının kendi
  // davranışını (input kutusuna boşluk yazma dahil) engeller; bu yüzden
  // sohbete odaklanınca bu capture'ı geçici olarak kapatıyoruz (aşağıda).
  this.input.keyboard.on('keydown-SPACE', () => {
    if (isChatFocused) return;
    useSkill(this, 0);
  });

  const chatInput = document.getElementById('chat-input');
  const chatMessagesPanel = document.getElementById('chat-messages');
  if (chatMessagesPanel) chatMessagesPanel.innerHTML = '';

  if (chatInput) {
    // EN ÖNEMLİSİ: keydown olayını input kutusunun kendisinde durdurup
    // (stopPropagation) Phaser'ın window'a bağlı global klavye dinleyicisine
    // hiç ulaşmasını engelliyoruz. Böylece Phaser'ın SPACE tuşu için yaptığı
    // "capture" (tarayıcı varsayılanını engelleme) hiç devreye girmiyor ve
    // boşluk tuşu input kutusuna her zaman normal şekilde yazılabiliyor.
    // Bu, sadece keyboard.enabled'ı kapatmaktan daha güvenilir bir çözüm.
    chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    chatInput.addEventListener('focus', () => {
      isChatFocused = true;
      if (this.input && this.input.keyboard) this.input.keyboard.enabled = false;
    });
    chatInput.addEventListener('blur', () => {
      isChatFocused = false;
      if (this.input && this.input.keyboard) this.input.keyboard.enabled = true;
    });
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        let msg = chatInput.value.trim();
        if (!msg) return;
        if (msg.length > 150) msg = msg.slice(0, 150);
        const now = Date.now();
        if (now - lastChatAt < 5000) {
          showToast(this, '5 saniyede bir mesaj gönderebilirsin.');
          return;
        }
        lastChatAt = now;
        socket.emit('chatMessage', msg);
        chatInput.value = '';
      }
    });
  }

  socket.emit('join', { token });

  socket.on('currentPlayers', (players) => {
    Object.keys(otherPlayers).forEach(id => removeOtherPlayer(id));
    Object.keys(players).forEach((id) => {
      if (id === socket.id) {
        playerNameText.setText(players[id].username);
        gold = players[id].gold;
        playerLevel = players[id].level;
        bossKills = players[id].bossKills;
        totalBossKills = players[id].totalBossKills || 0;
        claimedQuests = players[id].claimedQuests || [];
        pvpEnabled = players[id].pvpEnabled || false;
        inventoryItems = players[id].inventory;
        equippedItems = players[id].equipped;
        applyWeaponVisual(swordSprite, equippedItems);
        updatePlayerCharacter();
        updatePlayerDefense();
        updatePlayerProfile(playerProfile, players[id].username, players[id].health, players[id].gold, equippedItems, playerLevel, bossKills);
        playerProfile.setVisible(true);
        sideMenuContainer.setVisible(true);
        updatePvpButtonLabel();
        playerDirection = players[id].direction;
        player.scaleX = playerDirection === 'right' ? 1 : -1;
        swordSprite.x = player.x + (playerDirection === 'right' ? 20 : -20);
        swordSprite.scaleX = playerDirection === 'right' ? 1 : -1;
        currentMap = players[id].currentMap;
      } else if (players[id].currentMap === currentMap) {
        addOtherPlayer(this, id, players[id]);
      }
    });
  });

  socket.on('newPlayer', (data) => {
    if (data.id !== socket.id && data.currentMap === currentMap) {
      addOtherPlayer(this, data.id, data);
    }
  });

  socket.on('playerMoved', (data) => {
    if (otherPlayers[data.id] && data.currentMap === currentMap) {
      const otherPlayer = otherPlayers[data.id];
      otherPlayer.setPosition(data.x, data.y);
      const playerHeight = otherPlayer.displayHeight;
      if (otherPlayersNames[data.id]) {
        otherPlayersNames[data.id].setPosition(data.x, data.y - playerHeight / 2 - 28);
      }
      if (otherPlayersHealthBars[data.id]) {
        const hb = otherPlayersHealthBars[data.id];
        const hy = data.y - playerHeight / 2 - 12;
        if (hb.barBg) hb.barBg.setPosition(data.x, hy);
        if (hb.barFill) hb.barFill.setPosition(data.x - 26, hy);
        if (hb.hpText) hb.hpText.setPosition(data.x, hy);
      }
      if (chatMessages[data.id]) {
        chatMessages[data.id].setPosition(data.x, data.y - playerHeight / 2 - 52);
      }
      otherPlayer.scaleX = data.direction === 'right' ? 1 : -1;
      otherPlayer.direction = data.direction;

      // Bir hareket paketi geldiğinde kısa süreliğine yürüme animasyonunu
      // oynat; ardı arkasına paket gelmezse (durduysa) duruş karesine dön.
      const walkKey = getWalkAnimKey(otherPlayer.equipped);
      if (!otherPlayer.anims.isPlaying || !otherPlayer.anims.currentAnim || otherPlayer.anims.currentAnim.key !== walkKey) {
        otherPlayer.anims.play(walkKey, true);
      }
      if (otherPlayer.idleTimer) otherPlayer.idleTimer.remove(false);
      otherPlayer.idleTimer = this.time.delayedCall(220, () => {
        if (otherPlayer && otherPlayer.anims) {
          otherPlayer.anims.stop();
          otherPlayer.setTexture(getCharacterTexture(otherPlayer.equipped));
        }
      });
    }
  });

  socket.on('playerHealthUpdate', (data) => {
    if (data.id === socket.id) {
      health = data.health;
      healthText.setText(`Can: ${health}`);
      healthBar.width = 50 * (health / 100);
      setProfileHealth(playerProfile, health);
    } else if (otherPlayers[data.id]) {
      otherPlayers[data.id].health = data.health;
      const hb = otherPlayersHealthBars[data.id];
      if (hb) {
        const hp = Math.max(0, data.health);
        if (hb.barFill) hb.barFill.width = 52 * (hp / 100);
        if (hb.hpText) hb.hpText.setText(`${Math.round(hp)}`);
      }
    }
  });

  socket.on('goldUpdate', (data) => {
    if (data.id === socket.id) {
      gold = data.gold;
      playerProfile.getByName('goldText').setText(`Altın: ${gold}`);
      localStorage.setItem('gold', gold);
      if (shopContainer) refreshShopPanel();
    }
  });

  socket.on('levelUp', (data) => {
    if (data.id === socket.id) {
      playerLevel = data.level;
      playerProfile.getByName('levelBadgeText').setText(`${playerLevel}`);
      localStorage.setItem('level', playerLevel);
    }
  });

  socket.on('bossKillsUpdate', (data) => {
    if (data.id === socket.id) {
      bossKills = data.bossKills;
      setProfileBossKills(playerProfile, bossKills);
      localStorage.setItem('bossKills', bossKills);
    }
  });

  socket.on('itemEquipped', (data) => {
    if (data.id === socket.id) {
      equippedItems = data.equipped;
      updatePlayerCharacter();
      updatePlayerDefense();
      updatePlayerProfile(playerProfile, playerNameText.text, health, gold, equippedItems, playerLevel, bossKills);
      applyWeaponVisual(swordSprite, equippedItems);
      localStorage.setItem('equipped', JSON.stringify(equippedItems));
      if (inventoryOpen) refreshInventoryPanel();
    } else if (otherPlayers[data.id] && otherPlayers[data.id].currentMap === currentMap) {
      otherPlayers[data.id].equipped = data.equipped;
      otherPlayers[data.id].setTexture(getCharacterTexture(data.equipped));
      if (otherPlayers[data.id].swordSprite) {
        applyWeaponVisual(otherPlayers[data.id].swordSprite, data.equipped);
        otherPlayers[data.id].swordSprite.setPosition(
          otherPlayers[data.id].x + (otherPlayers[data.id].direction === 'right' ? 20 : -20),
          otherPlayers[data.id].y
        );
        otherPlayers[data.id].swordSprite.setScale(otherPlayers[data.id].direction === 'right' ? 1 : -1);
      }
    }
  });

  socket.on('itemUnequipped', (data) => {
    if (data.id === socket.id) {
      equippedItems = data.equipped;
      updatePlayerCharacter();
      updatePlayerDefense();
      updatePlayerProfile(playerProfile, playerNameText.text, health, gold, equippedItems, playerLevel, bossKills);
      applyWeaponVisual(swordSprite, equippedItems);
      localStorage.setItem('equipped', JSON.stringify(equippedItems));
      if (inventoryOpen) refreshInventoryPanel();
    } else if (otherPlayers[data.id] && otherPlayers[data.id].currentMap === currentMap) {
      otherPlayers[data.id].equipped = data.equipped;
      otherPlayers[data.id].setTexture(getCharacterTexture(data.equipped));
      if (otherPlayers[data.id].swordSprite) {
        applyWeaponVisual(otherPlayers[data.id].swordSprite, data.equipped);
        otherPlayers[data.id].swordSprite.setPosition(
          otherPlayers[data.id].x + (otherPlayers[data.id].direction === 'right' ? 20 : -20),
          otherPlayers[data.id].y
        );
        otherPlayers[data.id].swordSprite.setScale(otherPlayers[data.id].direction === 'right' ? 1 : -1);
      }
    }
  });

  socket.on('inventoryUpdate', (inventory) => {
    inventoryItems = inventory;
    if (inventoryOpen) refreshInventoryPanel();
    if (shopContainer) refreshShopPanel();
  });

  socket.on('questsUpdate', (data) => {
    totalBossKills = data.totalBossKills;
    claimedQuests = data.claimedQuests;
    if (questsContainer) refreshQuestsPanel();
  });

  socket.on('pvpUpdate', (enabled) => {
    pvpEnabled = enabled;
    updatePvpButtonLabel();
  });

  socket.on('notice', (message) => {
    showToast(this, message);
  });

  socket.on('attackDamage', (data) => {
    showDamageText(this, data.targetId, data.damage, data.x, data.y);
    if (otherPlayers[data.targetId]) {
      const targetPlayer = otherPlayers[data.targetId];
      if (targetPlayer.swordSprite && targetPlayer.swordSprite.visible) {
        playSwordSwingTween(this, targetPlayer.swordSprite);
      }
    }
  });

  // Başka bir oyuncunun saldırı animasyonu — hedefine isabet etsin etmesin,
  // hatta boşa sallamış bile olsa gelir. Sadece görsel; can/hasar zaten
  // 'attackDamage', 'bossHealthUpdate', 'playerHealthUpdate' gibi mevcut
  // event'lerle ayrıca yönetiliyor, buraya hiç dokunulmadı.
  socket.on('playerAttacked', (data) => {
    if (data.id === socket.id) return;
    const otherPlayer = otherPlayers[data.id];
    if (otherPlayer && data.currentMap === currentMap) {
      playOtherPlayerSwing(this, otherPlayer);
    }
  });

  socket.on('bossHealthUpdate', (data) => {
    if (boss && currentMap === data.mapId) {
      boss.health = data.health;
      if (bossHealthText) bossHealthText.setText(`${boss.health} / ${boss.maxHealth}`);
      if (bossHealthBar) {
        const ratio = Math.max(0, boss.health / boss.maxHealth);
        bossHealthBar.width = bossHealthBar.__barW * ratio;
      }
      showDamageText(this, 'boss', data.damage, data.x, data.y);
    }
    bossDataMap[data.mapId] = { ...(bossDataMap[data.mapId] || {}), health: data.health };
  });

  socket.on('bossAttack', (data) => {
    if (data.targetId === socket.id) {
      showDamageText(this, socket.id, data.damage, data.x, data.y);
      showAttackEffect(this, data.x, data.y);
    }
  });

  socket.on('bossSpawned', (data) => {
    // data = { mapId, boss: { x, y, health, maxHealth, alive, ... } }
    bossDataMap[data.mapId] = data.boss;
    if (currentMap === data.mapId) {
      destroyBossSprite();
      createBossSprite(this, data.mapId, data.boss);
    }
  });

  socket.on('bossDied', (data) => {
    if (currentMap === data.mapId) {
      destroyBossSprite();
    }
  });

  socket.on('playerDied', (id) => {
    removeOtherPlayer(id);
  });

  socket.on('updateHealth', (newHealth) => {
    health = newHealth;
    healthText.setText(`Can: ${health}`);
    healthBar.width = 50 * (health / 100);
    setProfileHealth(playerProfile, health);
  });

  socket.on('dead', () => {
    handlePlayerDeath(this, token);
  });

  socket.on('playerDisconnected', (id) => {
    removeOtherPlayer(id);
  });

  socket.on('chatMessage', (data) => {
    const chatMessagesPanel = document.getElementById('chat-messages');
    if (chatMessagesPanel) {
      const messageDiv = document.createElement('div');
      messageDiv.className = 'chat-line';
      const userSpan = document.createElement('span');
      userSpan.className = 'chat-user';
      userSpan.textContent = data.username + ':';
      const textSpan = document.createElement('span');
      textSpan.className = 'chat-text';
      textSpan.textContent = ' ' + data.message;
      messageDiv.appendChild(userSpan);
      messageDiv.appendChild(textSpan);
      chatMessagesPanel.appendChild(messageDiv);
      chatMessagesPanel.scrollTop = chatMessagesPanel.scrollHeight;
    }
    showChatMessage(this, data.id, data.message, data.x, data.y);
  });
}

// Kılıç kuşanılıp kuşanılmadığına göre karakterin duruş (idle) texture'ı.
function getCharacterTexture(equipped) {
  return (equipped && equipped.weapon) ? 'csw1' : 'c1';
}

// Kılıç kuşanılıp kuşanılmadığına göre hangi yürüme animasyonunun
// oynatılacağını döndürür.
function getWalkAnimKey(equipped) {
  return (equipped && equipped.weapon) ? 'walk_sword' : 'walk_plain';
}

// c1/c2/c3 (kılıçsız), csw1/csw2/csw3 (kılıçlı yürüme) ve csa1/csa2/csa3
// (kılıçla vuruş) animasyonlarını bir kere oluşturur.
function createCharacterAnims(scene) {
  if (scene.anims.exists('walk_plain')) return; // zaten oluşturulmuş
  scene.anims.create({
    key: 'walk_plain',
    frames: [{ key: 'c1' }, { key: 'c2' }, { key: 'c3' }, { key: 'c2' }],
    frameRate: 6,
    repeat: -1
  });
  scene.anims.create({
    key: 'walk_sword',
    frames: [{ key: 'csw1' }, { key: 'csw2' }, { key: 'csw3' }, { key: 'csw2' }],
    frameRate: 6,
    repeat: -1
  });
  scene.anims.create({
    key: 'attack_sword',
    frames: [{ key: 'csa1' }, { key: 'csa2' }, { key: 'csa3' }],
    frameRate: 10,
    repeat: 0
  });
}

// Eski "yüzen kılıç" sprite sistemi artık kullanılmıyor — kılıç görseli
// karakterin kendi animasyon karelerinde (csw1-3 / csa1-3) gösteriliyor.
// Bu fonksiyon geriye dönük uyumluluk için duruyor ama sprite'ı her zaman
// gizli tutuyor.
function applyWeaponVisual(sprite) {
  if (!sprite) return;
  sprite.setVisible(false);
}

// Hangi boss haritasında olursak olalım (boss1..boss5) doğru görseli ve
// can barını oluşturan genel fonksiyon. mapId = 'boss1'..'boss5'.
function createBossSprite(scene, mapId, data) {
  const cfg = BOSS_MAPS.find(m => m.id === mapId);
  if (!cfg || !data) return;
  boss = scene.physics.add.sprite(data.x, data.y, cfg.bossImageKey).setScale(1.5);
  boss.setCollideWorldBounds(true);
  boss.health = data.health;
  boss.maxHealth = data.maxHealth || data.health;
  boss.alive = data.alive;
  boss.setDepth(1);

  // Boss can barı: isim + arkaplan çubuğu + dolu çubuk + sayısal can, hepsi
  // belirgin renk/kontur ile (oyuncu can çubuklarıyla aynı okunabilir stil).
  const barW = 140, barH = 10;
  const barY = data.y - 56;
  bossNameText = scene.add.text(data.x, barY - 16, cfg.name, {
    fontSize: '16px', color: '#FFD700', fontStyle: 'bold',
    stroke: '#000000', strokeThickness: 4
  }).setOrigin(0.5).setDepth(2);
  bossHealthBarBg = scene.add.rectangle(data.x, barY, barW + 4, barH + 4, 0x000000, 0.75).setOrigin(0.5).setDepth(2);
  bossHealthBarBorder = scene.add.graphics().setDepth(2);
  bossHealthBarBorder.lineStyle(2, 0xff5555, 1);
  bossHealthBarBorder.strokeRect(data.x - barW / 2 - 2, barY - barH / 2 - 2, barW + 4, barH + 4);
  bossHealthBar = scene.add.rectangle(data.x - barW / 2, barY, barW * (boss.health / boss.maxHealth), barH, 0xff2222).setOrigin(0, 0.5).setDepth(3);
  bossHealthBar.__barW = barW;
  bossHealthBar.__barX = data.x - barW / 2;
  bossHealthText = scene.add.text(data.x, barY, `${boss.health} / ${boss.maxHealth}`, {
    fontSize: '11px', color: '#ffffff', fontStyle: 'bold',
    stroke: '#000000', strokeThickness: 3
  }).setOrigin(0.5).setDepth(4);
}

function destroyBossSprite() {
  if (boss) { boss.destroy(); boss = null; }
  if (bossNameText) { bossNameText.destroy(); bossNameText = null; }
  if (bossHealthText) { bossHealthText.destroy(); bossHealthText = null; }
  if (bossHealthBar) { bossHealthBar.destroy(); bossHealthBar = null; }
  if (bossHealthBarBg) { bossHealthBarBg.destroy(); bossHealthBarBg = null; }
  if (bossHealthBarBorder) { bossHealthBarBorder.destroy(); bossHealthBarBorder = null; }
}

// Tüm harita gösterimini (lobi + 5 boss haritası) tek yerden yöneten
// ışınlanma fonksiyonu. Lobi için 'main', boss haritaları için 'boss1'..'boss5'.
function teleportTo(scene, destId) {
  currentMap = destId;
  const isBoss = BOSS_MAP_IDS.includes(destId);

  mainMap.setVisible(destId === 'main');
  BOSS_MAPS.forEach(m => bossMapImages[m.id].setVisible(destId === m.id));
  npc.setVisible(destId === 'main');
  exclamationMark.setVisible(destId === 'main');

  if (isBoss) {
    const cfg = BOSS_MAPS.find(m => m.id === destId);
    player.x = cfg.spawnX;
    player.y = cfg.spawnY;
  } else {
    player.x = GAME_WIDTH / 2;
    player.y = GAME_HEIGHT / 2;
  }
  socket.emit('move', { x: player.x, y: player.y });
  socket.emit('changeMap', destId);

  Object.keys(otherPlayers).forEach(id => removeOtherPlayer(id));

  destroyBossSprite();
  if (isBoss && bossDataMap[destId]) {
    createBossSprite(scene, destId, bossDataMap[destId]);
  }

  scene.cameras.main.flash(400, 255, 255, 255);
}

// Karakterin o anki durumuna (hareket ediyor mu, kılıç kuşanık mı, vuruş
// animasyonu oynuyor mu) göre doğru animasyon/kareyi uygular. Hem hareket
// hem kılıç kuşanma/çıkarma anlarında çağrılır.
function updatePlayerCharacter() {
  if (!player) return;
  if (isAttacking) return; // vuruş animasyonu bitene kadar dokunma
  if (target) {
    const key = getWalkAnimKey(equippedItems);
    if (!player.anims.isPlaying || !player.anims.currentAnim || player.anims.currentAnim.key !== key) {
      player.anims.play(key, true);
    }
  } else {
    player.anims.stop();
    player.setTexture(getCharacterTexture(equippedItems));
  }
}

// Zırh/aksesuar sistemi kaldırıldığı için savunma artık her zaman 0;
// gerçek hasar hesabı zaten sunucuda yapılıyor.
function updatePlayerDefense() {
  playerDefense = 0;
}

// Profil kartı boyutları (sabit tutulur ki can/boss çubukları her yerden
// aynı genişlikle hesaplansın).
const PROFILE_W = 210;
const PROFILE_H = 150;
const PROFILE_BAR_W = PROFILE_W - 36;

// Sağ üst köşede şık, AQW temalı (altın çerçeve + koyu panel) oyuncu kartı.
// x,y kartın MERKEZİDİR; positionProfileTopRight() her zaman doğru köşeye taşır.
function createPlayerProfile(scene, x, y, username) {
  const w = PROFILE_W, h = PROFILE_H;
  const container = scene.add.container(x, y);

  const panel = scene.add.graphics();
  panel.fillStyle(0x0a0a0a, 0.8);
  panel.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
  panel.lineStyle(2, 0xFFD700, 0.9);
  panel.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);

  const avatarCx = -w / 2 + 32;
  const avatarCy = -h / 2 + 34;
  const avatarRing = scene.add.circle(avatarCx, avatarCy, 23).setStrokeStyle(2, 0xFFD700, 1);
  const avatarImage = scene.add.image(avatarCx, avatarCy, 'c1').setDisplaySize(36, 36).setName('avatarImage');
  const levelBadgeBg = scene.add.circle(avatarCx + 18, avatarCy + 18, 12, 0x8B0000).setStrokeStyle(2, 0xFFD700, 1);
  const levelBadgeText = scene.add.text(avatarCx + 18, avatarCy + 18, `${playerLevel}`, { fontSize: '12px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5).setName('levelBadgeText');

  const nameText = scene.add.text(14, -h / 2 + 24, username, { fontSize: '15px', color: '#FFD700', fontStyle: 'bold' }).setOrigin(0.5).setName('nameText');

  const barX = -w / 2 + 18;
  const hpLabel = scene.add.text(barX, -h / 2 + 62, 'CAN', { fontSize: '10px', color: '#ff9999' }).setOrigin(0, 0.5);
  const hpTrack = scene.add.rectangle(barX, -h / 2 + 76, PROFILE_BAR_W, 13, 0x330000).setOrigin(0, 0.5).setStrokeStyle(1, 0x662222);
  const hpFill = scene.add.rectangle(barX, -h / 2 + 76, PROFILE_BAR_W, 13, 0xff3b3b).setOrigin(0, 0.5).setName('healthBarFill');
  const healthText = scene.add.text(0, -h / 2 + 76, `100/100`, { fontSize: '10px', color: '#ffffff' }).setOrigin(0.5).setName('healthText');

  const bossLabel = scene.add.text(barX, -h / 2 + 96, 'BOSS', { fontSize: '10px', color: '#e199ff' }).setOrigin(0, 0.5);
  const bossTrack = scene.add.rectangle(barX, -h / 2 + 110, PROFILE_BAR_W, 13, 0x220033).setOrigin(0, 0.5).setStrokeStyle(1, 0x552266);
  const bossFill = scene.add.rectangle(barX, -h / 2 + 110, 0, 13, 0xaa33ff).setOrigin(0, 0.5).setName('bossKillsBarFill');
  const bossKillsText = scene.add.text(0, -h / 2 + 110, `${bossKills}/100`, { fontSize: '10px', color: '#ffffff' }).setOrigin(0.5).setName('bossKillsText');

  const goldText = scene.add.text(barX, h / 2 - 26, `Altın: ${gold}`, { fontSize: '13px', color: '#ffd700' }).setOrigin(0, 0.5).setName('goldText');
  const swordText = scene.add.text(barX, h / 2 - 9, `Kılıç: Yok`, { fontSize: '12px', color: '#ff8888' }).setOrigin(0, 0.5).setName('swordText');

  container.add([
    panel, avatarRing, avatarImage, levelBadgeBg, levelBadgeText, nameText,
    hpLabel, hpTrack, hpFill, healthText,
    bossLabel, bossTrack, bossFill, bossKillsText,
    goldText, swordText
  ]);
  container.setDepth(5);
  return container;
}

function setProfileHealth(profile, hp) {
  const clamped = Phaser.Math.Clamp(hp, 0, 100);
  const label = profile.getByName('healthText');
  if (label) label.setText(`${clamped}/100`);
  const fill = profile.getByName('healthBarFill');
  if (fill) fill.width = PROFILE_BAR_W * (clamped / 100);
}

function setProfileBossKills(profile, kills) {
  const clamped = Phaser.Math.Clamp(kills, 0, 100);
  const label = profile.getByName('bossKillsText');
  if (label) label.setText(`${clamped}/100`);
  const fill = profile.getByName('bossKillsBarFill');
  if (fill) fill.width = PROFILE_BAR_W * (clamped / 100);
}

function updatePlayerProfile(profile, username, health, gold, equipped, level, bossKills) {
  const nameLabel = profile.getByName('nameText');
  if (nameLabel && username) nameLabel.setText(username);
  setProfileHealth(profile, health);
  profile.getByName('levelBadgeText').setText(`${level}`);
  setProfileBossKills(profile, bossKills);
  profile.getByName('goldText').setText(`Altın: ${gold}`);
  profile.getByName('swordText').setText(`Silah: ${equipped.weapon ? itemDisplayName(equipped.weapon) : 'Yok'}`);
  const avatarImage = profile.getByName('avatarImage');
  if (avatarImage) avatarImage.setTexture(getCharacterTexture(equipped));
}

// Kart her zaman ekranın sağ üst köşesinde kalsın diye ayrı bir konumlandırma
// fonksiyonu: hem create() içinde hem de resize sırasında kullanılır.
function positionProfileTopRight(width) {
  if (!playerProfile) return;
  const margin = 14;
  playerProfile.setPosition(width - PROFILE_W / 2 - margin, PROFILE_H / 2 + margin);
}

// ---------------- SKILL ÇUBUĞU (5 skill, AQW tarzı savaş) ----------------

function createSkillBar(scene) {
  const container = scene.add.container(GAME_WIDTH / 2, GAME_HEIGHT - 60);
  container.setDepth(5);
  skillSlots = [];

  const slotSize = 56;
  const gap = 12;
  const totalWidth = SKILLS.length * slotSize + (SKILLS.length - 1) * gap;
  const startX = -totalWidth / 2 + slotSize / 2;

  SKILLS.forEach((skill, index) => {
    const sx = startX + index * (slotSize + gap);

    // AQW tarzı süslü çerçeve (koyu taban + skill rengi çift kontur + köşe aksanları)
    drawFancyFrame(scene, container, sx, 0, slotSize, skill.color, { radius: 10 });

    // Skill ikonu: sade geometrik şekil (görsel dosyasına ihtiyaç yok)
    const icon = scene.add.graphics();
    icon.fillStyle(skill.color, 1);
    if (skill.type === 'heal') {
      icon.fillRect(sx - 3, -slotSize / 2 + 12, 6, 18);
      icon.fillRect(sx - 9, -slotSize / 2 + 18, 18, 6);
    } else {
      icon.fillTriangle(sx, -slotSize / 2 + 10, sx - 10, -slotSize / 2 + 28, sx + 10, -slotSize / 2 + 28);
    }

    const cooldownOverlay = scene.add.rectangle(sx, -slotSize / 2, slotSize - 4, 0, 0x000000, 0.65).setOrigin(0.5, 0);
    const cooldownText = scene.add.text(sx, 2, '', { fontSize: '16px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5).setVisible(false);
    const keyBg = scene.add.graphics();
    keyBg.fillStyle(0x000000, 0.8);
    keyBg.fillCircle(sx, slotSize / 2 - 10, 9);
    keyBg.lineStyle(1, skill.color, 1);
    keyBg.strokeCircle(sx, slotSize / 2 - 10, 9);
    const keyLabel = scene.add.text(sx, slotSize / 2 - 10, skill.digit, { fontSize: '12px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5);
    const nameLabel = scene.add.text(sx, slotSize / 2 + 8, skill.name, { fontSize: '9px', color: '#cccccc' }).setOrigin(0.5, 0).setVisible(false);

    const hitZone = scene.add.rectangle(sx, 0, slotSize, slotSize, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
    hitZone.on('pointerdown', () => useSkill(scene, index));
    hitZone.on('pointerover', () => nameLabel.setVisible(true));
    hitZone.on('pointerout', () => nameLabel.setVisible(false));

    container.add([icon, cooldownOverlay, keyBg, keyLabel, cooldownText, nameLabel, hitZone]);
    skillSlots.push({ cooldownOverlay, cooldownText, slotSize });
  });

  return container;
}

function positionSkillBarBottomCenter(width, height) {
  if (!skillBarContainer) return;
  skillBarContainer.setPosition(width / 2, height - 60);
}

// Hedef arama + hasar/heal uygulama: SPACE ve 1-5 tuşları buraya bağlanır.
function useSkill(scene, index) {
  const skill = SKILLS[index];
  if (!skill || !player || isDead || isAnyPanelOpen() || isChatFocused) return;

  const now = scene.time.now;
  if (now < skillReadyAt[index]) return; // hâlâ bekleme süresinde

  if (skill.type === 'heal') {
    socket.emit('useSkillHeal', { skillId: skill.id });
    skillReadyAt[index] = now + skill.cooldown;
    showAttackEffect(scene, player.x, player.y, skill.color);
    return;
  }

  // Vuruş animasyonu ve cooldown HER DURUMDA uygulanır — hedef bulunsun ya
  // da bulunmasın (boşa saldırı dahil). Böylece hem kendi ekranında hem de
  // diğer oyuncuların ekranında saldırı görünür. Hedef bulma / hasar verme
  // mantığı aşağıda AYNEN eskisi gibi korunuyor, sadece bu iki satır yukarı
  // taşındı ve "boşa saldırı" durumu için de çalışır hale getirildi.
  skillReadyAt[index] = now + skill.cooldown;
  swingWeapon(scene);
  socket.emit('playerAttack', { skillId: skill.id });

  // En yakın oyuncuyu ara
  for (let id in otherPlayers) {
    const otherPlayer = otherPlayers[id];
    const distance = Phaser.Math.Distance.Between(player.x, player.y, otherPlayer.x, otherPlayer.y);
    if (distance < skill.range) {
      const targetX = otherPlayer.x, targetY = otherPlayer.y; // mermi uçarken hedef yok olsa bile bu sabit kalır
      socket.emit('attack', { targetId: id, skillId: skill.id });
      fireSkillProjectile(scene, player.x, player.y, targetX, targetY, skill.color, () => {
        showAttackEffect(scene, targetX, targetY, skill.color);
      });
      return;
    }
  }

  // Yoksa boss'a dene
  if (boss && boss.alive && BOSS_MAP_IDS.includes(currentMap)) {
    const distance = Phaser.Math.Distance.Between(player.x, player.y, boss.x, boss.y);
    if (distance < skill.range) {
      const targetX = boss.x, targetY = boss.y; // mermi uçarken boss ölüp 'null' olsa bile bu sabit kalır
      socket.emit('attackBoss', { mapId: currentMap, skillId: skill.id });
      fireSkillProjectile(scene, player.x, player.y, targetX, targetY, skill.color, () => {
        showAttackEffect(scene, targetX, targetY, skill.color);
      });
    }
  }
}

// Kılıç sallama animasyonu: düz yukarı-aşağı zıplama yerine gerçek bir
// "kesme" hareketi — kısa bir açısal sallanış + hafif ileri-aşağı hamle,
// sonra kılıç otomatik olarak eski (dinlenme) konum/açısına dönüyor.
function playSwordSwingTween(scene, sprite) {
  if (!sprite) return;
  scene.tweens.killTweensOf(sprite);
  const baseX = sprite.x, baseY = sprite.y;
  sprite.angle = 0;

  const facing = sprite.scaleX >= 0 ? 1 : -1;

  scene.tweens.add({
    targets: sprite,
    angle: { from: -18 * facing, to: 55 * facing },
    x: baseX + 9 * facing,
    y: baseY + 7,
    duration: 110,
    ease: 'Cubic.easeOut',
    yoyo: true,
    onComplete: () => {
      sprite.angle = 0;
      sprite.setPosition(baseX, baseY);
    }
  });
}

// Kılıç kuşanıksa csa1/csa2/csa3 vuruş animasyonunu bir kere oynatır,
// bitince kaldığı yere (yürüme ya da duruş karesine) geri döner.
function swingWeapon(scene) {
  if (!player || !equippedItems.weapon) return;
  isAttacking = true;
  player.anims.play('attack_sword', true);
  player.once('animationcomplete-attack_sword', () => {
    isAttacking = false;
    updatePlayerCharacter();
  });
}

// swingWeapon'ın karşılığı: yerel oyuncu değil, BAŞKA bir oyuncunun sprite'ında
// kılıç vuruş animasyonunu oynatır (playerAttacked event'i geldiğinde çağrılır).
// Hiçbir can/hasar mantığına dokunmaz, sadece görsel.
function playOtherPlayerSwing(scene, otherPlayer) {
  if (!otherPlayer || !otherPlayer.equipped || !otherPlayer.equipped.weapon) return;
  if (!scene.anims.exists('attack_sword')) return;
  otherPlayer.anims.play('attack_sword', true);
  otherPlayer.once('animationcomplete-attack_sword', () => {
    if (!otherPlayer.anims) return;
    const walkKey = getWalkAnimKey(otherPlayer.equipped);
    if (!otherPlayer.anims.currentAnim || otherPlayer.anims.currentAnim.key !== walkKey) {
      otherPlayer.anims.stop();
      otherPlayer.setTexture(getCharacterTexture(otherPlayer.equipped));
    }
  });
  if (otherPlayer.swordSprite && otherPlayer.swordSprite.visible) {
    playSwordSwingTween(scene, otherPlayer.swordSprite);
  }
}

// Her karede skill çubuğundaki bekleme süresi (cooldown) örtüsünü günceller.
function updateSkillCooldownsUI(scene) {
  if (!skillBarContainer || skillSlots.length === 0) return;
  const now = scene.time.now;
  SKILLS.forEach((skill, index) => {
    const slot = skillSlots[index];
    if (!slot) return;
    const remaining = skillReadyAt[index] - now;
    if (remaining > 0) {
      const ratio = Phaser.Math.Clamp(remaining / skill.cooldown, 0, 1);
      slot.cooldownOverlay.height = slot.slotSize * ratio;
      slot.cooldownText.setText(Math.ceil(remaining / 1000).toString());
      slot.cooldownText.setVisible(true);
    } else {
      slot.cooldownOverlay.height = 0;
      slot.cooldownText.setVisible(false);
    }
  });
}

// Bir resmi, oranını BOZMADAN (tek bir ölçek/scale ile) ekranın tamamını
// kaplayacak şekilde büyütür — CSS'teki "background-size: cover" ile aynı
// mantık. Telefon/tablet/PC hangi ekran oranında olursa olsun kenarlarda
// siyah boşluk kalmaz, resim sadece taşan kısımlardan kırpılır (esner/uzamaz).
function coverImage(img, width, height) {
  if (!img || !img.texture) return;
  const src = img.texture.getSourceImage();
  const texW = src && src.width;
  const texH = src && src.height;
  if (!texW || !texH) return;
  const scale = Math.max(width / texW, height / texH);
  img.setDisplaySize(texW * scale, texH * scale);
  img.setPosition(width / 2, height / 2);
}

// ---------------- EKRAN YENİDEN BOYUTLANDIRMA (cihazdan cihaza stabil) ----------------
// Telefon döndürme, tarayıcı penceresi yeniden boyutlandırma vb. durumlarda
// harita, profil kartı ve skill çubuğunu doğru yere taşıyıp fizik/kamera
// sınırlarını günceller; böylece görüntü hiçbir cihazda bozulmaz ve kenarlarda
// siyah boşluk kalmaz.
function handleResize(scene, width, height) {
  if (mainMap) coverImage(mainMap, width, height);
  BOSS_MAPS.forEach(cfg => {
    if (bossMapImages[cfg.id]) coverImage(bossMapImages[cfg.id], width, height);
  });

  positionProfileTopRight(width);
  positionSkillBarBottomCenter(width, height);
  positionSideMenu(width);

  if (scene.physics && scene.physics.world) {
    scene.physics.world.setBounds(0, 0, width, height);
  }
  if (scene.cameras && scene.cameras.main) {
    scene.cameras.main.setSize(width, height);
  }
}

// Tek bir ışınlanma kapısı kartı çizer: yuvarlak köşeli çerçeve + harita
// küçük görseli + isim + üzerine gelince büyüme efekti.
function createPortalCard(scene, container, x, y, title, textureKey, accentColor, onClick) {
  const w = 130, h = 95;

  const g = scene.add.graphics();
  function drawFrame(alpha, lineWidth) {
    g.clear();
    g.fillStyle(0x000000, alpha);
    g.fillRoundedRect(x - w / 2, y - h / 2, w, h, 10);
    g.lineStyle(lineWidth, accentColor, 1);
    g.strokeRoundedRect(x - w / 2, y - h / 2, w, h, 10);
  }
  drawFrame(0.55, 2);

  const thumb = scene.add.image(x, y - 12, textureKey).setDisplaySize(90, 48);
  const label = scene.add.text(x, y + 28, title, { fontSize: '13px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5);

  const hitZone = scene.add.rectangle(x, y, w, h, 0xffffff, 0.001).setInteractive({ useHandCursor: true });

  container.add([g, thumb, label, hitZone]);

  hitZone.on('pointerover', () => {
    drawFrame(0.75, 3);
    scene.tweens.add({ targets: [thumb, label], scale: 1.08, duration: 120 });
  });
  hitZone.on('pointerout', () => {
    drawFrame(0.55, 2);
    scene.tweens.add({ targets: [thumb, label], scale: 1, duration: 120 });
  });
  hitZone.on('pointerdown', onClick);
}

function openMap(scene) {
  mapContainer = scene.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2);

  // Diğer menülerle (Mağaza / Görevler) aynı stil: koyu panel + altın çerçeve
  const panelW = 420, panelH = 420;
  const bg = scene.add.graphics();
  bg.fillStyle(0x0a0a0a, 0.94);
  bg.fillRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 14);
  bg.lineStyle(2, 0xFFD700, 0.95);
  bg.strokeRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 14);
  mapContainer.add(bg);

  const title = scene.add.text(0, -panelH / 2 + 28, 'Haritalar', {
    fontSize: '22px', color: '#FFD700', fontStyle: 'bold'
  }).setOrigin(0.5);
  mapContainer.add(title);

  const subtitle = scene.add.text(0, -panelH / 2 + 52, 'Gitmek istediğin haritayı seç', {
    fontSize: '12px', color: '#aaaaaa'
  }).setOrigin(0.5);
  mapContainer.add(subtitle);

  const destinations = [
    { id: 'main', name: 'Lobi', color: 0x2ecc71 },
    ...BOSS_MAPS.map(m => ({ id: m.id, name: m.name, color: m.color }))
  ];

  const rowH = 44;
  const startY = -panelH / 2 + 90;
  destinations.forEach((dest, i) => {
    const y = startY + i * rowH;
    const isCurrent = currentMap === dest.id;

    const rowBg = scene.add.graphics();
    rowBg.fillStyle(isCurrent ? 0x1a2a1a : 0x151515, 0.95);
    rowBg.fillRoundedRect(-180, y - 18, 360, 36, 8);
    rowBg.lineStyle(1.5, isCurrent ? 0x55ff88 : dest.color, 0.9);
    rowBg.strokeRoundedRect(-180, y - 18, 360, 36, 8);
    mapContainer.add(rowBg);

    const colorDot = scene.add.circle(-155, y, 6, dest.color);
    mapContainer.add(colorDot);

    const label = scene.add.text(-140, y, dest.name, {
      fontSize: '15px',
      color: isCurrent ? '#55ff88' : '#ffffff',
      fontStyle: isCurrent ? 'bold' : 'normal'
    }).setOrigin(0, 0.5);
    mapContainer.add(label);

    const status = scene.add.text(155, y, isCurrent ? 'BURADASIN' : 'GİT →', {
      fontSize: '12px',
      color: isCurrent ? '#55ff88' : '#FFD700',
      fontStyle: 'bold'
    }).setOrigin(1, 0.5);
    mapContainer.add(status);

    if (!isCurrent) {
      const hit = scene.add.rectangle(0, y, 360, 36, 0xffffff, 0.001)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerover', () => {
        rowBg.clear();
        rowBg.fillStyle(0x222218, 0.98);
        rowBg.fillRoundedRect(-180, y - 18, 360, 36, 8);
        rowBg.lineStyle(2, 0xFFD700, 1);
        rowBg.strokeRoundedRect(-180, y - 18, 360, 36, 8);
      });
      hit.on('pointerout', () => {
        rowBg.clear();
        rowBg.fillStyle(0x151515, 0.95);
        rowBg.fillRoundedRect(-180, y - 18, 360, 36, 8);
        rowBg.lineStyle(1.5, dest.color, 0.9);
        rowBg.strokeRoundedRect(-180, y - 18, 360, 36, 8);
      });
      hit.on('pointerdown', () => {
        teleportTo(scene, dest.id);
        closeMap();
      });
      mapContainer.add(hit);
    }
  });

  const closeButton = scene.add.text(0, panelH / 2 - 24, 'KAPAT', {
    fontSize: '16px', color: '#ff5555', fontStyle: 'bold'
  })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true })
    .on('pointerdown', () => closeMap());
  mapContainer.add(closeButton);

  mapContainer.setDepth(3);
}

function closeMap() {
  if (mapContainer) {
    mapContainer.destroy();
    mapContainer = null;
  }
}

// ---------------- SAĞ MENÜ (Mağaza / PvP / Maceralar / Görevler vb.) ----------------

function createSideMenu(scene) {
  const container = scene.add.container(0, 0);
  container.setDepth(5);
  const btnW = 150, btnH = 32, gap = 8;

  const buttons = [
    { key: 'shop', label: 'Mağaza', onClick: () => { closeAllPanels(); openShop(scene); } },
    { key: 'pvp', label: pvpEnabled ? 'PvP: AÇIK' : 'PvP: KAPALI', onClick: () => socket.emit('togglePvp') },
    { key: 'adventures', label: 'Maceralar', onClick: () => { if (mapContainer) { closeMap(); } else { closeAllPanels(); openMap(scene); } } },
    { key: 'quests', label: 'Görevler', onClick: () => { closeAllPanels(); openQuests(scene); } },
    { key: 'dailygift', label: 'Günlük Hediye', onClick: () => socket.emit('claimDailyGift') },
    { key: 'news', label: 'Duyurular', onClick: () => {
        closeAllPanels();
        openInfoPopup(scene, 'Duyurular', [
          'BetaGame test sürümüne hoş geldin!',
          'Yeni: Mağaza, PvP modu, Görevler ve nadirlik sistemi eklendi.',
          'Yakında: Yeni haritalar ve daha fazla eşya.'
        ]);
      }
    },
    { key: 'calendar', label: 'Takvim', onClick: () => {
        closeAllPanels();
        openInfoPopup(scene, 'Etkinlik Takvimi', [
          'Şu an aktif özel bir etkinlik yok.',
          'Boss haritalarını keşfet, seviye atla ve\ngörev ödüllerini topla!'
        ]);
      }
    }
  ];

  buttons.forEach((btn, i) => {
    const y = i * (btnH + gap);
    const bg = scene.add.graphics();
    bg.fillStyle(0x8B0000, 0.92);
    bg.fillRoundedRect(-btnW / 2, y - btnH / 2, btnW, btnH, 6);
    bg.lineStyle(2, 0xFFD700, 1);
    bg.strokeRoundedRect(-btnW / 2, y - btnH / 2, btnW, btnH, 6);
    container.add(bg);

    const label = scene.add.text(0, y, btn.label, { fontSize: '13px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5);
    container.add(label);
    if (btn.key === 'pvp') pvpButtonText = label;

    const hitZone = scene.add.rectangle(0, y, btnW, btnH, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
    hitZone.on('pointerover', () => bg.setAlpha(0.7));
    hitZone.on('pointerout', () => bg.setAlpha(1));
    hitZone.on('pointerdown', btn.onClick);
    container.add(hitZone);
  });

  return container;
}

function positionSideMenu(width) {
  if (!sideMenuContainer) return;
  const btnW = 150, btnH = 32;
  sideMenuContainer.setPosition(width - 14 - btnW / 2, PROFILE_H + 14 + 10 + btnH / 2);
}

function updatePvpButtonLabel() {
  if (pvpButtonText) pvpButtonText.setText(pvpEnabled ? 'PvP: AÇIK' : 'PvP: KAPALI');
}

// ---------------- MAĞAZA ----------------

function createShopCard(scene, container, x, y, w, h, def) {
  const rarityColor = RARITY_COLORS[def.rarity] || 0x999999;
  const alreadyOwned = def.type !== 'potion' && inventoryItems.some(i => i.id === def.id);
  const affordable = gold >= def.price;

  // Nadirliğe göre yumuşak arka parlama (destansı/efsanevi eşyalar için)
  if (def.rarity === 'epic' || def.rarity === 'legendary') {
    const glow = scene.add.graphics();
    glow.fillStyle(rarityColor, def.rarity === 'legendary' ? 0.14 : 0.1);
    glow.fillRoundedRect(x - w / 2, y - h / 2, w, h, 10);
    container.add(glow);
  }

  drawFancyFrame(scene, container, x, y, w, rarityColor, { radius: 8, height: h });

  const rarityTag = scene.add.text(x, y - h / 2 + 10, RARITY_LABELS[def.rarity] || '', { fontSize: '9px', color: `#${rarityColor.toString(16).padStart(6, '0')}`, fontStyle: 'bold' }).setOrigin(0.5);
  container.add(rarityTag);

  const visual = getItemVisual(def.id);
  const textureKey = visual.textureKey || visual.icon || 'icon_potion';
  const icon = scene.add.image(x, y - h / 2 + 40, textureKey).setDisplaySize(36, 36);
  if (visual.tint) icon.setTint(visual.tint);
  container.add(icon);

  const nameText = scene.add.text(x, y - h / 2 + 64, itemDisplayName(def.id), {
    fontSize: '11px', color: '#ffffff', fontStyle: 'bold', align: 'center', wordWrap: { width: w - 10 }
  }).setOrigin(0.5);
  const priceText = scene.add.text(x, y + h / 2 - 28, `${def.price} Altın`, { fontSize: '11px', color: '#ffd700' }).setOrigin(0.5);
  container.add([nameText, priceText]);

  const buyLabel = alreadyOwned ? 'SAHİPSİN' : (affordable ? 'SATIN AL' : 'YETERSİZ ALTIN');
  const buyColor = alreadyOwned ? '#888888' : (affordable ? '#55ff55' : '#ff5555');
  const buyBtn = scene.add.text(x, y + h / 2 - 10, buyLabel, { fontSize: '11px', color: buyColor, fontStyle: 'bold' }).setOrigin(0.5);
  container.add(buyBtn);

  if (!alreadyOwned && affordable) {
    const hitZone = scene.add.rectangle(x, y, w, h, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
    container.add(hitZone);
    hitZone.on('pointerdown', () => socket.emit('buyItem', def.id));
  }
}

function openShop(scene) {
  shopScene = scene;
  shopContainer = scene.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2);

  const panelW = 480, panelH = 420;
  drawPanelFrame(scene, shopContainer, panelW, panelH, 0xFFD700);

  const title = scene.add.text(0, -panelH / 2 + 24, 'Mağaza', { fontSize: '22px', color: '#FFD700', fontStyle: 'bold' }).setOrigin(0.5);
  const goldLabel = scene.add.text(0, -panelH / 2 + 50, `Altının: ${gold}`, { fontSize: '14px', color: '#ffd700' }).setOrigin(0.5).setName('shopGoldLabel');
  shopContainer.add([title, goldLabel]);

  const itemsContainer = scene.add.container(0, 0).setName('shopItems');
  shopContainer.add(itemsContainer);

  const cols = 3, slotW = 130, slotH = 110, gapX = 18, gapY = 18;
  const totalW = cols * slotW + (cols - 1) * gapX;
  const startX = -totalW / 2 + slotW / 2;
  const startY = -panelH / 2 + 100;

  SHOP_CATALOG.forEach((def, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = startX + col * (slotW + gapX);
    const y = startY + row * (slotH + gapY);
    createShopCard(scene, itemsContainer, x, y, slotW, slotH, def);
  });

  const closeButton = scene.add.text(0, panelH / 2 - 20, 'KAPAT', { fontSize: '16px', color: '#ff5555' })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true })
    .on('pointerdown', () => closeShop());
  shopContainer.add(closeButton);

  shopContainer.setDepth(3);
}

function refreshShopPanel() {
  if (!shopContainer || !shopScene) return;
  const goldLabel = shopContainer.getByName('shopGoldLabel');
  if (goldLabel) goldLabel.setText(`Altının: ${gold}`);
  const itemsContainer = shopContainer.getByName('shopItems');
  if (itemsContainer) {
    itemsContainer.removeAll(true);
    const cols = 3, slotW = 130, slotH = 110, gapX = 18, gapY = 18;
    const totalW = cols * slotW + (cols - 1) * gapX;
    const startX = -totalW / 2 + slotW / 2;
    const startY = -420 / 2 + 100;
    SHOP_CATALOG.forEach((def, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = startX + col * (slotW + gapX);
      const y = startY + row * (slotH + gapY);
      createShopCard(shopScene, itemsContainer, x, y, slotW, slotH, def);
    });
  }
}

function closeShop() {
  if (shopContainer) {
    shopContainer.destroy();
    shopContainer = null;
  }
}

// ---------------- GÖREVLER ----------------

function renderQuestList(scene, container) {
  container.removeAll(true);
  QUESTS.forEach((q, i) => {
    const y = i * 70;
    const claimed = claimedQuests.includes(q.id);
    const progress = Math.min(totalBossKills, q.target);
    const ratio = progress / q.target;

    const rowBg = scene.add.graphics();
    rowBg.fillStyle(0x151515, 0.9);
    rowBg.fillRoundedRect(-190, y - 28, 380, 56, 6);
    rowBg.lineStyle(1, claimed ? 0x00ff88 : 0xFFD700, 0.8);
    rowBg.strokeRoundedRect(-190, y - 28, 380, 56, 6);
    container.add(rowBg);

    const nameText = scene.add.text(-180, y - 20, `${q.name}  (${progress}/${q.target} boss)`, { fontSize: '13px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0, 0.5);
    container.add(nameText);

    const barTrack = scene.add.rectangle(-180, y + 4, 260, 8, 0x330000).setOrigin(0, 0.5).setStrokeStyle(1, 0x662222);
    const barFill = scene.add.rectangle(-180, y + 4, Math.max(2, 260 * ratio), 8, claimed ? 0x00ff88 : 0xffd700).setOrigin(0, 0.5);
    container.add([barTrack, barFill]);

    const canClaim = !claimed && progress >= q.target;
    const btnLabel = claimed ? 'ALINDI' : (canClaim ? `AL (+${q.reward})` : `Ödül: +${q.reward}`);
    const btnColor = claimed ? '#888888' : (canClaim ? '#55ff55' : '#aaaaaa');
    const btn = scene.add.text(150, y - 4, btnLabel, { fontSize: '12px', color: btnColor, fontStyle: 'bold' }).setOrigin(0.5);
    container.add(btn);

    if (canClaim) {
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => socket.emit('claimQuest', q.id));
    }
  });
}

function openQuests(scene) {
  questsScene = scene;
  questsContainer = scene.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2);

  const panelW = 420, panelH = 360;
  const bg = scene.add.graphics();
  bg.fillStyle(0x0a0a0a, 0.92);
  bg.fillRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 14);
  bg.lineStyle(2, 0xFFD700, 0.9);
  bg.strokeRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 14);
  questsContainer.add(bg);

  const title = scene.add.text(0, -panelH / 2 + 24, 'Görevler', { fontSize: '22px', color: '#FFD700', fontStyle: 'bold' }).setOrigin(0.5);
  questsContainer.add(title);

  const listContainer = scene.add.container(0, -panelH / 2 + 65).setName('questList');
  questsContainer.add(listContainer);
  renderQuestList(scene, listContainer);

  const closeButton = scene.add.text(0, panelH / 2 - 20, 'KAPAT', { fontSize: '16px', color: '#ff5555' })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true })
    .on('pointerdown', () => closeQuests());
  questsContainer.add(closeButton);

  questsContainer.setDepth(3);
}

function refreshQuestsPanel() {
  if (!questsContainer || !questsScene) return;
  const listContainer = questsContainer.getByName('questList');
  if (listContainer) renderQuestList(questsScene, listContainer);
}

function closeQuests() {
  if (questsContainer) {
    questsContainer.destroy();
    questsContainer = null;
  }
}

// ---------------- BİLGİ PENCERESİ (Duyurular / Takvim gibi tanıtım amaçlı) ----------------

function openInfoPopup(scene, title, lines) {
  infoContainer = scene.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2);

  const panelW = 380, panelH = 280;
  const bg = scene.add.graphics();
  bg.fillStyle(0x0a0a0a, 0.95);
  bg.fillRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 14);
  bg.lineStyle(2, 0xFFD700, 0.9);
  bg.strokeRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 14);
  infoContainer.add(bg);

  const titleText = scene.add.text(0, -panelH / 2 + 26, title, { fontSize: '20px', color: '#FFD700', fontStyle: 'bold' }).setOrigin(0.5);
  infoContainer.add(titleText);

  const bodyText = scene.add.text(0, -10, lines.join('\n\n'), {
    fontSize: '13px', color: '#ffffff', align: 'center', wordWrap: { width: panelW - 40 }
  }).setOrigin(0.5, 0.3);
  infoContainer.add(bodyText);

  const closeButton = scene.add.text(0, panelH / 2 - 20, 'KAPAT', { fontSize: '16px', color: '#ff5555' })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true })
    .on('pointerdown', () => closeInfoPopup());
  infoContainer.add(closeButton);

  infoContainer.setDepth(3);
}

function closeInfoPopup() {
  if (infoContainer) {
    infoContainer.destroy();
    infoContainer = null;
  }
}

// ---------------- BİLDİRİM (TOAST) ----------------

function showToast(scene, message) {
  const toastText = scene.add.text(GAME_WIDTH / 2, 90, message, {
    fontSize: '16px', color: '#ffd700', fontStyle: 'bold',
    backgroundColor: '#000000cc', padding: { x: 12, y: 6 }
  }).setOrigin(0.5).setDepth(10);

  scene.tweens.add({
    targets: toastText,
    y: 60,
    alpha: 0,
    duration: 2200,
    delay: 800,
    ease: 'Power1',
    onComplete: () => toastText.destroy()
  });
}

// ---------------- AQW TARZI ENVANTER (grid + nadirlik renkleri + tooltip) ----------------

// Artık tek kategori var: Silahlar (sadece kılıç).
const INVENTORY_TABS = [
  { id: 'weapon', label: 'Silahlar' }
];

let inventoryScene = null;
let inventoryTooltip = null;

function drawItemSlotIcon(scene, container, cx, cy, size, item) {
  const rarityColor = RARITY_COLORS[item.rarity] || 0x999999;

  // Destansı/Efsanevi eşyalar ikonun arkasında yumuşak bir parlama alır.
  if (item.rarity === 'epic' || item.rarity === 'legendary') {
    const glow = scene.add.graphics();
    glow.fillStyle(rarityColor, item.rarity === 'legendary' ? 0.22 : 0.16);
    glow.fillCircle(cx, cy, size * 0.42);
    container.add(glow);
  }

  const frame = drawFancyFrame(scene, container, cx, cy, size, rarityColor);

  const visual = getItemVisual(item.id);
  const textureKey = visual.textureKey || visual.icon || 'icon_potion';
  const icon = scene.add.image(cx, cy, textureKey).setDisplaySize(size * 0.62, size * 0.62);
  if (visual.tint) icon.setTint(visual.tint);
  container.add(icon);

  if (item.quantity > 1) {
    const qtyBg = scene.add.graphics();
    qtyBg.fillStyle(0x000000, 0.75);
    qtyBg.fillRoundedRect(cx + size / 2 - 22, cy + size / 2 - 15, 20, 14, 3);
    container.add(qtyBg);
    const qty = scene.add.text(cx + size / 2 - 4, cy + size / 2 - 8, `x${item.quantity}`, { fontSize: '10px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(1, 0.5);
    container.add(qty);
  }

  return frame;
}

function isItemEquipped(item, equipped) {
  if (item.type === 'weapon') return equipped.weapon === item.id;
  if (item.type === 'armor') return equipped.armor === item.id;
  if (item.type === 'accessory') return equipped.accessory === item.id;
  return false;
}

function showItemTooltip(scene, container, x, y, item) {
  hideItemTooltip();
  const rarityColor = RARITY_COLORS[item.rarity] || 0x999999;
  const nameLine = itemDisplayName(item.id);
  const statLines = [];
  if (item.attackPower) statLines.push(`Saldırı: +${item.attackPower}`);
  if (item.defense) statLines.push(`Savunma: +${item.defense}`);
  if (item.heal) statLines.push(`İyileşme: +${item.heal} can`);

  const tt = scene.add.container(x, y);
  const w = 150, h = 40 + statLines.length * 15;
  const bg = scene.add.graphics();
  bg.fillStyle(0x0a0a0a, 0.95);
  bg.fillRoundedRect(-w / 2, 0, w, h, 6);
  bg.lineStyle(1.5, rarityColor, 1);
  bg.strokeRoundedRect(-w / 2, 0, w, h, 6);
  bg.lineStyle(1, 0x000000, 0.6);
  bg.strokeRoundedRect(-w / 2 + 2, 2, w - 4, h - 4, 4);
  tt.add(bg);

  const nameText = scene.add.text(0, 8, nameLine, { fontSize: '12px', color: `#${rarityColor.toString(16).padStart(6, '0')}`, fontStyle: 'bold', align: 'center' }).setOrigin(0.5, 0);
  const rarityText = scene.add.text(0, 22, RARITY_LABELS[item.rarity] || '', { fontSize: '10px', color: '#aaaaaa', align: 'center' }).setOrigin(0.5, 0);
  tt.add([nameText, rarityText]);

  statLines.forEach((line, i) => {
    const statText = scene.add.text(0, 36 + i * 15, line, { fontSize: '11px', color: '#ffffff', align: 'center' }).setOrigin(0.5, 0);
    tt.add(statText);
  });

  tt.setDepth(20);
  container.add(tt);
  inventoryTooltip = tt;
}

function hideItemTooltip() {
  if (inventoryTooltip) {
    inventoryTooltip.destroy();
    inventoryTooltip = null;
  }
}

function buildInventoryTabContent(scene, container, type) {
  const items = inventoryItems.filter(i => i.type === type);
  const cols = 5;
  const slotSize = 56;
  const gap = 14;
  const totalWidth = cols * slotSize + (cols - 1) * gap;
  const startX = -totalWidth / 2 + slotSize / 2;
  const startY = -70;

  if (items.length === 0) {
    const empty = scene.add.text(0, 0, 'Bu kategoride eşyan yok.\nMağazadan satın alabilirsin!', { fontSize: '14px', color: '#999999', align: 'center' }).setOrigin(0.5);
    container.add(empty);
    return;
  }

  items.forEach((item, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = startX + col * (slotSize + gap);
    const y = startY + row * (slotSize + gap);

    drawItemSlotIcon(scene, container, x, y, slotSize, item);

    if (isItemEquipped(item, equippedItems)) {
      // Kuşanık eşyalar için köşede küçük altın rozet (parlak şerit + yıldız).
      const badgeBg = scene.add.graphics();
      badgeBg.fillStyle(0x1a1400, 0.9);
      badgeBg.fillRoundedRect(x - 28, y - slotSize / 2 - 4, 56, 13, 4);
      badgeBg.lineStyle(1, 0xffd700, 1);
      badgeBg.strokeRoundedRect(x - 28, y - slotSize / 2 - 4, 56, 13, 4);
      container.add(badgeBg);
      const badge = scene.add.text(x, y - slotSize / 2 + 2, '★ KUŞANIK', { fontSize: '8px', color: '#ffd700', fontStyle: 'bold' }).setOrigin(0.5);
      container.add(badge);
    }

    const hitZone = scene.add.rectangle(x, y, slotSize, slotSize, 0xffffff, 0.001).setInteractive({ useHandCursor: true });
    container.add(hitZone);

    hitZone.on('pointerover', () => showItemTooltip(scene, container, x, y + slotSize / 2 + 6, item));
    hitZone.on('pointerout', () => hideItemTooltip());
    hitZone.on('pointerdown', () => {
      if (item.type === 'potion') {
        socket.emit('usePotion', item.id);
        return;
      }
      const slot = item.type; // 'weapon' | 'armor' | 'accessory'
      if (equippedItems[slot] === item.id) {
        socket.emit('unequipItem', slot);
      } else {
        socket.emit('equipItem', item.id);
      }
    });
  });
}

function refreshInventoryPanel() {
  if (!inventoryContainer || !inventoryScene) return;
  closeInventory();
  openInventory(inventoryScene, inventoryItems, equippedItems);
}

function openInventory(scene, inventory, equipped) {
  inventoryScene = scene;
  inventoryItems = inventory || inventoryItems || [];
  inventoryContainer = scene.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2);

  const panelW = 460, panelH = 380;
  drawPanelFrame(scene, inventoryContainer, panelW, panelH, 0xFFD700);

  const title = scene.add.text(0, -panelH / 2 + 24, 'Envanter', { fontSize: '22px', color: '#FFD700', fontStyle: 'bold' }).setOrigin(0.5);
  inventoryContainer.add(title);

  const tabsY = -panelH / 2 + 56;
  const tabWidth = panelW / INVENTORY_TABS.length;
  const tabTexts = [];
  const contentContainer = scene.add.container(0, 10);
  inventoryContainer.add(contentContainer);

  function renderTab(tabId) {
    contentContainer.removeAll(true);
    buildInventoryTabContent(scene, contentContainer, tabId);
  }

  INVENTORY_TABS.forEach((tab, i) => {
    const tx = -panelW / 2 + tabWidth / 2 + i * tabWidth;
    const isActive = tab.id === activeInventoryTab;
    const label = scene.add.text(tx, tabsY, tab.label, { fontSize: '14px', color: isActive ? '#ffd700' : '#aaaaaa', fontStyle: isActive ? 'bold' : 'normal' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    label.on('pointerdown', () => {
      activeInventoryTab = tab.id;
      tabTexts.forEach(t => t.text.setStyle({ color: t.id === tab.id ? '#ffd700' : '#aaaaaa', fontStyle: t.id === tab.id ? 'bold' : 'normal' }));
      hideItemTooltip();
      renderTab(tab.id);
    });
    tabTexts.push({ id: tab.id, text: label });
    inventoryContainer.add(label);
  });

  renderTab(activeInventoryTab);

  const closeButton = scene.add.text(0, panelH / 2 - 20, 'KAPAT', { fontSize: '16px', color: '#ff5555' })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true })
    .on('pointerdown', () => closeInventory());
  inventoryContainer.add(closeButton);

  inventoryContainer.setDepth(3);
  inventoryOpen = true;
}

function closeInventory() {
  if (inventoryContainer) {
    inventoryContainer.destroy();
    inventoryContainer = null;
  }
  inventoryOpen = false;
}

// Skill kullanıldığında karakterden hedefe (boss ya da oyuncu) doğru uçan
// GEÇİCİ bir "mermi" efekti. Şimdilik procedural bir top kullanıyor;
// SKILL_PROJECTILE_TEXTURE sabiti üzerinden ileride gerçek PNG'yle
// değiştirilebilir (bkz. o sabitin tanımlandığı yerdeki not).
function fireSkillProjectile(scene, fromX, fromY, toX, toY, tintColor, onArrive) {
  const projectile = scene.add.sprite(fromX, fromY, SKILL_PROJECTILE_TEXTURE).setDepth(4);
  if (tintColor !== undefined) projectile.setTint(tintColor);

  const distance = Phaser.Math.Distance.Between(fromX, fromY, toX, toY);
  const duration = Phaser.Math.Clamp(distance * 1.1, 120, 380);

  scene.tweens.add({
    targets: projectile,
    x: toX,
    y: toY,
    duration,
    ease: 'Linear',
    onComplete: () => {
      projectile.destroy();
      if (onArrive) onArrive();
    }
  });
}

function showAttackEffect(scene, x, y, tintColor) {
  const effect = scene.add.sprite(x, y, 'attackEffect').setScale(0.5);
  effect.setDepth(2);
  if (tintColor !== undefined) effect.setTint(tintColor);

  scene.tweens.add({
    targets: effect,
    scale: 1,
    alpha: 0,
    duration: 300,
    ease: 'Power1',
    onComplete: () => {
      effect.destroy();
    }
  });
}

function showDamageText(scene, targetId, damage, x, y) {
  const damageText = scene.add.text(x, y - 30, `-${damage}`, { fontSize: '16px', color: '#ff0000' }).setOrigin(0.5);
  damageText.setDepth(3);

  scene.tweens.add({
    targets: damageText,
    y: y - 60,
    alpha: 0,
    duration: 1000,
    ease: 'Power1',
    onComplete: () => {
      damageText.destroy();
    }
  });
}

function showChatMessage(scene, playerId, message, x, y) {
  if (chatMessages[playerId]) {
    chatMessages[playerId].destroy();
    delete chatMessages[playerId];
  }

  let targetSprite = null;
  if (playerId === socket.id && player) targetSprite = player;
  else if (otherPlayers[playerId]) targetSprite = otherPlayers[playerId];
  if (!targetSprite) return;

  const playerHeight = targetSprite.displayHeight || 64;
  // Sohbet balonu: yuvarlak köşeli arka plan + metin (karakterin üstünde)
  const bubble = scene.add.container(x, y - playerHeight / 2 - 52);
  const maxW = 180;
  const padX = 10, padY = 6;
  const label = scene.add.text(0, 0, message, {
    fontSize: '13px',
    color: '#111111',
    fontStyle: 'bold',
    align: 'center',
    // useAdvancedWrap: boşluksuz uzun kelimeleri de satır sonunda kırar,
    // böylece metin balonun dışına taşmaz (varsayılan wordWrap sadece
    // boşluklardan kırar, tek uzun bir kelimede taşma olurdu).
    wordWrap: { width: maxW - padX * 2, useAdvancedWrap: true }
  }).setOrigin(0.5);

  const bw = Math.min(maxW, Math.max(40, label.width + padX * 2));
  const bh = label.height + padY * 2;

  const bg = scene.add.graphics();
  bg.fillStyle(0xffffff, 0.95);
  bg.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, 8);
  bg.lineStyle(2, 0x222222, 0.9);
  bg.strokeRoundedRect(-bw / 2, -bh / 2, bw, bh, 8);
  // Küçük üçgen uç (balonun altı)
  bg.fillStyle(0xffffff, 0.95);
  bg.fillTriangle(-6, bh / 2 - 1, 6, bh / 2 - 1, 0, bh / 2 + 8);
  bg.lineStyle(2, 0x222222, 0.9);
  bg.lineBetween(-6, bh / 2 - 1, 0, bh / 2 + 8);
  bg.lineBetween(6, bh / 2 - 1, 0, bh / 2 + 8);

  bubble.add([bg, label]);
  bubble.setDepth(6);
  chatMessages[playerId] = bubble;

  scene.time.delayedCall(3500, () => {
    if (chatMessages[playerId] === bubble) {
      bubble.destroy();
      delete chatMessages[playerId];
    }
  });
}

function addOtherPlayer(scene, id, data) {
  if (!otherPlayers[id] && data.currentMap === currentMap) {
    otherPlayers[id] = scene.physics.add.sprite(data.x, data.y, getCharacterTexture(data.equipped));
    otherPlayers[id].setScale(1);
    otherPlayers[id].equipped = data.equipped;
    otherPlayers[id].direction = data.direction;
    otherPlayers[id].currentMap = data.currentMap;
    otherPlayers[id].health = typeof data.health === 'number' ? data.health : 100;
    otherPlayers[id].swordSprite = scene.add.sprite(
      data.x + (data.direction === 'right' ? 20 : -20),
      data.y,
      'sword'
    ).setVisible(false).setScale(data.direction === 'right' ? 1 : -1);
    applyWeaponVisual(otherPlayers[id].swordSprite, data.equipped);
    otherPlayers[id].swordSprite.setDepth(2);
    const playerHeight = otherPlayers[id].displayHeight;
    // İsim + can: belirgin isim ve can çubuğu
    const nameLabel = scene.add.text(data.x, data.y - playerHeight / 2 - 28, data.username, {
      fontSize: '14px', color: '#FFD700', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 3
    }).setOrigin(0.5).setDepth(3);
    otherPlayersNames[id] = nameLabel;

    const hp = otherPlayers[id].health;
    const barBg = scene.add.rectangle(data.x, data.y - playerHeight / 2 - 12, 52, 7, 0x330000).setOrigin(0.5).setDepth(3);
    const barFill = scene.add.rectangle(data.x - 26, data.y - playerHeight / 2 - 12, 52 * (hp / 100), 7, 0xff3333).setOrigin(0, 0.5).setDepth(3);
    const hpText = scene.add.text(data.x, data.y - playerHeight / 2 - 12, `${Math.round(hp)}`, {
      fontSize: '10px', color: '#ffffff', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 2
    }).setOrigin(0.5).setDepth(4);
    otherPlayersHealthBars[id] = { barBg, barFill, hpText };
    otherPlayers[id].setDepth(1);
    otherPlayers[id].scaleX = data.direction === 'right' ? 1 : -1;
  }
}

function removeOtherPlayer(id) {
  if (otherPlayers[id]) {
    if (otherPlayers[id].idleTimer) otherPlayers[id].idleTimer.remove(false);
    otherPlayers[id].destroy();
    if (otherPlayers[id].swordSprite) otherPlayers[id].swordSprite.destroy();
    if (otherPlayersNames[id]) otherPlayersNames[id].destroy();
    if (otherPlayersHealthBars[id]) {
      const hb = otherPlayersHealthBars[id];
      if (hb.barBg) hb.barBg.destroy();
      if (hb.barFill) hb.barFill.destroy();
      if (hb.hpText) hb.hpText.destroy();
      delete otherPlayersHealthBars[id];
    }
    if (chatMessages[id]) {
      chatMessages[id].destroy();
      delete chatMessages[id];
    }
    delete otherPlayers[id];
    delete otherPlayersNames[id];
  }
}

function handlePlayerDeath(scene, token) {
  isDead = true;
  isAttacking = false;
  if (player) player.destroy();
  if (swordSprite) swordSprite.destroy();
  if (healthText) healthText.destroy();
  if (healthBar) healthBar.destroy();
  if (playerNameText) playerNameText.destroy();
  if (inventoryContainer) inventoryContainer.destroy();
  if (mapContainer) mapContainer.destroy();
  if (chatMessages[socket.id]) {
    chatMessages[socket.id].destroy();
    delete chatMessages[socket.id];
  }

  if (countdownText) countdownText.destroy();
  if (restartButton) restartButton.destroy();

  let countdown = 5;
  countdownText = scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, `Tekrar Başla: ${countdown}`, { fontSize: '32px', color: '#ffffff' }).setOrigin(0.5);

  const timer = scene.time.addEvent({
    delay: 1000,
    callback: () => {
      countdown--;
      if (countdownText) {
        countdownText.setText(`Tekrar Başla: ${countdown}`);
      }
      if (countdown <= 0) {
        if (countdownText) countdownText.destroy();
        restartButton = scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'Başla', { fontSize: '32px', color: '#00ff00' })
          .setOrigin(0.5)
          .setInteractive()
          .on('pointerdown', () => {
            const isBossMap = BOSS_MAP_IDS.includes(currentMap);
            const bossCfg = isBossMap ? BOSS_MAPS.find(m => m.id === currentMap) : null;
            const spawnX = isBossMap ? bossCfg.spawnX : GAME_WIDTH / 2;
            const spawnY = isBossMap ? bossCfg.spawnY : GAME_HEIGHT / 2;

            mainMap.setVisible(currentMap === 'main');
            BOSS_MAPS.forEach(m => bossMapImages[m.id].setVisible(currentMap === m.id));
            npc.setVisible(currentMap === 'main');
            exclamationMark.setVisible(currentMap === 'main');
            if (!isBossMap) {
              destroyBossSprite();
            }

            player = scene.physics.add.sprite(spawnX, spawnY, getCharacterTexture(equippedItems));
            player.setCollideWorldBounds(true);
            player.setScale(1);
            playerDirection = 'right';
            player.scaleX = 1;
            swordSprite = scene.add.sprite(spawnX + 20, spawnY, 'sword').setVisible(false).setScale(1);
            applyWeaponVisual(swordSprite, equippedItems);
            swordSprite.setDepth(2);
            const playerHeight = player.displayHeight;
            playerNameText = scene.add.text(spawnX, spawnY - playerHeight / 2 - 28, '', {
              fontSize: '14px', color: '#FFD700', fontStyle: 'bold',
              stroke: '#000000', strokeThickness: 3
            }).setOrigin(0.5).setDepth(3);
            health = 100;
            healthText = scene.add.text(10, 10, `Can: ${health}`, { fontSize: '20px', color: '#ffffff' });
            healthBar = scene.add.rectangle(spawnX, spawnY - playerHeight / 2 - 12, 52, 7, 0xff0000).setDepth(3);
            player.setDepth(1);

            socket.emit('respawn', { 
              token, 
              x: spawnX, 
              y: spawnY, 
              currentMap: currentMap, 
              direction: playerDirection,
              equipped: equippedItems
            });

            restartButton.destroy();
            isDead = false;
            isAttacking = false;

            if (isBossMap && bossDataMap[currentMap]) {
              destroyBossSprite();
              createBossSprite(scene, currentMap, bossDataMap[currentMap]);
            }
          });
      }
    },
    repeat: 4
  });
}

function update() {
  updateSkillCooldownsUI(this);

  // Yol dışında kalmışsa (ışınlanma, yeniden doğma vb.) en yakın yola al.
  if (player && !isDead && hasWalkLimit(currentMap)) {
    if (snapPlayerToWalkable()) {
      socket.emit('move', { x: player.x, y: player.y });
    }
  }

  if (player && target && !isDead && !isAnyPanelOpen()) {
    const speed = 200;
    const distance = Phaser.Math.Distance.Between(player.x, player.y, target.x, target.y);

    if (distance > 4) {
      movePlayerToward(this, speed);
      socket.emit('move', { x: player.x, y: player.y });
      const playerHeight = player.displayHeight;
      healthBar.setPosition(player.x, player.y - playerHeight / 2 - 12);
      playerNameText.setPosition(player.x, player.y - playerHeight / 2 - 28);
      if (chatMessages[socket.id]) {
        chatMessages[socket.id].setPosition(player.x, player.y - playerHeight / 2 - 52);
      }
    } else {
      player.setVelocity(0);
      target = null;
      socket.emit('move', { x: player.x, y: player.y });
    }
  }

  // Yürüme/duruş animasyonunu her karede senkron tutar (hareket başlayınca
  // yürüme, durunca duruş karesine döner; vuruş animasyonu oynarken dokunmaz).
  if (player && !isDead) {
    updatePlayerCharacter();
  }
}
// ---- Başlangıç ----
// Token yoksa (giriş yapılmamışsa) sunucu seçim ekranını bile göstermeden
// login sayfasına yönlendir — mevcut giriş akışıyla birebir aynı davranış.
// Token varsa önce sunucu seçim ekranı gösterilir; Phaser oyunu (startGame)
// ancak oyuncu bir oda seçtikten sonra başlar.
token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/';
} else {
  initServerSelectScreen();
}
