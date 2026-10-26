const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3, sleep, StepError, task } = require('./util')
const log = require('../log')

// Blocos de construção: o bot nunca quebra (evita destruir estruturas de outros jogadores).
const PROTECTED = /(_planks|_stairs|_slab|_fence|_fence_gate|_door|_trapdoor|_wall|glass|_pane|bricks|chest|barrel|shulker|_bed|_wool|_carpet|torch|lantern|furnace|smoker|crafting_table|bell|_table|lectern|composter|cauldron|anvil|sign|banner|rail|hopper|bookshelf|concrete|terracotta|ladder|scaffolding|farmland|hay_block|_sign|beacon|campfire|loom|stonecutter|grindstone|brewing_stand|enchanting_table|cartography_table|smithing_table|jukebox|note_block|dispenser|dropper|observer|piston|redstone|repeater|comparator|lever|button|pressure_plate|spawner|end_portal|nether_portal|_head|_skull|flower_pot|item_frame|painting|polished_|smooth_|chiseled_|cut_|quartz|prismarine|purpur|_tiles|_lamp|copper_)/

function setup (bot) {
  bot.loadPlugin(pathfinder)
  const mcData = bot.registry
  const m = new Movements(bot)
  m.allowParkour = true
  m.allowSprinting = true
  m.canOpenDoors = true
  m.allow1by1towers = true
  // água é território de afogado com tridente (−15 por acerto, mesmo com ferro): dá a volta por terra
  m.liquidCost = 25
  // pedregulho = casa e muro do complexo: o pathfinder não fura (mineração de túnel quebra pedra lisa, não usa isso)
  m.blocksCantBreak = new Set([...m.blocksCantBreak, ...mcData.blocksArray.filter(b => PROTECTED.test(b.name) || b.name === 'cobblestone').map(b => b.id)])
  // andaime só de terra/rocha descartável: pedregulho é material das paredes do procriador
  m.scafoldingBlocks = ['dirt', 'netherrack', 'granite', 'diorite', 'andesite', 'tuff'].map(n => mcData.itemsByName[n]?.id).filter(Boolean)
  bot.pathfinder.setMovements(m)
  bot.pathfinder.thinkTimeout = 8000
  bot.pathfinder.tickTimeout = 30
  return m
}

// Vai até o goal com detecção de travamento. Lança StepError('stuck'|'no_path'|'timeout').
async function goto (bot, goal, { timeout = 120000, signal } = {}) {
  signal = signal || task.getStore()?.signal
  if (signal?.aborted) throw new StepError('aborted')
  // reflexo de respirar (survival.js) tem prioridade: espera chegar à tona antes de navegar
  for (let i = 0; (bot.surfacing || bot.inCombat) && i < 60; i++) await sleep(500)
  const start = Date.now()
  let lastPos = bot.entity.position.clone()
  let lastMove = Date.now()
  let unstickTries = 0
  const watchdog = setInterval(() => {
    const p = bot.entity.position
    if (p.distanceTo(lastPos) > 1.5) { lastPos = p.clone(); lastMove = Date.now(); return }
    if (Date.now() - lastMove > 12000) {
      lastMove = Date.now()
      unstickTries++
      // Só destrava quando há caminho em andamento; não troca o goal (isso rejeita o goto).
      if (!bot.pathfinder.isMoving()) return
      log.warn('nav: travado, tentando destravar', unstickTries)
      jiggle(bot)
    }
  }, 2000)
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((resolve, reject) => {
        const t = setInterval(() => {
          if (signal?.aborted) { clearInterval(t); reject(new StepError('aborted')) }
          if (Date.now() - start > timeout) { clearInterval(t); reject(new StepError('timeout', 'navegação demorou demais')) }
          if (unstickTries > 3) { clearInterval(t); reject(new StepError('stuck', 'preso em ' + bot.entity.position.floored())) }
          if (!bot.entity || bot._client.ended) { clearInterval(t); reject(new StepError('aborted')) }
        }, 500)
      })
    ])
  } catch (e) {
    bot.pathfinder.setGoal(null)
    if (e instanceof StepError) throw e
    if (/no ?path|NoPath|goal was changed/i.test(e.message || e.name)) throw new StepError('no_path', e.message)
    throw new StepError('nav_error', e.message)
  } finally {
    clearInterval(watchdog)
  }
}

async function jiggle (bot) {
  const dirs = ['forward', 'back', 'left', 'right']
  const d = dirs[Math.floor(Math.random() * 4)]
  bot.setControlState('jump', true)
  bot.setControlState(d, true)
  await sleep(700)
  bot.clearControlStates()
}

const near = (pos, r = 2) => new goals.GoalNear(pos.x, pos.y, pos.z, r)
const nearXZ = (x, z, r = 3) => new goals.GoalNearXZ(x, z, r)

// Caminha ~dist blocos numa direção (graus). Usado para explorar.
async function wander (bot, dist = 64, angle = Math.random() * 360, opts = {}) {
  const a = angle * Math.PI / 180
  const p = bot.entity.position
  const x = Math.round(p.x + Math.cos(a) * dist)
  const z = Math.round(p.z + Math.sin(a) * dist)
  await goto(bot, nearXZ(x, z, 4), { timeout: Math.max(60000, dist * 1500), ...opts })
}

// Subterrâneo = sem luz do céu na cabeça.
// água funda também tem pouca luz do céu, mas não é subsolo (nadar resolve, não escavar escada)
const underground = (bot) => {
  const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
  if (!head || /water/.test(head.name)) return false
  return (head.skyLight ?? 15) < 8
}

