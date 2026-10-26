const { sleep, count, FOODS, StepError, withTimeout, Vec3 } = require('./util')
const nav = require('./nav')
const log = require('../log')

const HOSTILE = new Set(['vindicator', 'evoker', 'ravager', 'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider', 'creeper', 'witch', 'slime', 'pillager', 'vindicator', 'zombie_villager', 'silverfish', 'phantom', 'bogged', 'breeze'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'breeze'])
const PREY = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const WEAPON = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_sword', 'wooden_axe']
const ARMOR = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ }
const ARMOR_RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite']

// nada a perder (pelado, mochila quase vazia): sair do servidor só prende ele em loop com vida baixa
// (vida não regenera desconectado); melhor correr pra casa e, se morrer, renascer na cama com vida cheia
// cabeça dentro de bloco sólido (areia/cascalho caiu): sair do servidor agora = voltar enterrado e morrer
const buried = (bot) => { const h = bot.entity && bot.blockAt(bot.entity.position.offset(0, 1.6, 0)); return !!(h && h.boundingBox === 'block') }
const remoteOn = () => { const r = require('../memory').state.remote; return !!(r && r.until > Date.now()) }

function nothingToLose (bot) {
  const naked = ![5, 6, 7, 8].some(s => bot.inventory.slots[s])
  return naked && bot.inventory.items().filter(i => !/dirt|cobblestone|stick|seeds|sapling|flower|petals|leaf/.test(i.name)).length < 4
}

// dentro da casa (porta fechada): lugar seguro, não precisa fugir do servidor
function inHouse (bot) {
  const h = require('../memory').state.home
  if (!h?.built || !bot.entity) return false
  const p = bot.entity.position
  return p.x >= h.x && p.x < h.x + 7 && p.z >= h.z && p.z < h.z + 7 && Math.abs(p.y - (h.y + 1)) < 2
}

const foodCount = (bot) => bot.inventory.items().filter(i => FOODS.has(i.name)).reduce((n, i) => n + i.count, 0)

