const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
app.use(express.static(__dirname));

const players = {};
const JWT_SECRET = process.env.JWT_SECRET || 'gizli-anahtar';
const DATA_FILE = path.join(__dirname, 'data.json');

function loadUsersFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('data.json okunamadı, boş listeyle başlanıyor:', err.message);
  }
  return [];
}

let users = loadUsersFromDisk();
const BOSS_RESPAWN_TIME = 10000;
const BOSS_ATTACK_INTERVAL = 3000;

// ---- 5 Boss Haritası ----
const BOSS_MAPS = [
  { id: 'boss1', name: 'Ejderha Vadisi',   mapImage: 'boss_map1', bossImage: 'boss1', x: 1000, y: 500, maxHealth: 250, attackPower: 5,  goldReward: 5 },
  { id: 'boss2', name: 'Buz Mağarası',     mapImage: 'boss_map2', bossImage: 'boss2', x: 1000, y: 500, maxHealth: 350, attackPower: 7,  goldReward: 8 },
  { id: 'boss3', name: 'Kayıp Tapınak',    mapImage: 'boss_map3', bossImage: 'boss3', x: 1000, y: 500, maxHealth: 450, attackPower: 9,  goldReward: 12 },
  { id: 'boss4', name: 'Karanlık Orman',   mapImage: 'boss_map4', bossImage: 'boss4', x: 1000, y: 500, maxHealth: 550, attackPower: 11, goldReward: 16 },
  { id: 'boss5', name: 'Gölgeler Kalesi',  mapImage: 'boss_map5', bossImage: 'boss5', x: 1000, y: 500, maxHealth: 700, attackPower: 14, goldReward: 22 }
];
const BOSS_MAP_IDS = BOSS_MAPS.map(m => m.id);

// Artık her oda kendi boss'larına sahip: bosses[roomId][mapId]
const bosses = {};

// ---- Skill Sistemi ----
const SKILLS = {
  1: { dmgMult: 1,   cooldown: 800,   type: 'attack' },
  2: { dmgMult: 1.8, cooldown: 3000,  type: 'attack' },
  3: { dmgMult: 1.4, cooldown: 5000,  type: 'attack' },
  4: { cooldown: 8000, type: 'heal', healAmount: 30 },
  5: { dmgMult: 3,   cooldown: 12000, type: 'attack' }
};
const skillLastUsed = {};

// ---- Eşya Kataloğu ----
// Oyun artık tek eşyalı: sadece kılıç var (mağazada bedava, envanterde
// başlangıçtan itibaren hazır). Diğer tüm eşyalar (zırh, iksir, yüzük,
// tılsım, ekstra kılıçlar) kaldırıldı.
const ITEM_CATALOG = {
  sword: { name: 'Kılıç', type: 'weapon', rarity: 'common', attackPower: 10, defense: 0, price: 0 }
};
const SHOP_ITEM_IDS = ['sword'];

const DEFAULT_INVENTORY = () => ([
  { id: 'sword', name: 'sword', type: 'weapon', rarity: 'common', quantity: 1, attackPower: 10, defense: 0 }
]);
const DEFAULT_EQUIPPED = () => ({ weapon: null, armor: null, accessory: null });

const QUESTS = [
  { id: 'q1', name: 'Çırak Avcı',      target: 3,  reward: 15 },
  { id: 'q2', name: 'Canavar Avcısı',  target: 10, reward: 40 },
  { id: 'q3', name: 'Şampiyon',        target: 25, reward: 100 },
  { id: 'q4', name: 'Efsane Savaşçı',  target: 50, reward: 250 }
];

function computeStats(player) {
  let attackPower = 5;
  let defense = 0;
  const weapon = player.equipped.weapon ? ITEM_CATALOG[player.equipped.weapon] : null;
  if (weapon) attackPower = weapon.attackPower;
  return { attackPower, defense };
}