// Sobe para a superfície cavando escada (1 para frente, 1 para cima) até ver o céu.
async function toSurface (bot, { signal } = {}) {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  let d = 0
  log.info(`nav: subindo para a superfície de y=${Math.floor(bot.entity.position.y)}`)
  for (let i = 0; i < 120 && underground(bot); i++) {
    if (signal?.aborted) throw new StepError('aborted')
    const p = bot.entity.position.floored()
    const [dx, dz] = dirs[d]
    const cells = [p.offset(0, 2, 0), p.offset(dx, 1, dz), p.offset(dx, 2, dz)]
    let blocked = false
    for (const c of cells) {
      const b = bot.blockAt(c)
      if (!b || /^(air|cave_air)$/.test(b.name)) continue
      if (/water|lava/.test(b.name) || PROTECTED.test(b.name) || b.name === 'bedrock') { blocked = true; break }
      await bot.tool.equipForBlock(b, {}).catch(() => {})
      await bot.dig(b).catch(() => { blocked = true })
    }
    if (blocked) { d = (d + 1) % 4; continue }
    // degrau precisa de chão
    const stepFloor = bot.blockAt(p.offset(dx, 0, dz))
    if (!stepFloor || stepFloor.boundingBox !== 'block') {
      const fill = bot.inventory.items().find(it => /^(dirt|cobblestone|cobbled_deepslate)$/.test(it.name))
      if (fill) { await bot.equip(fill, 'hand'); await bot.placeBlock(bot.blockAt(p.offset(dx, -1, dz)) || bot.blockAt(p), new Vec3(0, 1, 0)).catch(() => {}) }
    }
    await goto(bot, new goals.GoalBlock(p.x + dx, p.y + 1, p.z + dz), { timeout: 8000, signal }).catch(() => {})
    await sleep(100)
  }
  if (underground(bot)) throw new StepError('stuck', 'não consegui subir para a superfície')
  log.info('nav: na superfície')
}

// Plano B quando o pathfinder não acha caminho (túmulo numa caverna embaixo): cava uma escada 1x2 em
// direção ao alvo, um passo por vez. Túnel fechado também protege de flecha. Para em água/lava/construção.
const LIQUID = /water|lava|bubble_column/
async function digTo (bot, target, { signal, reach = 2.5 } = {}) {
  // lava ou água do lado: abrir o bloco inunda o túnel (afogou o bot assim)
  const lavaNear = (c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => /lava|water/.test(bot.blockAt(c.offset(x, y, z))?.name || ''))
  for (let i = 0; i < 250; i++) {
    if (signal?.aborted) throw new StepError('aborted')
    if (bot.entity.position.distanceTo(target) <= reach + 1) return true
    const p = bot.entity.position.floored()
    const ddx = target.x - p.x
    const ddz = target.z - p.z
    const alongX = Math.abs(ddx) >= Math.abs(ddz)
    const sx = Math.abs(ddx) < 1 && Math.abs(ddz) < 1 ? 0 : alongX ? Math.sign(ddx) : 0
    const sz = Math.abs(ddx) < 1 && Math.abs(ddz) < 1 ? 0 : alongX ? 0 : Math.sign(ddz)
    const dy = p.y > target.y + 0.5 ? -1 : p.y < target.y - 1 ? 1 : 0
    let cells
    if (sx === 0 && sz === 0) {
      if (dy !== -1) return false
      cells = [p.offset(0, -1, 0)] // logo acima do alvo: desce reto
      if (LIQUID.test(bot.blockAt(p.offset(0, -2, 0))?.name || '')) return false
    } else if (dy === -1) cells = [p.offset(sx, 1, sz), p.offset(sx, 0, sz), p.offset(sx, -1, sz)]
    else if (dy === 1) cells = [p.offset(0, 2, 0), p.offset(sx, 1, sz), p.offset(sx, 2, sz)]
    else cells = [p.offset(sx, 0, sz), p.offset(sx, 1, sz)]
    for (const c of cells) {
      const b = bot.blockAt(c)
      if (!b || b.boundingBox === 'empty') { if (b && LIQUID.test(b.name)) return false; continue }
      if (LIQUID.test(b.name) || PROTECTED.test(b.name) || b.name === 'bedrock' || lavaNear(c)) return false
      await bot.tool.equipForBlock(b, {}).catch(() => {})
      await bot.dig(b).catch(() => {})
    }
    const dest = p.offset(sx, dy, sz)
    if (dy === -1 && LIQUID.test(bot.blockAt(dest.offset(0, -1, 0))?.name || '')) return false
    await goto(bot, new goals.GoalBlock(dest.x, dest.y, dest.z), { timeout: 8000, signal }).catch(() => {})
    if (bot.entity.position.floored().equals(p)) await sleep(300)
  }
  return false
}

// Âncora da coleira: centro da casa (ou a base antiga). Exploração longe dela volta na direção dela.
const LEASH = 120
function anchor () {
  const s = require('../memory').state
  if (s.remote && s.remote.until > Date.now()) return { x: s.remote.x, z: s.remote.z } // casa ocupada por saqueadores
  if (s.home?.x !== undefined) return { x: s.home.x + 3, z: s.home.z + 3 }
  return s.base ? { x: s.base.x, z: s.base.z } : null
}
// ângulo (graus) pra explorar: aleatório perto de casa, apontando pra casa quando passou da coleira
function exploreAngle (bot) {
  const a = anchor()
  if (!a) return undefined
  const p = bot.entity.position
  if (Math.hypot(p.x - a.x, p.z - a.z) <= LEASH) return undefined
  return Math.atan2(a.z - p.z, a.x - p.x) * 180 / Math.PI + (Math.random() * 60 - 30)
}

module.exports = { setup, goto, near, nearXZ, wander, goals, Vec3, PROTECTED, underground, toSurface, digTo, anchor, exploreAngle, LEASH }