// Reflexos locais (sem IA): comer, equipar armadura, revidar ataques próximos.
function attach (bot) {
  let eating = false
  let fighting = false

  async function eat () {
    // ferido: come até encher (regeneração só com fome ≥ 18)
    if (eating || (bot.food > 14 && !(bot.health < 20 && bot.food < 20))) return
    const food = bot.inventory.items().filter(i => FOODS.has(i.name))
      .sort((a, b) => (bot.registry.foodsByName[b.name]?.foodPoints || 0) - (bot.registry.foodsByName[a.name]?.foodPoints || 0))[0]
    if (!food) return
    eating = true
    try {
      await bot.equip(food, 'hand')
      await withTimeout(bot.consume(), 6000)
    } catch (e) { log.warn('eat', e.message) } finally { eating = false }
  }

  async function equipArmor () {
    for (const [slot, re] of Object.entries(ARMOR)) {
      const cur = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      const best = bot.inventory.items().filter(i => re.test(i.name))
        .sort((a, b) => ARMOR_RANK.indexOf(b.name.split('_')[0]) - ARMOR_RANK.indexOf(a.name.split('_')[0]))[0]
      if (best && (!cur || ARMOR_RANK.indexOf(best.name.split('_')[0]) > ARMOR_RANK.indexOf(cur.name.split('_')[0]))) {
        await bot.equip(best, slot).catch(() => {})
      }
    }
  }

  async function defend () {
    if (fighting || eating || bot.inCombat) return
    const mob = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 4.5)
    if (!mob) return
    if (mob.name === 'creeper') return // creeper: −24 mesmo de ferro; nunca bater, o reflexo abaixo foge
    fighting = true
    try {
      const w = WEAPON.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean)
      if (w && bot.heldItem?.name !== w.name) await bot.equip(w, 'hand')
      await bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true)
      bot.attack(mob)
    } catch (e) { /* alvo sumiu */ } finally {
      setTimeout(() => { fighting = false }, 600)
    }
  }

  // Ar acabando debaixo d'água: segura pulo para nadar até a tona (morreu afogado 2x em 2026-10-23).
  // Cronômetro de tempo submerso como reserva caso oxygenLevel não atualize. Depois de subir, fica
  // boiando até o ar encher (senão o pathfinder mergulha de novo com o ar pela metade).
  let surfacing = false
  let digging = false
  let riseFrom = { y: 0, at: 0 }
  let wetSince = 0
  function breathe () {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0))
    const underwater = head && /water|bubble_column|kelp|seagrass/.test(head.name)
    wetSince = underwater ? (wetSince || Date.now()) : 0
    const low = underwater && (bot.oxygenLevel < 7 || Date.now() - wetSince > 11000)
    const refilling = surfacing && (underwater || bot.oxygenLevel < 19)
    if (low || refilling) {
      if (!surfacing) { surfacing = true; riseFrom = { y: bot.entity.position.y, at: Date.now() }; log.warn(`sem ar: subindo à tona (ar ${bot.oxygenLevel})`); bot.pathfinder?.setGoal(null) }
      bot.setControlState('jump', true)
      // teto sólido em cima (túnel/caverna inundada): pulo não sobe; cava o bloco acima da cabeça
      if (underwater && Date.now() - riseFrom.at > 3000) {
        if (bot.entity.position.y < riseFrom.y + 0.5) {
          const above = bot.blockAt(bot.entity.position.offset(0, 2.2, 0))
          if (above && above.boundingBox === 'block' && bot.canDigBlock(above) && !digging) {
            digging = true
            log.warn(`sem ar: teto de ${above.name}, cavando pra cima`)
            bot.tool.equipForBlock(above, {}).catch(() => {}).then(() => bot.dig(above, true)).catch(() => {}).finally(() => { digging = false })
          }
        }
        riseFrom = { y: bot.entity.position.y, at: Date.now() }
      }
    } else if (surfacing) {
      surfacing = false
      bot.setControlState('jump', false)
    }
    bot.surfacing = surfacing
  }

  // Atirador (esqueleto etc.) acerta de longe e o defend() só reage a 4,5 blocos: morreu levando 30s de
  // flechada parado numa caverna. Tomou dano com atirador perto → larga a tarefa, vai lá e mata;
  // com pouca vida, foge na direção oposta.
  let lastHp = bot.health
  let engaged = false
  let blocking = false
  async function engage (mob) {
    engaged = true
    bot.inCombat = true
    log.warn(`combate: ${mob.name} a ${mob.position.distanceTo(bot.entity.position).toFixed(0)} blocos me acertando`)
    const start = Date.now()
    try {
      const w = WEAPON.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean)
      if (w && bot.heldItem?.name !== w.name) await bot.equip(w, 'hand').catch(() => {})
      while (mob.isValid && Date.now() - start < 25000) {
        // sem armadura cada flecha tira 7-9: foge cedo
        const armored = [5, 6, 7, 8].some(s => bot.inventory.slots[s])
        if (bot.health <= (armored ? 7 : 12)) {
          const away = bot.entity.position.minus(mob.position)
          const len = Math.hypot(away.x, away.z) || 1
          const p = bot.entity.position
          bot.pathfinder.setGoal(new nav.goals.GoalNearXZ(p.x + away.x / len * 20, p.z + away.z / len * 20, 3))
          log.warn('combate: vida baixa, fugindo')
          await sleep(6000)
          break
        }
        const d = mob.position.distanceTo(bot.entity.position)
        // escudo na mão esquerda: levantado enquanto chega perto (bloqueia flecha), abaixado pra bater
        const shield = bot.inventory.slots[45]?.name === 'shield'
        if (d > 3) {
          if (shield && !blocking) { bot.activateItem(true); blocking = true }
          bot.pathfinder.setGoal(new nav.goals.GoalFollow(mob, 2), true)
        } else {
          if (blocking) { bot.deactivateItem(); blocking = false }
          bot.pathfinder.setGoal(null)
          await bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true)
          bot.attack(mob)
        }
        await sleep(350)
      }
    } catch (e) { /* alvo sumiu */ } finally {
      if (blocking) { bot.deactivateItem(); blocking = false }
      bot.pathfinder.setGoal(null)
      engaged = false
      bot.inCombat = false
      if (!mob.isValid) log.info(`combate: ${mob.name} morto`)
    }
  }
  async function flee (mob, why) {
    engaged = true
    bot.inCombat = true
    try {
      const away = bot.entity.position.minus(mob.position)
      const len = Math.hypot(away.x, away.z) || 1
      const p = bot.entity.position
      log.warn(`combate: fugindo de ${why}`)
      bot.pathfinder.setGoal(new nav.goals.GoalNearXZ(p.x + away.x / len * 28, p.z + away.z / len * 28, 4))
      await sleep(9000)
    } finally {
      bot.pathfinder.setGoal(null)
      engaged = false
      bot.inCombat = false
    }
  }
  // sufocando (areia/cascalho caiu na cabeça cavando): cava o bloco da cabeça na hora
  async function unbury () {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0))
    if (digging || !head || head.boundingBox !== 'block' || !bot.canDigBlock(head)) return false
    digging = true
    log.warn(`sufocando em ${head.name}: cavando`)
    try { await bot.tool.equipForBlock(head, {}).catch(() => {}); await bot.dig(head, true) } catch {} finally { digging = false }
    return true
  }
  bot.fight = (mob) => engaged ? Promise.resolve() : engage(mob)
  bot.on('health', () => {
    const hurt = bot.health < lastHp - 0.5
    lastHp = bot.health
    if (hurt) unbury()
    if (!hurt || !bot.entity) return
    if (inHouse(bot) && Date.now() - lastHouseExit > 3000 && houseCheckNow()) return
    // emergência vale mesmo no meio de uma fuga/luta (antes era ignorada e o husk matou fugindo)
    const danger = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 16)
    if (danger && bot.health < 10 && bot.quitWith && !buried(bot) && !nothingToLose(bot)) { log.warn(`fuga: saindo 2 min (${danger.name} perto, vida ${Math.round(bot.health)})`); bot.quitWith('escape:120000'); return }
    if (engaged) return
    // sem armadura qualquer mob daqui mata em 3 golpes (husk −7,8): foge em vez de bater
    const naked = ![5, 6, 7, 8].some(slot => bot.inventory.slots[slot])
    const melee = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 8)
    // pelado, ferido e com mob colado: correr não adianta (mesma velocidade + sangramento −0,9/s do RPG).
    // Sai do servidor 2 min: desconectado ninguém ataca; volta com o mob longe ou queimado.
    // qualquer armadura: vida < 10 com mob até 16 blocos → sai 2 min (esqueleto ganhava a troca mesmo contra ferro+escudo)
    const anyMob = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 16)
    if (anyMob && bot.health < 10 && bot.quitWith && !buried(bot) && !nothingToLose(bot)) { log.warn(`fuga: saindo 2 min (${anyMob.name} perto, vida ${Math.round(bot.health)})`); bot.quitWith('escape:120000'); return }
    if (naked && melee && bot.health < 12 && bot.quitWith && !buried(bot) && !nothingToLose(bot)) { log.warn(`fuga: saindo 2 min (${melee.name} perto, vida ${Math.round(bot.health)})`); bot.quitWith('escape:120000'); return }
    if (naked && melee) { flee(melee, `${melee.name} (sem armadura)`); return }
    // afogado com tridente: na água ele ganha sempre — foge pra longe da água em vez de lutar
    const drowned = bot.nearestEntity(e => (e.name === 'drowned' || e.name === 'trident') && e.position.distanceTo(bot.entity.position) < 24)
    if (drowned) { flee(drowned, 'afogado/tridente'); return }
    const shooter = bot.nearestEntity(e => RANGED.has(e.name) && e.position.distanceTo(bot.entity.position) < 24)
    if (shooter) engage(shooter)
  })

  // renasceu/entrou sem armadura com mob perto (cama fora de casa, noite): sai na hora, antes do 1º golpe
  // renasceu na cama com mob dentro de casa: sai pela porta JÁ (husk mata em 3 golpes) e marca infestada
  let lastHouseExit = 0
  const houseCheckNow = () => {
    const st = require('../memory').state
    const h = st.home
    if (!bot.entity || !h?.built || !inHouse(bot)) return false
    const inside = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.x >= h.x - 0.3 && e.position.x < h.x + 7.3 && e.position.z >= h.z - 0.3 && e.position.z < h.z + 7.3 && Math.abs(e.position.y - (h.y + 1)) < 3)
    if (!inside) return false
    h.infested = Date.now()
    // cama dentro da casa infestada = renascer no meio dos mobs pra sempre: quebra (1 clique) e renasce no spawn do mundo
    if (h.bed) {
      const bed = bot.blockAt(new Vec3(h.bed.x, h.bed.y, h.bed.z))
      if (bed && /_bed$/.test(bed.name) && bot.entity.position.distanceTo(bed.position) < 4.5) {
        bot.dig(bed, true).catch(() => {})
        log.warn('casa infestada: quebrei a cama pra não renascer no meio dos mobs')
        h.bed = null
        require('../memory').history('casa infestada: quebrei a cama (renascimento volta pro spawn do mundo até limpar)')
      }
    }
    log.warn(`casa infestada: ${inside.name} lá dentro, saindo pela porta`)
    bot.inCombat = true
    bot.setControlState('sprint', true)
    bot.pathfinder.setGoal(new nav.goals.GoalBlock(h.x + 3, h.y + 1, h.z + 10))
    lastHouseExit = Date.now()
    setTimeout(() => { bot.inCombat = false; bot.setControlState('sprint', false) }, 8000)
    return true
  }
  // renasceu fora de casa no meio de mob (ponto de renascimento errado): /home base na hora
  let lastHomeTp = 0
  const tpHome = () => {
    const h = require('../memory').state.home
    if (!bot.entity || !h?.built || inHouse(bot) || remoteOn() || Date.now() - lastHomeTp < 20000) return
    const mob = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 10)
    if (!mob) return
    lastHomeTp = Date.now()
    log.warn(`fuga: ${mob.name} colado no renascimento, /home base`)
    bot.chat('/home base')
  }
  bot.on('spawn', () => { for (const ms of [150, 800, 1600]) setTimeout(tpHome, ms) })
  for (const ms of [800, 1600]) setTimeout(tpHome, ms)
  // entidades chegam alguns ticks depois de renascer: confere em 0,3 s, 1 s e 2 s
  const houseCheck = () => { for (const ms of [300, 1000, 2000]) setTimeout(() => { if (Date.now() - lastHouseExit > 3000) houseCheckNow() }, ms) }
  bot.on('spawn', houseCheck)
  // noite e sem casa utilizável (cama quebrada / casa infestada): sai já ao entrar, antes do 1º golpe
  const nightCheck = () => {
    const h = require('../memory').state.home
    const t = bot.time?.timeOfDay ?? 0
    const night = t >= 12542 && t <= 23460
    if (!night || !bot.quitWith || buried(bot) || inHouse(bot)) return
    if (h?.bed && !h.infested) return
    const ms = Math.round(((23460 - t + 24000) % 24000) / 20 * 1000) + 15000
    log.warn(`noite sem casa segura: saindo até amanhecer (${Math.round(ms / 60000)} min)`)
    bot.quitWith(`night_off:${ms}`)
  }
  // a hora chega do servidor alguns ticks depois: confere de novo
  bot.on('spawn', () => { setTimeout(nightCheck, 50); setTimeout(nightCheck, 1200) })
  setTimeout(nightCheck, 50); setTimeout(nightCheck, 1200)
  houseCheck()
  const spawnCheck = () => setTimeout(() => {
    if (!bot.entity || !bot.quitWith) return
    const naked = ![5, 6, 7, 8].some(slot => bot.inventory.slots[slot])
    // flecha só conta voando (flecha cravada no chão fica lá parada e fazia ele sair toda vez)
    const flying = (e) => e.name === 'arrow' && e.velocity && Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z) > 0.1
    const mob = bot.nearestEntity(e => (HOSTILE.has(e.name) || flying(e)) && e.position.distanceTo(bot.entity.position) < 24)
    // renasceu na cama com mob trancado dentro de casa: sai pela porta e fecha (mob fica preso lá)
    const h = require('../memory').state.home
    if (naked && inHouse(bot) && h?.built) {
      const inside = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.x >= h.x && e.position.x < h.x + 7 && e.position.z >= h.z && e.position.z < h.z + 7)
      if (inside) {
        log.warn(`fuga: ${inside.name} dentro de casa, saindo pela porta`)
        bot.pathfinder.setGoal(new nav.goals.GoalBlock(h.x + 3, h.y + 1, h.z + 9))
        return
      }
    }
    // casa perto e vazia: corre pra dentro (zumbi é mais lento que sprint; porta fecha quando entra).
    // Sair do servidor não resolve: o mob continua ali quando ele volta.
    if (naked && mob && !inHouse(bot) && h?.built && h.bed && !remoteOn() && bot.entity.position.distanceTo(new Vec3(h.bed.x, h.bed.y, h.bed.z)) < 60) {
      const occupied = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.x >= h.x && e.position.x < h.x + 7 && e.position.z >= h.z && e.position.z < h.z + 7)
      if (!occupied) {
        log.warn(`fuga: correndo pra casa (${mob.name} a ${Math.round(mob.position.distanceTo(bot.entity.position))} blocos)`)
        bot.inCombat = true // etapas esperam (goto aguarda inCombat) até chegar
        bot.setControlState('sprint', true)
        bot.pathfinder.setGoal(new nav.goals.GoalNear(h.bed.x, h.bed.y, h.bed.z + 1, 1))
        setTimeout(() => { bot.inCombat = false; bot.setControlState('sprint', false) }, 12000)
        return
      }
    }
    if (naked && mob && !inHouse(bot) && !buried(bot) && !nothingToLose(bot)) { log.warn(`fuga: renasci sem armadura com ${mob.name} a ${Math.round(mob.position.distanceTo(bot.entity.position))} blocos`); bot.quitWith('escape:150000') }
  }, 2500)
  bot.on('spawn', spawnCheck)
  spawnCheck()
  // porta da casa: o pathfinder abre e deixa aberta; esqueleto atirava pra dentro. Dentro de casa, fecha.
  const doorTimer = setInterval(() => {
    const h = require('../memory').state.home
    if (!bot.entity || !h?.built) return
    const p = bot.entity.position
    const inside = p.x >= h.x && p.x < h.x + 7 && p.z >= h.z && p.z < h.z + 6.2 && Math.abs(p.y - (h.y + 1)) < 2
    // também fecha ao sair (porta aberta deixou husk e zumbi entrarem e esperarem na cama)
    const doorC = new Vec3(h.x + 3.5, h.y + 1, h.z + 7.5)
    const v = bot.entity.velocity
    const leaving = (p.x - doorC.x) * v.x + (p.z - doorC.z) * v.z > 0.001 // se afastando (chegando ele precisa da porta aberta)
    const justOut = p.z > h.z + 7.6 && p.distanceTo(doorC) < 3.2 && leaving
    if (!inside && !justOut) return
    const door = bot.blockAt(new Vec3(h.x + 3, h.y + 1, h.z + 7))
    if (door && /_door$/.test(door.name) && door.getProperties?.().open) bot.activateBlock(door).catch(() => {})
  }, 2000)
  // portão do complexo: pathfinder abre e deixa aberto (zumbi entrou no complexo). Fecha ao se afastar dele.
  const gateTimer = setInterval(() => {
    const h = require('../memory').state.home
    if (!bot.entity || !h?.gated) return
    const gp = new Vec3(h.x + 3, h.y + 1, h.z + 11)
    const p = bot.entity.position
    const c = gp.offset(0.5, 0, 0.5)
    const d = p.distanceTo(c)
    const v = bot.entity.velocity
    const away = (p.x - c.x) * v.x + (p.z - c.z) * v.z > 0.001
    if (d < 1.3 || d > 4 || !away) return
    const g = bot.blockAt(gp)
    if (g && /fence_gate/.test(g.name) && g.getProperties?.().open) bot.activateBlock(g).catch(() => {})
  }, 1500)
  bot.once('end', () => clearInterval(gateTimer))
  bot.once('end', () => clearInterval(doorTimer))
  const t = setInterval(() => {
    if (!bot.entity) return
    // ataque de saqueadores (vários com besta, entraram até na casa): não dá pra enfrentar; sai 10 min
    const illagers = Object.values(bot.entities).filter(e => /^(pillager|vindicator|evoker|ravager|illusioner)$/.test(e.name) && e.position.distanceTo(bot.entity.position) < 32)
    if (illagers.length >= 2) {
      const st = require('../memory').state
      const remote = st.remote && st.remote.until > Date.now()
      if (!remote && !bot.inCombat) {
        // ocupam a casa e não somem (área descarregada congela o ataque): vai trabalhar a ~100 blocos e junta peças do golem
        const c = illagers.reduce((acc, e) => acc.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / illagers.length)
        const away = bot.entity.position.minus(c)
        const len = Math.hypot(away.x, away.z) || 1
        const target = { x: Math.round(bot.entity.position.x + away.x / len * 100), z: Math.round(bot.entity.position.z + away.z / len * 100) }
        st.remote = { until: Date.now() + 40 * 60000, x: target.x, z: target.z, why: `${illagers.length} saqueadores em casa` }
        require('../memory').save()
        log.warn(`saqueadores: ${illagers.length} em casa, indo trabalhar longe (${target.x} ${target.z})`)
        bot.inCombat = true
        bot.setControlState('sprint', true)
        bot.pathfinder.setGoal(new nav.goals.GoalNearXZ(target.x, target.z, 6))
        setTimeout(() => { bot.inCombat = false; bot.setControlState('sprint', false) }, 45000)
        return
      }
      if (remote && illagers.some(e => e.position.distanceTo(bot.entity.position) < 16) && bot.quitWith && !buried(bot)) { log.warn('fuga: saqueadores alcançaram, saindo 5 min'); bot.quitWith('escape:300000'); return }
    }
    // creeper a menos de 7 blocos: foge antes de chegar perto (explosão tira 24)
    // creeper colado (< 4) vale mesmo durante outra fuga: a fuga não dá conta (−24 de ferro); sai 1 min
    const creeper = bot.nearestEntity(e => e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 7)
    if (creeper && creeper.position.distanceTo(bot.entity.position) < 4 && !inHouse(bot) && bot.quitWith && !buried(bot)) { log.warn('fuga: creeper colado, saindo 1 min'); bot.quitWith('escape:60000') } else if (creeper && !engaged) flee(creeper, 'creeper')
    breathe()
    eat()
    defend()
  }, 700)
  bot.equipArmorNow = equipArmor
  // foto do inventário (com armadura) a cada 3 s: na morte o agent.js anota o que ficou no túmulo
  const snap = setInterval(() => { if (bot.entity && bot.health > 0) bot.lastInv = bot.inventory.slots.filter(Boolean).map(i => i.name) }, 3000)
  bot.once('end', () => clearInterval(snap))
  const herds = setInterval(() => {
    if (!bot.entity) return
    const st = require('../memory').state
    st.herds = st.herds || {}
    for (const e of Object.values(bot.entities)) {
      if (!PREY.has(e.name) || !e.position) continue
      st.herds[e.name] = { x: Math.round(e.position.x), z: Math.round(e.position.z), at: Date.now() }
    }
  }, 20000)
  bot.once('end', () => clearInterval(herds))
  const a = setInterval(() => { if (bot.entity) equipArmor() }, 15000)
  bot.once('end', () => { clearInterval(t); clearInterval(a) })
}