async function persistPlayer(socketId) {
  const p = players[socketId];
  if (!p) return;
  const existingUsers = await readUsers();
  const idx = existingUsers.findIndex(u => u.username === p.username);
  if (idx === -1) return;
  existingUsers[idx].x = p.x;
  existingUsers[idx].y = p.y;
  existingUsers[idx].gold = p.gold;
  existingUsers[idx].level = p.level;
  existingUsers[idx].bossKills = p.bossKills;
  existingUsers[idx].totalBossKills = p.totalBossKills;
  existingUsers[idx].inventory = p.inventory;
  existingUsers[idx].equipped = p.equipped;
  existingUsers[idx].pvpEnabled = p.pvpEnabled;
  existingUsers[idx].claimedQuests = p.claimedQuests;
  await writeUsers(existingUsers);
}

function canUseSkill(socketId, skillId) {
  const skill = SKILLS[skillId];
  if (!skill) return null;
  const now = Date.now();
  if (!skillLastUsed[socketId]) skillLastUsed[socketId] = {};
  const last = skillLastUsed[socketId][skillId] || 0;
  if (now - last < skill.cooldown) return null;
  skillLastUsed[socketId][skillId] = now;
  return skill;
}

async function readUsers() {
  return users;
}

async function writeUsers(newUsers) {
  users = newUsers;
  try {
    await fs.promises.writeFile(DATA_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('data.json kaydedilemedi:', err.message);
  }
}

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const existingUsers = await readUsers();
  if (existingUsers.find(u => u.username === username)) {
    return res.status(400).send('Kullanıcı adı zaten alınmış');
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    username,
    password: hashedPassword,
    x: 400,
    y: 300,
    gold: 0,
    level: 1,
    bossKills: 0,
    totalBossKills: 0,
    pvpEnabled: false,
    claimedQuests: [],
    inventory: DEFAULT_INVENTORY(),
    equipped: DEFAULT_EQUIPPED()
  };
  existingUsers.push(newUser);
  await writeUsers(existingUsers);
  res.status(201).send('Kayıt başarılı');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const existingUsers = await readUsers();
  const user = existingUsers.find(u => u.username === username);
  if (user && await bcrypt.compare(password, user.password)) {
    const token = jwt.sign({ username }, JWT_SECRET);
    res.json({
      token,
      x: user.x,
      y: user.y,
      gold: user.gold || 0,
      level: user.level || 1,
      bossKills: user.bossKills || 0,
      totalBossKills: user.totalBossKills || 0,
      pvpEnabled: user.pvpEnabled || false,
      claimedQuests: user.claimedQuests || [],
      inventory: user.inventory || DEFAULT_INVENTORY(),
      equipped: user.equipped || DEFAULT_EQUIPPED()
    });
  } else {
    res.status(401).send('Geçersiz kimlik bilgileri');
  }
});

// ---- Sunucu Odaları (gerçek izolasyon) ----
const SERVER_ROOMS = [
  { id: 'oda1', name: 'Anka', base: 1240 },
  { id: 'oda2', name: 'Kaan', base: 860 },
  { id: 'oda3', name: 'Zümrüt', base: 410 }
];
const ROOM_FULL_AT = 1500;
const roomLiveCounts = {};
SERVER_ROOMS.forEach(r => { roomLiveCounts[r.id] = 0; });

function getServerRoomsPayload() {
  const rooms = SERVER_ROOMS.map(r => {
    const count = r.base + (roomLiveCounts[r.id] || 0);
    return { id: r.id, name: r.name, count, full: count >= ROOM_FULL_AT };
  });
  return { rooms, totalOnline: rooms.reduce((sum, r) => sum + r.count, 0) };
}

app.get('/api/server-rooms', (req, res) => {
  res.json(getServerRoomsPayload());
});

// Sadece aynı odaya yayın
function emitToRoom(roomId, event, data) {
  if (!roomId) return;
  io.to(roomId).emit(event, data);
}

function getRoomBoss(roomId, mapId) {
  if (!bosses[roomId]) bosses[roomId] = {};
  return bosses[roomId][mapId];
}

function spawnBoss(roomId, mapId) {
  const config = BOSS_MAPS.find(m => m.id === mapId);
  if (!config) return;
  if (!bosses[roomId]) bosses[roomId] = {};
  bosses[roomId][mapId] = {
    x: config.x,
    y: config.y,
    health: config.maxHealth,
    maxHealth: config.maxHealth,
    level: 5,
    attackPower: config.attackPower,
    goldReward: config.goldReward,
    alive: true
  };
  emitToRoom(roomId, 'bossSpawned', { mapId, boss: bosses[roomId][mapId] });
}

