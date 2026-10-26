const { fixResourcePack, fixPlayerInput, fixMovementFlags } = require('./compat')
const mineflayer = require('mineflayer')
const auth = require('./auth')
const graves = require('./skills/graves')
const config = require('./config')
const memory = require('./memory')
const log = require('./log')
const chat = require('./chat')
const nav = require('./skills/nav')
const gather = require('./skills/gather')
const survival = require('./skills/survival')

// Cria uma conexão. Resolve com {bot, ended} onde ended resolve com o motivo da desconexão.
function connect (controller) {
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: 'offline',
    version: config.version,
    hideErrors: false,
    checkTimeoutInterval: 60000
  })
  let loggedIn = false
  let ended
  const endedP = new Promise(resolve => { ended = resolve })
  let kickReason = ''
  // sair de propósito com motivo (ex.: noite sem cama) — o index.js decide quando voltar
  bot.quitWith = (reason) => { kickReason = reason; bot.quit() }
  const deathTimes = []
  fixResourcePack(bot._client)
  require('./server-info').attach(bot)
  bot.once('login', () => require('./stock').attach(bot))
  bot.once('login', () => fixPlayerInput(bot))
  fixMovementFlags(bot)
  auth.attach(bot._client, (fatal) => { kickReason = `fatal:${fatal}`; bot.quit() })

  bot.once('login', () => log.info(`conectado em ${config.host} como ${bot.username}`))

  bot.on('messagestr', (line) => {
    const l = line.replace(/§./g, '')
    if (!loggedIn && /\/login/i.test(l) && !/\/register/i.test(l)) {
      if (!config.password) { log.error('servidor pede /login e MC_PASSWORD está vazio no .env'); return }
      loggedIn = true
      setTimeout(() => bot.chat(`/login ${config.password}`), 1500)
      log.info('auth: /login enviado')
    } else if (/\/register/i.test(l) && !loggedIn) {
      log.error('servidor pediu /register: conta não registrada; não registro sozinho')
    } else if (/logad|logged in|autenticad|bem[- ]vindo/i.test(l) && loggedIn) {
      log.info('auth: ok')
    }
  })

  bot.once('spawn', () => {
    nav.setup(bot)
    gather.setup(bot)
    survival.attach(bot)
    chat.attach(bot, controller)
    graves.watchMessages(bot)
    // Jogador chegou perto: sai e volta depois (o index espera e reconecta até a área estar livre).
    const watch = setInterval(() => {
      const p = Object.values(bot.players).find(pl => pl.username !== bot.username && pl.entity &&
        pl.entity.position.distanceTo(bot.entity.position) < config.avoidRadius)
      if (!p) return
      clearInterval(watch)
      kickReason = `player_near:${p.username}`
      log.info(`jogador ${p.username} a ${Math.round(p.entity.position.distanceTo(bot.entity.position))} blocos: saindo`)
      memory.history(`saí do servidor porque ${p.username} chegou perto`)
      bot.quit()
    }, 1000)
    bot.once('end', () => clearInterval(watch))
    memory.state.stats.sessions++
    memory.save()
    log.info(`spawn em ${bot.entity.position.floored()} (${bot.game.dimension}) vida ${bot.health}`)
    setTimeout(() => controller.attach(bot), 4000)
    const snap = setInterval(() => memory.snapshot(bot, controller), 30000)
    bot.once('end', () => clearInterval(snap))
  })

  // Diagnóstico de morte (26.2): pacotes reais de morte e mensagens do servidor sobre morte/túmulo.
  bot._client.on('death_combat_event', (d) => log.warn('pacote morte:', JSON.stringify(d).slice(0, 300)))
  bot._client.on('player_combat_kill', (d) => log.warn('pacote morte:', JSON.stringify(d).slice(0, 300)))
  bot._client.on('respawn', () => log.info('pacote respawn'))
  bot.on('messagestr', (l, pos) => { if (pos !== 'chat' && /morr|died|slain|t[uú]mulo|grave|killed|morte|drown|blown|fell|lava|burn|flames|shot|suffocat|starv|hit the ground|wither|squash|pricked|froze|impaled|fireball|magic/i.test(l)) log.info('servidor:', l.replace(/§./g, '').slice(0, 200)) })

  // diagnóstico de combate: cada dano com quem estava perto
  let lastHp = null
  bot.on('health', () => {
    if (lastHp !== null && bot.health < lastHp - 0.5 && bot.entity) {
      const near = Object.values(bot.entities).filter(e => e !== bot.entity && e.type !== 'object' && e.position.distanceTo(bot.entity.position) < 6).map(e => `${e.name}@${e.position.distanceTo(bot.entity.position).toFixed(1)}`).slice(0, 4)
      // efeitos ativos e fogo: dano contínuo sem mob por perto (−4,3/s) precisa de causa
      const fx = Object.values(bot.entity.effects || {}).map(e => bot.registry.effects?.[e.id]?.name || e.id).join(',')
      const fire = (bot.entity.metadata?.[0] & 0x01) ? ' em chamas' : ''
      const feet = bot.blockAt(bot.entity.position)?.name
      log.info(`dano: -${(lastHp - bot.health).toFixed(1)} (vida ${bot.health.toFixed(1)})${fire}${fx ? ' efeitos: ' + fx : ''} pé: ${feet} perto: ${near.join(' ') || 'ninguém'}`)
    }
    lastHp = bot.health
  })

  // túmulo com isto vale buscar mesmo longe; ferro/pedra o bot refaz em ~15 min com segurança
  const VALUABLE_GRAVE = /diamond|netherite|emerald|elytra|totem|enchanted|trident|beacon|shulker/
  bot.on('death', () => {
    log.warn(`evento death: vida=${bot.health} alive=${bot.isAlive}`)
    deathTimes.push(Date.now())
    while (deathTimes.length && deathTimes[0] < Date.now() - 120000) deathTimes.shift()
    if (deathTimes.length >= 3) {
      memory.error('laço de mortes', '3 mortes em 2 min — agente saiu e parou para não perder mais itens')
      kickReason = 'fatal:death_loop'
      bot.quit()
      return
    }
    const p = bot.entity.position
    memory.state.stats.deaths++
    memory.state.gravesDirty = true
    // morreu indo buscar este túmulo: 2 vezes e ele vira perigoso (o dono pega)
    const target = memory.state.lastDeath
    if (target && !target.recovered && Math.hypot(p.x - target.x, p.z - target.z) < 40) {
      target.deathsNear = (target.deathsNear || 0) + 1
      if (target.deathsNear >= 2) {
        target.recovered = true
        target.unreachable = true
        memory.state.unreachable = [...(memory.state.unreachable || []), { x: target.x, y: target.y, z: target.z }]
        memory.history(`túmulo em ${target.x} ${target.y} ${target.z} é perigoso (morri 2x indo buscar): deixei pro dono`)
        log.warn(`túmulo perigoso em ${target.x} ${target.y} ${target.z}: desisti`)
      }
    }
    // túmulo anterior ainda não resgatado vai para a fila (cada morte cria um túmulo novo, 24h cada)
    const prev = memory.state.lastDeath
    if (prev && !prev.recovered && Date.now() - prev.at < 24 * 3600000) (memory.state.graves = memory.state.graves || []).push(prev)
    const g = bot.graveMsg && Date.now() - bot.graveMsg.at < 5000 ? bot.graveMsg : null
    memory.state.lastDeath = { x: g ? g.x : Math.round(p.x), y: g ? g.y : Math.round(p.y), z: g ? g.z : Math.round(p.z), fromPlugin: !!g, dim: bot.game.dimension, at: Date.now(), items: [...new Set(bot.lastInv || [])].slice(0, 60), valuable: (bot.lastInv || []).some(n => VALUABLE_GRAVE.test(n)) }
    memory.save(true)
    memory.history(`morri em ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`)
    controller.interrupt('morte')
  })

  bot.on('kicked', (reason) => {
    kickReason = typeof reason === 'string' ? reason : JSON.stringify(reason)
    log.warn('kick:', kickReason.slice(0, 200))
  })
  bot.on('error', (e) => log.error('bot error:', e.message))
  bot.on('end', (why) => {
    log.warn('desconectado:', why)
    controller.detach()
    memory.snapshot(bot, controller, true)
    ended(kickReason || why || 'end')
  })
  return { bot, ended: endedP }
}

module.exports = { connect }