// Caça animais até ter `target` comidas no inventário.
// Caça até `enough()` (padrão: ter `target` comidas). opts.prey limita as espécies (ex.: só ovelha para lã).
async function hunt (bot, target, signal, opts = {}) {
  let misses = 0
  const prey_ = opts.prey || PREY
  const enough = opts.enough || (() => foodCount(bot) >= target)
  while (!enough()) {
    if (signal?.aborted) throw new StepError('aborted')
    const prey = bot.nearestEntity(e => prey_.has(e.name) && e.position.distanceTo(bot.entity.position) < 64)
    if (!prey) {
      if (++misses > 5) throw new StepError('not_found', 'sem animais por perto')
      // vai onde viu esse bicho por último (memória de manadas); sem memória, explora
      const seen = Object.entries(require('../memory').state.herds || {})
        .filter(([name, h]) => prey_.has(name) && Date.now() - h.at < 6 * 3600000 && Math.hypot(h.x - bot.entity.position.x, h.z - bot.entity.position.z) > 40)
        .sort((a, b) => Math.hypot(a[1].x - bot.entity.position.x, a[1].z - bot.entity.position.z) - Math.hypot(b[1].x - bot.entity.position.x, b[1].z - bot.entity.position.z))[0]
      if (seen && misses <= 2) {
        log.info(`caça: indo onde vi ${seen[0]} (${seen[1].x} ${seen[1].z})`)
        await nav.goto(bot, nav.nearXZ(seen[1].x, seen[1].z, 8), { timeout: 120000, signal }).catch(e => { if (e.code === 'aborted') throw e })
      } else await nav.wander(bot, 64, nav.exploreAngle(bot), { signal }).catch(e => { if (e.code === 'aborted') throw e })
      continue
    }
    const w = WEAPON.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean)
    if (w) await bot.equip(w, 'hand').catch(() => {})
    log.info(`caça: ${prey.name} a ${Math.round(prey.position.distanceTo(bot.entity.position))} blocos`)
    const start = Date.now()
    while (prey.isValid && Date.now() - start < 30000) {
      if (prey.position.distanceTo(bot.entity.position) > 3) {
        await nav.goto(bot, new nav.goals.GoalFollow(prey, 2), { timeout: 8000, signal }).catch(() => {})
      } else {
        await bot.lookAt(prey.position.offset(0, prey.height / 2, 0), true)
        bot.attack(prey)
        await sleep(650)
      }
    }
    await sleep(800)
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
    for (const d of drops) await nav.goto(bot, nav.near(d.position, 0), { timeout: 6000 }).catch(() => {})
  }
}