function spawnAllBossesForRoom(roomId) {
  BOSS_MAPS.forEach(m => spawnBoss(roomId, m.id));
}

function spawnAllBosses() {
  SERVER_ROOMS.forEach(r => spawnAllBossesForRoom(r.id));
}

io.on('connection', (socket) => {
  console.log('Yeni oyuncu bağlandı:', socket.id);

  const requestedRoom = socket.handshake.query && socket.handshake.query.server;
  socket.serverRoom = SERVER_ROOMS.some(r => r.id === requestedRoom) ? requestedRoom : SERVER_ROOMS[0].id;

  // Gerçek Socket.IO odasına katıl
  socket.join(socket.serverRoom);
  roomLiveCounts[socket.serverRoom] = (roomLiveCounts[socket.serverRoom] || 0) + 1;
  io.emit('serverRoomCounts', getServerRoomsPayload());

  // Bu odanın mevcut boss'larını sadece bu oyuncuya gönder
  const roomBosses = bosses[socket.serverRoom] || {};
  Object.keys(roomBosses).forEach(mapId => {
    socket.emit('bossSpawned', { mapId, boss: roomBosses[mapId] });
  });

  socket.on('join', async (data) => {
    try {
      const { token } = data;
      const decoded = jwt.verify(token, JWT_SECRET);
      const existingUsers = await readUsers();
      const user = existingUsers.find(u => u.username === decoded.username);

      if (user) {
        // Aynı kullanıcı başka yerdeyse temizle
        for (let id in players) {
          if (players[id].username === user.username && id !== socket.id) {
            emitToRoom(players[id].serverRoom, 'playerDisconnected', id);
            delete players[id];
          }
        }

        players[socket.id] = {
          username: user.username,
          x: user.x,
          y: user.y,
          character: 'player',
          rotation: 0,
          health: 100,
          gold: user.gold || 0,
          level: user.level || 1,
          bossKills: user.bossKills || 0,
          totalBossKills: user.totalBossKills || 0,
          pvpEnabled: user.pvpEnabled || false,
          claimedQuests: user.claimedQuests || [],
          dailyGiftClaimed: false,
          inventory: user.inventory || DEFAULT_INVENTORY(),
          equipped: user.equipped || DEFAULT_EQUIPPED(),
          attackPower: 5,
          defense: 0,
          direction: 'right',
          currentMap: 'main',
          serverRoom: socket.serverRoom
        };

        const stats = computeStats(players[socket.id]);
        players[socket.id].attackPower = stats.attackPower;
        players[socket.id].defense = stats.defense;

        // Sadece aynı oda + aynı haritadaki oyuncuları gönder
        const playersInSameMap = Object.keys(players)
          .filter(id => players[id].serverRoom === socket.serverRoom && players[id].currentMap === players[socket.id].currentMap)
          .reduce((obj, id) => {
            obj[id] = players[id];
            return obj;
          }, {});
        socket.emit('currentPlayers', playersInSameMap);

        // Sadece kendi odasına "yeni oyuncu" bildir
        socket.to(socket.serverRoom).emit('newPlayer', {
          id: socket.id,
          username: user.username,
          x: user.x,
          y: user.y,
          health: 100,
          character: players[socket.id].character,
          gold: players[socket.id].gold,
          level: players[socket.id].level,
          equipped: players[socket.id].equipped,
          direction: players[socket.id].direction,
          currentMap: players[socket.id].currentMap
        });

        console.log('Oyuncu katıldı:', user.username, 'Oda:', socket.serverRoom, 'Harita:', players[socket.id].currentMap);
      }
    } catch (error) {
      console.log('Join hatası:', error.message);
      socket.disconnect();
    }
  });

  socket.on('respawn', async (data) => {
    try {
      const { token, x, y, currentMap, direction, equipped } = data;
      const decoded = jwt.verify(token, JWT_SECRET);
      const existingUsers = await readUsers();
      const user = existingUsers.find(u => u.username === decoded.username);

      if (user) {
        players[socket.id] = {
          username: user.username,
          x: x,
          y: y,
          character: 'player',
          rotation: 0,
          health: 100,
          gold: user.gold || 0,
          level: user.level || 1,
          bossKills: user.bossKills || 0,
          totalBossKills: user.totalBossKills || 0,
          pvpEnabled: user.pvpEnabled || false,
          claimedQuests: user.claimedQuests || [],
          dailyGiftClaimed: false,
          inventory: user.inventory || DEFAULT_INVENTORY(),
          equipped: equipped || DEFAULT_EQUIPPED(),
          attackPower: 5,
          defense: 0,
          direction: direction,
          currentMap: currentMap,
          serverRoom: socket.serverRoom
        };

        const stats = computeStats(players[socket.id]);
        players[socket.id].attackPower = stats.attackPower;
        players[socket.id].defense = stats.defense;

        const playersInSameMap = Object.keys(players)
          .filter(id => players[id].serverRoom === socket.serverRoom && players[id].currentMap === currentMap)
          .reduce((obj, id) => {
            obj[id] = players[id];
            return obj;
          }, {});
        socket.emit('currentPlayers', playersInSameMap);

        socket.to(socket.serverRoom).emit('newPlayer', {
          id: socket.id,
          username: user.username,
          x: x,
          y: y,
          health: 100,
          character: players[socket.id].character,
          gold: players[socket.id].gold,
          level: players[socket.id].level,
          equipped: players[socket.id].equipped,
          direction: players[socket.id].direction,
          currentMap: players[socket.id].currentMap
        });

        console.log('Oyuncu yeniden doğdu:', user.username, 'Oda:', socket.serverRoom);
      }
    } catch (error) {
      console.log('Respawn hatası:', error.message);
      socket.disconnect();
    }
  });

  socket.on('move', async (data) => {
    if (players[socket.id]) {
      const oldX = players[socket.id].x;
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].rotation = data.rotation;
      if (data.x > oldX) {
        players[socket.id].direction = 'right';
      } else if (data.x < oldX) {
        players[socket.id].direction = 'left';
      }

      emitToRoom(socket.serverRoom, 'playerMoved', {
        id: socket.id,
        username: players[socket.id].username,
        x: data.x,
        y: data.y,
        rotation: data.rotation,
        health: players[socket.id].health,
        character: players[socket.id].character,
        gold: players[socket.id].gold,
        level: players[socket.id].level,
        equipped: players[socket.id].equipped,
        direction: players[socket.id].direction,
        currentMap: players[socket.id].currentMap
      });
      await persistPlayer(socket.id);
    }
  });

  socket.on('changeMap', (newMap) => {
    if (players[socket.id]) {
      players[socket.id].currentMap = newMap;

      // Eski haritadakilere "çıktı" bildir
      emitToRoom(socket.serverRoom, 'playerDisconnected', socket.id);

      // Yeni haritadakilere "girdi" bildir
      socket.to(socket.serverRoom).emit('newPlayer', {
        id: socket.id,
        username: players[socket.id].username,
        x: players[socket.id].x,
        y: players[socket.id].y,
        health: players[socket.id].health,
        character: players[socket.id].character,
        gold: players[socket.id].gold,
        level: players[socket.id].level,
        equipped: players[socket.id].equipped,
        direction: players[socket.id].direction,
        currentMap: players[socket.id].currentMap
      });

      // Kendisine yeni haritadaki oyuncuları gönder
      const playersInNewMap = Object.keys(players)
        .filter(id => players[id].serverRoom === socket.serverRoom && players[id].currentMap === newMap && id !== socket.id)
        .reduce((obj, id) => {
          obj[id] = players[id];
          return obj;
        }, {});
      socket.emit('currentPlayers', playersInNewMap);
    }
  });

  socket.on('equipItem', async (itemId) => {
    const p = players[socket.id];
    if (!p) return;
    const def = ITEM_CATALOG[itemId];
    const owned = p.inventory.some(i => i.id === itemId);
    if (!def || !owned) return;
    if (def.type === 'weapon') p.equipped.weapon = itemId;
    else if (def.type === 'armor') p.equipped.armor = itemId;
    else if (def.type === 'accessory') p.equipped.accessory = itemId;
    else return;

    const stats = computeStats(p);
    p.attackPower = stats.attackPower;
    p.defense = stats.defense;
    await persistPlayer(socket.id);
    emitToRoom(socket.serverRoom, 'itemEquipped', { id: socket.id, equipped: p.equipped });
  });

  socket.on('unequipItem', async (slot) => {
    const p = players[socket.id];
    if (!p || !['weapon', 'armor', 'accessory'].includes(slot) || !p.equipped[slot]) return;
    p.equipped[slot] = null;
    const stats = computeStats(p);
    p.attackPower = stats.attackPower;
    p.defense = stats.defense;
    await persistPlayer(socket.id);
    emitToRoom(socket.serverRoom, 'itemUnequipped', { id: socket.id, equipped: p.equipped });
  });

  socket.on('buyItem', async (itemId) => {
    const p = players[socket.id];
    const def = ITEM_CATALOG[itemId];
    if (!p || !def || !SHOP_ITEM_IDS.includes(itemId) || !def.price) return;
    if (p.gold < def.price) {
      socket.emit('notice', 'Yetersiz altın!');
      return;
    }
    const existing = p.inventory.find(i => i.id === itemId);
    if (existing && def.stackable) {
      existing.quantity += 1;
    } else if (!existing) {
      p.inventory.push({
        id: itemId, name: itemId, type: def.type, rarity: def.rarity,
        quantity: 1, attackPower: def.attackPower || 0, defense: def.defense || 0, heal: def.heal || 0
      });
    } else {
      socket.emit('notice', 'Bu eşyaya zaten sahipsin!');
      return;
    }
    p.gold -= def.price;
    await persistPlayer(socket.id);
    socket.emit('goldUpdate', { id: socket.id, gold: p.gold });
    socket.emit('inventoryUpdate', p.inventory);
    socket.emit('notice', `${def.name} satın alındı!`);
  });

  socket.on('usePotion', async (itemId) => {
    const p = players[socket.id];
    if (!p) return;
    const item = p.inventory.find(i => i.id === itemId && i.type === 'potion');
    if (!item || item.quantity <= 0) return;
    if (p.health >= 100) {
      socket.emit('notice', 'Canın zaten dolu!');
      return;
    }
    item.quantity -= 1;
    p.health = Math.min(100, p.health + (item.heal || 30));
    if (item.quantity <= 0) {
      p.inventory = p.inventory.filter(i => i !== item);
    }
    await persistPlayer(socket.id);
    io.to(socket.id).emit('updateHealth', p.health);
    emitToRoom(socket.serverRoom, 'playerHealthUpdate', { id: socket.id, health: p.health });
    socket.emit('inventoryUpdate', p.inventory);
  });

  socket.on('togglePvp', async () => {
    const p = players[socket.id];
    if (!p) return;
    p.pvpEnabled = !p.pvpEnabled;
    await persistPlayer(socket.id);
    socket.emit('pvpUpdate', p.pvpEnabled);
    socket.emit('notice', p.pvpEnabled ? 'PvP açıldı!' : 'PvP kapatıldı.');
  });

  socket.on('claimDailyGift', async () => {
    const p = players[socket.id];
    if (!p) return;
    if (p.dailyGiftClaimed) {
      socket.emit('notice', 'Bugünkü hediyeni zaten aldın!');
      return;
    }
    p.dailyGiftClaimed = true;
    const bonus = 10 + Math.floor(Math.random() * 11);
    p.gold += bonus;
    await persistPlayer(socket.id);
    socket.emit('goldUpdate', { id: socket.id, gold: p.gold });
    socket.emit('notice', `Günlük hediye: +${bonus} altın!`);
  });

  socket.on('claimQuest', async (questId) => {
    const p = players[socket.id];
    const quest = QUESTS.find(q => q.id === questId);
    if (!p || !quest) return;
    if (p.claimedQuests.includes(questId)) {
      socket.emit('notice', 'Bu ödülü zaten aldın!');
      return;
    }
    if ((p.totalBossKills || 0) < quest.target) {
      socket.emit('notice', 'Görev henüz tamamlanmadı.');
      return;
    }
    p.claimedQuests.push(questId);
    p.gold += quest.reward;
    await persistPlayer(socket.id);
    socket.emit('goldUpdate', { id: socket.id, gold: p.gold });
    socket.emit('questsUpdate', { totalBossKills: p.totalBossKills, claimedQuests: p.claimedQuests });
    socket.emit('notice', `${quest.name} ödülü alındı: +${quest.reward} altın!`);
  });

  socket.on('attack', (data) => {
    const targetId = data && data.targetId;
    const skillId = (data && data.skillId) || 1;
    if (!players[socket.id] || !players[targetId]) return;
    // Farklı odadaysa hiç dokunma
    if (players[socket.id].serverRoom !== players[targetId].serverRoom) return;
    if (players[socket.id].currentMap !== players[targetId].currentMap) return;

    const attacker = players[socket.id];
    const target = players[targetId];
    const distance = Math.sqrt((attacker.x - target.x) ** 2 + (attacker.y - target.y) ** 2);

    const skill = canUseSkill(socket.id, skillId);
    if (distance < 260 && skill && skill.type === 'attack') {
      if (!attacker.pvpEnabled || !target.pvpEnabled) {
        socket.emit('notice', 'PvP kapalı - bu oyuncuya saldıramazsın.');
        return;
      }
      let damage = (attacker.attackPower || 5) * skill.dmgMult;
      damage = Math.max(1, Math.round(damage) - target.defense);
      target.health -= damage;

      emitToRoom(socket.serverRoom, 'attackDamage', { targetId, damage, x: target.x, y: target.y });

      if (target.health <= 0) {
        io.to(targetId).emit('dead');
        emitToRoom(socket.serverRoom, 'playerDied', targetId);
        attacker.gold += 1;
        emitToRoom(socket.serverRoom, 'goldUpdate', { id: socket.id, gold: attacker.gold });
        delete players[targetId];
      } else {
        io.to(targetId).emit('updateHealth', target.health);
        emitToRoom(socket.serverRoom, 'playerHealthUpdate', { id: targetId, health: target.health });
      }
    }
  });

  // Saldırı animasyonunu odadaki (ve aynı haritadaki) diğer oyunculara
  // yayınlar — hedefe isabet etsin etmesin, hatta hiç hedef olmasa bile
  // (boşa saldırı) tetiklenir. SADECE görsel bilgi taşır; can/hasar
  // hesaplaması yukarıdaki 'attack' ve aşağıdaki 'attackBoss' event'lerinde
  // AYNEN eskisi gibi devam ediyor, buraya hiç dokunulmadı.
  socket.on('playerAttack', (data) => {
    const p = players[socket.id];
    if (!p) return;
    socket.to(p.serverRoom).emit('playerAttacked', {
      id: socket.id,
      skillId: (data && data.skillId) || 1,
      x: p.x,
      y: p.y,
      direction: p.direction,
      currentMap: p.currentMap
    });
  });

  const attackTimers = {};

  socket.on('attackBoss', (data) => {
    const mapId = typeof data === 'string' ? data : data && data.mapId;
    const skillId = (data && data.skillId) || 1;
    const roomId = socket.serverRoom;
    const boss = getRoomBoss(roomId, mapId);

    if (players[socket.id] && boss && boss.alive && players[socket.id].currentMap === mapId) {
      const attacker = players[socket.id];
      const distance = Math.sqrt((attacker.x - boss.x) ** 2 + (attacker.y - boss.y) ** 2);

      const skill = canUseSkill(socket.id, skillId);
      if (distance < 260 && skill && skill.type === 'attack') {
        let damage = (attacker.attackPower || 5) * skill.dmgMult;
        damage = Math.max(1, Math.round(damage));
        boss.health -= damage;

        emitToRoom(roomId, 'bossHealthUpdate', { mapId, health: boss.health, damage, x: boss.x, y: boss.y });

        if (!attackTimers[socket.id]) {
          attackTimers[socket.id] = setInterval(() => {
            const currentBoss = getRoomBoss(roomId, mapId);
            if (currentBoss && currentBoss.alive && players[socket.id]) {
              const currentDistance = Math.sqrt((players[socket.id].x - currentBoss.x) ** 2 + (players[socket.id].y - currentBoss.y) ** 2);
              if (currentDistance < 100 && players[socket.id].currentMap === mapId) {
                let bossDamage = currentBoss.attackPower;
                bossDamage = Math.max(1, bossDamage - attacker.defense);
                attacker.health -= bossDamage;
                emitToRoom(roomId, 'bossAttack', { targetId: socket.id, damage: bossDamage, x: attacker.x, y: attacker.y });

                if (attacker.health <= 0) {
                  io.to(socket.id).emit('dead');
                  emitToRoom(roomId, 'playerDied', socket.id);
                  delete players[socket.id];
                  clearInterval(attackTimers[socket.id]);
                  delete attackTimers[socket.id];
                } else {
                  io.to(socket.id).emit('updateHealth', attacker.health);
                  emitToRoom(roomId, 'playerHealthUpdate', { id: socket.id, health: attacker.health });
                }
              } else {
                clearInterval(attackTimers[socket.id]);
                delete attackTimers[socket.id];
              }
            } else {
              clearInterval(attackTimers[socket.id]);
              delete attackTimers[socket.id];
            }
          }, BOSS_ATTACK_INTERVAL);
        }

        if (boss.health <= 0) {
          boss.alive = false;
          emitToRoom(roomId, 'bossDied', { mapId });
          attacker.gold += boss.goldReward || 5;
          attacker.bossKills += 1;
          attacker.totalBossKills = (attacker.totalBossKills || 0) + 1;
          if (attacker.bossKills >= 100) {
            attacker.level += 1;
            attacker.bossKills = 0;
            emitToRoom(roomId, 'levelUp', { id: socket.id, level: attacker.level });
          }
          emitToRoom(roomId, 'goldUpdate', { id: socket.id, gold: attacker.gold });
          emitToRoom(roomId, 'bossKillsUpdate', { id: socket.id, bossKills: attacker.bossKills });
          io.to(socket.id).emit('questsUpdate', { totalBossKills: attacker.totalBossKills, claimedQuests: attacker.claimedQuests });
          persistPlayer(socket.id);

          for (let id in attackTimers) {
            clearInterval(attackTimers[id]);
            delete attackTimers[id];
          }

          setTimeout(() => {
            spawnBoss(roomId, mapId);
          }, BOSS_RESPAWN_TIME);
        }
      }
    }
  });

  socket.on('useSkillHeal', (data) => {
    const skillId = data && data.skillId;
    const player = players[socket.id];
    if (!player) return;
    const skill = canUseSkill(socket.id, skillId);
    if (!skill || skill.type !== 'heal') return;
    if (player.health <= 0) return;

    player.health = Math.min(100, player.health + skill.healAmount);
    io.to(socket.id).emit('updateHealth', player.health);
    emitToRoom(socket.serverRoom, 'playerHealthUpdate', { id: socket.id, health: player.health });
  });

  const chatLastSent = {};
  socket.on('chatMessage', (message) => {
    if (!players[socket.id]) return;
    if (typeof message !== 'string') return;
    let text = message.trim();
    if (!text) return;
    if (text.length > 150) text = text.slice(0, 150);
    const now = Date.now();
    const last = chatLastSent[socket.id] || 0;
    if (now - last < 5000) {
      socket.emit('notice', '5 saniyede bir mesaj gönderebilirsin.');
      return;
    }
    chatLastSent[socket.id] = now;
    // Sadece kendi odasına sohbet
    emitToRoom(socket.serverRoom, 'chatMessage', {
      id: socket.id,
      username: players[socket.id].username,
      message: text,
      x: players[socket.id].x,
      y: players[socket.id].y
    });
  });

  socket.on('disconnect', () => {
    if (socket.serverRoom && roomLiveCounts[socket.serverRoom] != null) {
      roomLiveCounts[socket.serverRoom] = Math.max(0, roomLiveCounts[socket.serverRoom] - 1);
      io.emit('serverRoomCounts', getServerRoomsPayload());
    }
    if (players[socket.id]) {
      emitToRoom(socket.serverRoom, 'playerDisconnected', socket.id);
      console.log('Oyuncu ayrıldı:', socket.id, 'Oda:', socket.serverRoom);
      if (attackTimers[socket.id]) {
        clearInterval(attackTimers[socket.id]);
        delete attackTimers[socket.id];
      }
      delete skillLastUsed[socket.id];
      delete chatLastSent[socket.id];
      delete players[socket.id];
    }
  });
});

spawnAllBosses();

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Sunucu ${port} portunda çalışıyor`));
