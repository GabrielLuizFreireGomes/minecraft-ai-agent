// Dados para o painel ao vivo: mapa visto de cima ao redor do bot, entidades, status, log.
const memory = require('./memory')
const log = require('./log')
const { HOSTILE } = require('./skills/survival')

const R = 32 // raio do mapa (64x64)
const COLORS = [
  [/water|kelp|seagrass/, '#2f6fb3'], [/lava|magma/, '#e2621b'], [/grass_block|moss|fern|short_grass|tall_grass/, '#4f8a3a'],
  [/leaves|azalea|vine/, '#2f6a2a'], [/_log$|_wood$|_stem$/, '#6b4f2f'], [/_planks|_stairs|_slab|_fence|_door|_trapdoor|crafting|chest|barrel/, '#a07c4c'],
  [/sand|sandstone/, '#d6c58e'], [/snow|ice|powder/, '#e6eef2'], [/dirt|path|farmland|mud|podzol|rooted/, '#7a5a3b'],
  [/gravel|clay/, '#8b8580'], [/stone|cobble|andesite|diorite|granite|tuff|deepslate|ore/, '#7d7f7d'], [/glass/, '#a9d4dc'],
  [/bed$|wool|carpet|terracotta|concrete/, '#b3524a'], [/torch|lantern|glowstone|lamp/, '#f2c45a'], [/flower|rose|tulip|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily/, '#d9579b'],
  [/netherrack|nether_/, '#7a2f2f'], [/hay|pumpkin|melon/, '#d39b2a'], [/obsidian|blackstone|basalt/, '#2b2733']
]
const colorCache = new Map()
function color (name) {
  if (colorCache.has(name)) return colorCache.get(name)
  const c = (COLORS.find(([re]) => re.test(name)) || [null, '#6d7a5e'])[1]
  colorCache.set(name, c)
  return c
}

function map (bot) {
  const p = bot.entity.position.floored()
  const palette = []
  const index = new Map()
  const cells = []
  for (let dz = -R; dz < R; dz++) {
    for (let dx = -R; dx < R; dx++) {
      let name = null
      let h = 0
      for (let dy = 8; dy >= -20; dy--) {
        const b = bot.blockAt(p.offset(dx, dy, dz))
        if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air' && b.name !== 'light') { name = b.name; h = dy; break }
      }
      if (!name) { cells.push(-1); continue }
      const c = color(name)
      if (!index.has(c)) { index.set(c, palette.length); palette.push(c) }
      // altura relativa no byte alto para sombreamento
      cells.push(index.get(c) * 64 + Math.max(0, Math.min(63, h + 32)))
    }
  }
  return { r: R, palette, cells }
}

function entities (bot) {
  const p = bot.entity.position
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && Math.abs(e.position.x - p.x) < R && Math.abs(e.position.z - p.z) < R)
    .map(e => ({
      kind: e.type === 'player' ? 'player' : (HOSTILE.has(e.name) ? 'hostile' : (e.name === 'item' ? 'item' : (e.name === 'villager' ? 'villager' : 'mob'))),
      name: e.type === 'player' ? e.username : e.name,
      x: +(e.position.x - p.x).toFixed(1),
      z: +(e.position.z - p.z).toFixed(1)
    }))
}

function build (controller, bot) {
  const st = controller.status()
  const s = memory.state
  const grave = (g) => g && { x: g.x, y: g.y, z: g.z, tries: g.tries || 0, left: Math.max(0, Math.round((g.at + 24 * 3600000 - Date.now()) / 60000)) }
  const out = {
    ...st,
    log: log.recent(40),
    events: log.events(60),
    goal: s.goal,
    places: s.places.slice(-8),
    offline: s.offline && s.offline.until > Date.now() ? s.offline : null,
    waitReason: controller.waitUntil > Date.now() ? controller.waitReason : null,
    graves: {
      pending: [s.lastDeath, ...(s.graves || [])].filter(g => g && !g.recovered && Date.now() - g.at < 24 * 3600000).map(grave),
      // só os que o servidor ainda lista (túmulo some em 24h)
      owner: (s.unreachable || []).filter(u => (s.activeGraves || []).some(g => Math.abs(g.x - u.x) <= 3 && Math.abs(g.z - u.z) <= 3)).map(u => ({ x: u.x, y: u.y, z: u.z, abandoned: !!u.abandoned }))
    },
    deaths: s.stats?.deaths || 0
  }
  if (!bot?.entity) return out
  const inv = {}
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
  out.inventory = Object.entries(inv).sort((a, b) => b[1] - a[1])
  out.yaw = bot.entity.yaw
  out.time = bot.time?.timeOfDay ?? null
  out.held = bot.heldItem?.name || null
  out.map = map(bot)
  out.entities = entities(bot)
  out.steps = controller.mission.steps.map(s => ({ id: s.id, desc: s.desc, done: (() => { try { return !s.repeat && s.done(bot, memory.state) } catch { return false } })(), current: s.id === controller.current }))
  return out
}

module.exports = { build }
