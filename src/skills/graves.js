// Túmulos de plugins (cabeça/baú/barril no local da morte). Tenta abrir e pegar tudo; registra o que aprendeu.
const { sleep, withTimeout } = require('./util')
const nav = require('./nav')
const memory = require('../memory')
const log = require('../log')

// Só blocos típicos de túmulo; nunca baús/barris (podem ser de outros jogadores).
const GRAVE = /^(player_head|player_wall_head|skeleton_skull|skeleton_wall_skull)$/

// Mensagens do plugin com coordenadas do túmulo, ex.: "seu túmulo está em x: 10 y: 64 z: -3".
function watchMessages (bot) {
  bot.on('messagestr', (line) => {
    const l = line.replace(/§./g, '')
    if (!/t[uú]mulo|grave|morreu|died|death/i.test(l)) return
    const m = l.match(/(-?\d+)[,\s]+(?:y[:\s]*)?(-?\d+)[,\s]+(?:z[:\s]*)?(-?\d+)/i)
    if (!m) return
    // a mensagem do plugin chega antes do evento de morte: guarda e o agent.js usa ao registrar
    bot.graveMsg = { x: +m[1], y: +m[2], z: +m[3], at: Date.now() }
    const d = memory.state.lastDeath
    if (d && Date.now() - d.at < 60000) {
      Object.assign(d, { x: +m[1], y: +m[2], z: +m[3], fromPlugin: true })
      memory.save()
    }
  })
}

// Coleta o conteúdo de uma janela aberta com shift-clique.
async function takeAll (bot, win) {
  const slots = win.slots.slice(0, win.inventoryStart).map((it, i) => it && i).filter(i => i !== null && i !== undefined && i !== false)
  for (const s of slots) await bot.clickWindow(s, 0, 1).catch(() => {})
  bot.closeWindow(win)
}

// Neste servidor o túmulo é feito de entidades (armor_stand + interaction + text_display), não de bloco.
async function lootEntity (bot, pos) {
  const find = () => Object.values(bot.entities).filter(e => e.name === 'interaction' && e.position.distanceTo(pos) < 4)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0]
  let ent = find()
  if (!ent) return false
  const reach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(ent.position.offset(0, 0.5, 0)) < 2.8
  if (/water/.test(bot.blockAt(ent.position)?.name || '')) {
    // túmulo no fundo d'água: pathfinder nada mal; vai por cima e afunda reto até alcançar
    await nav.goto(bot, nav.nearXZ(ent.position.x, ent.position.z, 1), { timeout: 30000 }).catch(() => {})
    for (let i = 0; i < 6 && !reach(); i++) {
      while (bot.surfacing) await sleep(500)
      const until = Date.now() + 8000
      while (Date.now() < until && !reach() && !bot.surfacing) {
        const flat = ent.position.minus(bot.entity.position)
        await bot.lookAt(ent.position.offset(0, 0.5, 0), true)
        bot.setControlState('jump', false)
        bot.setControlState('forward', Math.hypot(flat.x, flat.z) > 0.6)
        await sleep(150)
      }
      bot.setControlState('forward', false)
    }
  } else {
    await nav.goto(bot, nav.near(ent.position, 2), { timeout: 30000 }).catch(() => {})
    // pathfinder não achou caminho (caverna embaixo, etc.): cava escada até lá
    if (!reach()) {
      log.info(`túmulo: sem caminho, cavando até ${ent.position.floored()}`)
      await nav.digTo(bot, ent.position, { reach: 2 }).catch(e => log.warn('cavar até túmulo:', e.message))
    }
  }
  for (const how of ['use', 'sneak', 'attack']) {
    ent = find()
    if (!ent) return true
    try {
      bot.setControlState('sneak', how === 'sneak')
      await bot.lookAt(ent.position.offset(0, 0.5, 0), true)
      let onOpen
      const opened = new Promise(resolve => { onOpen = resolve; bot.once('windowOpen', resolve) })
      if (how === 'attack') bot.attack(ent)
      else await bot.activateEntity(ent)
      const win = await withTimeout(opened, 3000).catch(() => null)
      bot.removeListener('windowOpen', onOpen) // sem isso acumulava listener a cada tentativa
      bot.setControlState('sneak', false)
      if (win) { await takeAll(bot, win); memory.knowledge('Mecânicas', `túmulo (entidade interaction) abre com ${how}; itens retirados com shift-clique`); return true }
      await sleep(1000)
      if (!find()) { memory.knowledge('Mecânicas', `túmulo (entidade interaction) devolve itens com ${how}`); return true }
    } catch (e) { log.warn('túmulo', e.message) } finally { bot.setControlState('sneak', false) }
  }
  return false
}

async function loot (bot, pos) {
  const block = bot.findBlock({ point: pos, matching: bot.registry.blocksArray.filter(b => GRAVE.test(b.name)).map(b => b.id), maxDistance: 6 })
  if (!block) return lootEntity(bot, pos)
  await nav.goto(bot, nav.near(block.position, 2), { timeout: 20000 }).catch(() => {})
  for (const sneak of [false, true]) {
    try {
      bot.setControlState('sneak', sneak)
      let onOpen
      const opened = new Promise(resolve => { onOpen = resolve; bot.once('windowOpen', resolve) })
      await bot.activateBlock(block)
      const win = await withTimeout(opened, 3000).catch(() => null)
      bot.removeListener('windowOpen', onOpen) // sem isso acumulava listener a cada tentativa
      bot.setControlState('sneak', false)
      if (win) {
        const slots = win.slots.slice(0, win.inventoryStart).map((it, i) => it && i).filter(i => i !== null && i !== undefined && i !== false)
        for (const s of slots) await bot.clickWindow(s, 0, 1).catch(() => {})
        bot.closeWindow(win)
        memory.knowledge('Mecânicas', `túmulo (${block.name}) abre com ${sneak ? 'shift+' : ''}clique direito; itens retirados com shift-clique`)
        return true
      }
      await sleep(800)
      const gone = !GRAVE.test(bot.blockAt(block.position)?.name || '')
      if (gone) { memory.knowledge('Mecânicas', `túmulo (${block.name}) devolve itens ao ${sneak ? 'shift+' : ''}clicar`); return true }
    } catch (e) { log.warn('túmulo', e.message) } finally { bot.setControlState('sneak', false) }
  }
  return false
}

module.exports = { loot, watchMessages }
