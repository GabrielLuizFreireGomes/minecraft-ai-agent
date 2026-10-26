const collectBlock = require('mineflayer-collectblock').plugin
const toolPlugin = require('mineflayer-tool').plugin
const { Vec3, sleep, count, withTimeout, StepError, LOGS } = require('./util')
const nav = require('./nav')
const log = require('../log')

function setup (bot) {
  bot.loadPlugin(toolPlugin)
  bot.loadPlugin(collectBlock)
}

// Só árvores naturais: tronco com folhas por perto e sem blocos de construção ao redor.
function isNaturalTree (bot, block) {
  let leaves = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = 0; dy <= 4; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(block.position.offset(dx, dy, dz))
        if (!b) continue
        if (b.name.endsWith('_leaves') || b.name.endsWith('_wart_block')) leaves++
        if (nav.PROTECTED.test(b.name)) return false
      }
    }
  }
  return leaves >= 3
}

// Coleta até ter `target` itens que casam com `itemTest`, quebrando blocos que casam com `blockTest`.
async function gather (bot, { blockTest, itemTest, target, maxDistance = 48, natural, signal, explore = true, label = 'recurso' }) {
  const ids = bot.registry.blocksArray.filter(b => blockTest.test(b.name)).map(b => b.id)
  let fails = 0
  let explores = 0
  while (count(bot, itemTest) < target) {
    if (signal?.aborted) throw new StepError('aborted')
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: 40 })
    const blocks = positions.map(p => bot.blockAt(p))
      .filter(b => b && (!natural || natural(bot, b)))
      .filter(b => b.position.y > bot.entity.position.y - 12)
    if (!blocks.length) {
      if (!explore || explores >= 6) throw new StepError('not_found', `nenhum ${label} por perto`)
      explores++
      log.info(`gather: sem ${label} visível, explorando (${explores})`)
      // coleira: longe da casa, explora na direção dela (antes foi parar a 1000 blocos e morreu lá)
      await nav.wander(bot, 48 + explores * 16, nav.exploreAngle(bot), { signal }).catch(e => { if (e.code === 'aborted') throw e })
      continue
    }
    const before = count(bot, itemTest)
    try {
      // mochila cheia: o collectblock tenta guardar num baú que não existe ("no defined chest locations")
      if (bot.inventory.emptySlotCount() < 2) await require('./storage').makeRoom(bot, 4)
      await withTimeout(bot.collectBlock.collect(blocks[0], { ignoreNoPath: true }), 45000, 'collect_timeout')
    } catch (e) {
      bot.pathfinder.setGoal(null)
      log.warn('gather: falha coletando', e.message)
    }
    await sleep(300)
    if (count(bot, itemTest) > before) { fails = 0; continue }
    if (++fails >= 6) throw new StepError('no_progress', `sem progresso coletando ${label}`)
  }
}

const logs = (bot, target, signal) => gather(bot, { blockTest: LOGS, itemTest: LOGS, target, natural: isNaturalTree, signal, label: 'árvore' })

const COBBLE = /^(cobblestone|cobbled_deepslate)$/
const MINEABLE = /^(stone|deepslate|andesite|diorite|granite|tuff|dirt|gravel|coarse_dirt|.*_ore|calcite|cobblestone|cobbled_deepslate|grass_block|clay|sand|red_sand|sandstone|red_sandstone|podzol|mycelium|mud|rooted_dirt|moss_block|snow_block|dripstone_block|.*_leaves|terracotta|(white|orange|yellow|red|brown|light_gray)_terracotta|smooth_basalt|amethyst_block)$/
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]