// Abrigo noturno sem cama: cava 3 blocos para baixo e tampa acima da cabeça (esqueleto não acerta,
// zumbi não alcança). De manhã nav.toSurface sobe em escada. Só em chão firme (sem líquido).
// só chão natural: pedregulho/terracota costumam ser construção de jogador
const SOFT = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|stone|andesite|diorite|granite|tuff|deepslate|sand|red_sand|gravel|clay|mud)$/
async function bunker (bot) {
  const p = bot.entity.position.floored()
  for (let dy = 1; dy <= 4; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0))
    if (!b || (dy <= 3 && !SOFT.test(b.name)) || /water|lava/.test(b.name)) return false
  }
  // laterais do buraco também sólidas (sem água entrando)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let dy = 1; dy <= 3; dy++) if (/water|lava|air/.test(bot.blockAt(p.offset(dx, -dy, dz))?.name || 'air')) return false
  }
  bot.pathfinder?.setGoal(null)
  for (let dy = 1; dy <= 3; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0))
    await bot.tool.equipForBlock(b, {}).catch(() => {})
    await bot.dig(b)
    await sleep(400)
  }
  // a terra cavada serve de tampa (renasceu sem nada? ainda assim fica num buraco de 3)
  await sleep(500)
  const cover = bot.inventory.items().find(i => /^(cobblestone|dirt|cobbled_deepslate|andesite|stone|sand|gravel)$/.test(i.name))
  if (!cover) { log.info('noite: buraco sem tampa'); return true }
  await bot.equip(cover, 'hand')
  await bot.placeBlock(bot.blockAt(p.offset(1, -1, 0)), new Vec3(-1, 0, 0))
  log.info(`noite: abrigo em ${p.x} ${p.y - 3} ${p.z}`)
  return true
}

module.exports = { attach, hunt, foodCount, HOSTILE, bunker, inHouse }