// Pedregulho por túnel 1x2 (determinístico, sem pathfinder entre blocos): escada até a pedra, depois reto.
async function stone (bot, target, signal) {
  let dir = DIRS[Math.floor(Math.random() * 4)]
  let turns = 0
  let steps = 0
  let moved = 0
  // dentro d'água o túnel não abre (tudo "líquido"): primeiro sai pra terra firme
  if (/water/.test(bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name || '') || /water/.test(bot.blockAt(bot.entity.position)?.name || '')) {
    const solid = bot.registry.blocksArray.filter(b => b.boundingBox === 'block' && !/leaves|ice/.test(b.name)).map(b => b.id)
    const land = bot.findBlock({ matching: solid, maxDistance: 32, useExtraInfo: b => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' && bot.blockAt(b.position.offset(0, 2, 0))?.name === 'air' })
    if (land) await nav.goto(bot, nav.near(land.position.offset(0, 1, 0), 1), { timeout: 40000, signal }).catch(e => { if (e.code === 'aborted') throw e })
  }
  let lastCobble = count(bot, COBBLE)
  let idle = 0
  let relocations = 0
  while (count(bot, COBBLE) < target) {
    if (signal?.aborted) throw new StepError('aborted')
    if (++steps > target * 2 + 60) throw new StepError('no_progress', 'túnel não rendeu pedra')
    // 25 passos sem pedra nova (ilha de terra, morro no ar): muda de lugar e recomeça o túnel
    if (count(bot, COBBLE) > lastCobble) { lastCobble = count(bot, COBBLE); idle = 0 } else if (++idle > 25 && relocations < 3) {
      relocations++
      idle = 0
      await nav.wander(bot, 24, undefined, { signal }).catch(e => { if (e.code === 'aborted') throw e })
      continue
    }
    const p = bot.entity.position.floored()
    const floor = bot.blockAt(p.offset(0, -1, 0))
    const inStone = floor && /^(stone|deepslate|tuff|andesite|diorite|granite)$/.test(floor.name)
    // na pedra: túnel reto; fora dela: escada descendo
    const dy = inStone || p.y < -50 ? 0 : -1
    const cells = [p.offset(dir[0], dy, dir[1]), p.offset(dir[0], dy + 1, dir[1])]
    // caverna à frente (muito ar logo depois da parede): vira. Esqueleto de caverna matou o bot minerando.
    const ahead = p.offset(dir[0] * 2, dy, dir[1] * 2)
    let air = 0
    for (let x = -1; x <= 1; x++) for (let y = 0; y <= 2; y++) for (let z = -1; z <= 1; z++) if (/^(air|cave_air)$/.test(bot.blockAt(ahead.offset(x, y, z))?.name || '')) air++
    if (air >= 10 && p.y < 60) {
      if (++turns > 6) throw new StepError('blocked', 'cercado de caverna')
      dir = DIRS[(DIRS.indexOf(dir) + 1 + Math.floor(Math.random() * 2) * 2) % 4]
      continue
    }
    if (dy < 0) cells.push(p.offset(dir[0], 1, dir[1]))
    let blocked = false
    for (const pos of cells) {
      // líquido do lado ou na frente: vira 90° em vez de abrir
      for (const n of [pos, pos.offset(dir[0], 0, dir[1]), pos.offset(0, 1, 0)]) {
        const nb = bot.blockAt(n)
        if (nb && /water|lava/.test(nb.name)) blocked = true
      }
      const b = bot.blockAt(pos)
      // grama alta, flor, neve fina: sem colisão, passa por cima (antes travava o túnel na superfície)
      if (!b || b.boundingBox === 'empty' || /^(air|cave_air)$/.test(b.name)) continue
      if (!MINEABLE.test(b.name) || nav.PROTECTED.test(b.name)) blocked = true
      // pedregulho dentro da área do complexo é muro/casa: não cava
      const hm = require('../memory').state.home
      if (b.name === 'cobblestone' && hm?.x !== undefined && pos.x >= hm.x - 4 && pos.x <= hm.x + 23 && pos.z >= hm.z - 5 && pos.z <= hm.z + 12) blocked = true
      if (blocked) break
      await bot.tool.equipForBlock(b, {}).catch(() => {})
      await bot.dig(b).catch(() => { blocked = true })
    }
    if (blocked) {
      if (++turns > 6) {
        // cercado (construção/água/brejo): muda de lugar até 3 vezes, cada vez mais longe
        if (moved < 3) { moved++; turns = 0; await nav.wander(bot, 24 + moved * 24, undefined, { signal }).catch(e => { if (e.code === 'aborted') throw e }); continue }
        throw new StepError('blocked', 'túnel bloqueado por líquido/construção')
      }
      dir = DIRS[(DIRS.indexOf(dir) + 1 + Math.floor(Math.random() * 2) * 2) % 4]
      continue
    }
    const next = p.offset(dir[0], dy, dir[1])
    // tocha no túnel escuro a cada ~10 passos (mob não nasce atrás)
    if (steps % 10 === 0 && (bot.blockAt(p.offset(0, 1, 0))?.light ?? 15) < 8) {
      const torch = bot.inventory.items().find(i => i.name === 'torch')
      const floorB = bot.blockAt(p.offset(0, -1, 0))
      if (torch && floorB && floorB.boundingBox === 'block' && bot.blockAt(p)?.name !== 'torch') {
        await bot.equip(torch, 'hand').catch(() => {})
        await bot.placeBlock(floorB, new Vec3(0, 1, 0)).catch(() => {})
      }
    }
    await nav.goto(bot, new nav.goals.GoalBlock(next.x, next.y, next.z), { timeout: 8000, signal }).catch(() => {})
    await sleep(120)
  }
}

module.exports = { setup, gather, logs, stone, isNaturalTree }
