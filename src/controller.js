// Controlador determinístico: planejar → executar → verificar → corrigir → registrar → continuar.
// IA só entra quando a mesma etapa falha repetidamente com o mesmo erro.
const memory = require('./memory')
const ai = require('./ai')
const log = require('./log')
const nav = require('./skills/nav')
const { sleep, Vec3, count, task } = require('./skills/util')
const survival = require('./skills/survival')
const { HOSTILE } = survival
const graves = require('./skills/graves')
const gather = require('./skills/gather')
const storage = require('./skills/storage')
const commands = require('./commands')

// etapas de preparo que valem antes de buscar túmulo longe (comida, ferramentas, armadura)
const PREP = ['restock', 'kit', 'wood', 'wooden_pickaxe', 'stone_tools', 'iron_gear']
// 'empire' (nome no .env) agora é a fábrica com casa segura; o procriador antigo ficou como 'breeder'
const MISSIONS = { emeralds: require('./missions/emeralds'), breeder: require('./missions/empire'), factory: require('./missions/factory'), empire: require('./missions/factory') }
const STEP_TIMEOUT = 15 * 60000

class Controller {
  constructor (missionName) {
    this.mission = MISSIONS[missionName] || MISSIONS.emeralds
    this.phase = 'idle'
    this.current = null
    this.bot = null
    this.running = true
    this.abort = null
    this.jobs = []
    this.waitUntil = 0
    this.waitReason = ''
    const s = memory.state
    if (s.mission !== this.mission.name) { s.mission = this.mission.name; s.steps = {}; memory.save(true) }
  }

  attach (bot) {
    this.bot = bot
    if (!this.loopStarted) { this.loopStarted = true; this.loop() }
  }

  detach () { this.interrupt('desconectado'); this.bot = null }

  activity () {
    if (memory.state.paused) return ''
    if (this.waitUntil > Date.now()) return 'esperando um pouco'
    return this.mission.steps.find(s => s.id === this.current)?.desc || ''
  }

  describe () {
    const s = memory.state
    if (s.paused) return 'pausado'
    const step = this.mission.steps.find(x => x.id === this.current)
    const rec = s.steps[this.current] || {}
    return `missão: ${this.mission.title}; etapa: ${step ? step.desc : '-'}; fase: ${this.phase}` +
      (rec.attempts ? `; tentativas: ${rec.attempts}` : '') +
      (this.waitUntil > Date.now() ? `; ${this.waitReason}` : '') +
      (s.goal ? `; objetivo manual: ${s.goal}` : '')
  }

  status () {
    const b = this.bot
    return {
      online: !!b?.entity,
      paused: memory.state.paused,
      phase: this.phase,
      step: this.current,
      describe: this.describe(),
      pos: b?.entity ? b.entity.position.floored() : null,
      dimension: b?.game?.dimension,
      health: b?.health,
      food: b?.food,
      emeralds: b ? count(b, 'emerald') : 0,
      armor: b?.inventory ? [5, 6, 7, 8].map(s => b.inventory.slots[s]?.name || null) : [],
      stats: memory.state.stats,
      ai: { budgetOk: ai.budgetOk() }
    }
  }

  interrupt (why) {
    if (this.abort) { this.abort.abort(); log.info('interrompido:', why) }
    try { this.bot?.pathfinder?.setGoal(null) } catch {}
  }

  queue (id, desc, run) {
    if (this.jobs.some(j => j.id === id)) return false
    this.jobs.push({ id, desc, run })
    this.interrupt(desc)
    return true
  }

  pause () { memory.state.paused = true; memory.save(true); this.interrupt('pausa'); memory.decision('agente pausado pelo controle') }
  resume () { memory.state.paused = false; this.waitUntil = 0; memory.save(true) }
  stop () { this.running = false; this.interrupt('stop') }

  graveFar () {
    const d = memory.state.lastDeath
    return !!(d && this.bot?.entity && this.bot.entity.position.distanceTo(new Vec3(d.x, d.y, d.z)) > 150)
  }

  pendingGrave () {
    const s = memory.state
    const fresh = (g) => g && !g.recovered && Date.now() - g.at < 24 * 3600000
    return fresh(s.lastDeath) || (s.graves || []).some(fresh)
  }

  pickStep () {
    const s = memory.state
    for (const step of this.mission.steps) {
      const rec = s.steps[step.id] || {}
      if (rec.blockedUntil && rec.blockedUntil > Date.now()) continue
      if (rec.skipped) continue
      // o kit perdido está no túmulo: não gasta diamante do baú fazendo outro enquanto há túmulo pendente
      // kit perdido em túmulo PERTO: busca o túmulo em vez de gastar diamante. Túmulo longe: atravessar
      // o mapa sem armadura matou o bot várias vezes, então monta kit novo antes (o antigo vira reserva).
      if (step.id === 'kit' && this.pendingGrave() && !this.graveFar()) continue
      if (this.prepOnly && !['stash', ...PREP].includes(step.id)) continue
      // casa ocupada (saqueadores): só etapas que não dependem da casa (equipamento, peças do golem)
      if (memory.state.remote && memory.state.remote.until > Date.now() && !step.remoteOk && !['weapon', 'wood', 'wooden_pickaxe', 'stone_tools', 'iron_gear'].includes(step.id)) continue
      if (!step.done(this.bot, s)) return step
    }
    return null
  }

  async loop () {
    while (this.running) {
      const bot = this.bot
      if (!bot?.entity || bot.isAlive === false || memory.state.paused || this.waitUntil > Date.now()) {
        this.phase = memory.state.paused ? 'pausado' : (bot?.entity ? 'esperando' : 'offline')
        await sleep(1000)
        continue
      }
      try {
        // casa ocupada por saqueadores: trabalha no ponto remoto (longe deles)
        const rm = memory.state.remote
        // casa infestada e sem golem: o remoto se renova (voltar/home base = cair no meio dos mobs)
        if (rm && rm.until <= Date.now() && memory.state.home?.infested && !memory.state.home?.golem && !(require('./missions/factory').steps && bot.inventory.items().some(i => i.name === 'carved_pumpkin') && bot.inventory.items().filter(i => i.name === 'iron_block').reduce((n, i) => n + i.count, 0) >= 4)) { rm.until = Date.now() + 20 * 60000; memory.save() }
        // renasceu longe (spawn do mundo, ~2900 blocos): não atravessa o mapa; o ponto remoto passa a ser aqui
        if (rm && rm.until > Date.now() && Math.hypot(bot.entity.position.x - rm.x, bot.entity.position.z - rm.z) > 500) { rm.x = Math.round(bot.entity.position.x); rm.z = Math.round(bot.entity.position.z); memory.save(); log.info(`remoto: novo ponto aqui (${rm.x} ${rm.z})`) }
        if (rm && rm.until > Date.now() && Math.hypot(bot.entity.position.x - rm.x, bot.entity.position.z - rm.z) > 40) {
          this.phase = 'indo pro ponto remoto'
          this.waitReason = rm.why
          await nav.goto(bot, nav.nearXZ(rm.x, rm.z, 8), { timeout: 180000 }).catch(e => log.info('remoto:', e.message))
          continue
        }
        // vida baixa: para, se afasta de mob e espera regenerar (comida alta regenera) antes de seguir
        if (bot.health < 12) this.healing = true
        if (this.healing && bot.health >= 20) this.healing = false
        if (this.healing) {
          this.phase = 'recuperando vida'
          // com casa: recupera lá dentro (se afastar de mob já levou ele pra fora do complexo e morreu)
          const home = memory.state.home
          const remoteNow = memory.state.remote && memory.state.remote.until > Date.now()
          if (home?.built && !remoteNow && !survival.inHouse(bot) && bot.entity.position.distanceTo(new Vec3(home.x + 3, home.y + 1, home.z + 3)) < 80) {
            await nav.goto(bot, nav.near(new Vec3(home.x + 3, home.y + 1, home.z + 3), 1), { timeout: 40000 }).catch(() => {})
          } else {
            const near = Object.values(bot.entities).filter(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 16)
            if (near.length) await this.retreat(bot, near).catch(() => {})
          }
          this.waitUntil = Date.now() + 8000
          this.waitReason = `recuperando vida (${Math.round(bot.health)}/24)`
          continue
        }
        // mob dentro do muro do complexo e ele armado e inteiro: limpa antes de seguir (portão aberto deixou zumbi entrar)
        const hm = memory.state.home
        // desligado: zumbi daqui tira ~11 por golpe mesmo de ferro, corpo a corpo perde. O golem (etapa g_golem) é quem limpa.
        if (false && hm?.walled && bot.health > 16 && [5, 6, 7, 8].every(sl => bot.inventory.slots[sl]) && bot.fight) {
          const inside = (e) => e.position.x >= hm.x - 3 && e.position.x <= hm.x + 21 && e.position.z >= hm.z - 4 && e.position.z <= hm.z + 11
          const intruder = bot.nearestEntity(e => HOSTILE.has(e.name) && e.name !== 'creeper' && inside(e) && e.position.distanceTo(bot.entity.position) < 40)
          if (intruder) {
            this.phase = 'limpando o complexo'
            log.warn(`complexo: ${intruder.name} dentro do muro, indo matar`)
            await bot.fight(intruder).catch(() => {})
            continue
          }
        }
        await this.recoverDeath(bot)
        // sem armadura, dentro de casa, com mob lá fora (husk não queima no sol): espera dentro, não sai
        if (![5, 6, 7, 8].some(sl => bot.inventory.slots[sl]) && survival.inHouse(bot)) {
          const h = memory.state.home
          const inHouseMob = (e) => e.position.x >= h.x && e.position.x < h.x + 7 && e.position.z >= h.z && e.position.z < h.z + 7
          const out = bot.nearestEntity(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 14 && !inHouseMob(e))
          if (out) {
            this.phase = 'esperando em casa'
            this.waitUntil = Date.now() + 20000
            this.waitReason = `${out.name} lá fora, sem armadura: esperando dentro de casa`
            continue
          }
        }
        // sem armadura e com reserva no baú de casa: veste antes de qualquer etapa
        if (this.mission.wearSpare) await this.mission.wearSpare(bot).catch(e => log.warn('reserva:', e.message))
        // noite vem antes de tudo (até de túmulo pendente): dorme ou sai do servidor
        if (await this.nightGuard(bot, {})) continue
        // túmulo pendente (com o kit dentro): não sai fazendo missão pelado; tenta de novo em 5 min.
        // Depois de 6 tentativas segue a missão (túmulo pode ser inalcançável).
        const g = memory.state.lastDeath
        // longe e sem armadura: prepara primeiro (comida + kit), depois vai
        const armed = [5, 6, 7, 8].every(s => bot.inventory.slots[s])
        // só prepara se ainda dá pra fazer algo (kit/comida pendentes); sem diamante, vai assim mesmo (de dia)
        const pendingPrep = this.mission.steps.some(st => PREP.includes(st.id) && !st.done(bot, memory.state))
        const prep = this.graveFar() && pendingPrep && !armed
        this.prepOnly = !!(this.pendingGrave() && prep)
        // só túmulo com item valioso segura a missão; comum, ele tenta no caminho mas segue trabalhando
        if (this.pendingGrave() && g && g.valuable === true && (g.tries || 0) < 6 && !prep) {
          this.phase = 'esperando para buscar o túmulo'
          this.waitUntil = Date.now() + 30000
          this.waitReason = `túmulo em ${g.x} ${g.y} ${g.z} (tentativa ${g.tries || 0}/6)`
          const near = Object.values(bot.entities).filter(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 12)
          if (near.length) await this.retreat(bot, near).catch(() => {})
          continue
        }
        // mochila cheia trava coleta e túmulo: lixo de mineração sai antes da próxima etapa
        if (storage.freeSlots(bot) < 3) await storage.dropJunk(bot, 6).catch(() => {})
        if (storage.freeSlots(bot) < 3) await storage.depositSurplus(bot).catch(e => log.warn('guardar excedente:', e.message))
        // comida acabando: kit grátis do /kits (OrbitKits) antes de sair caçando
        if (survival.foodCount(bot) < 8) await commands.claimKits(bot).catch(e => log.warn('kits:', e.message))
        // tarefas pedidas pelo painel (ex.: conferir baús) passam na frente da missão
        if (this.jobs.length) {
          const job = this.jobs.shift()
          this.current = job.id
          this.phase = job.desc
          this.abort = new AbortController()
          const jobSignal = this.abort.signal
          await task.run({ signal: jobSignal }, () => job.run(bot, jobSignal)).catch(e => log.warn(`tarefa ${job.id}:`, e.message))
          this.abort = null
          continue
        }
        // PLANEJAR
        this.phase = 'planejar'
        const step = this.pickStep()
        if (!step) { this.phase = 'concluído'; this.current = null; await sleep(5000); continue }
        if (await this.nightGuard(bot, step)) continue
        if (step.outdoor && await this.mobGuard(bot)) continue
        // etapas ao ar livre começam na superfície (evita perseguir ovelha de dentro de túnel)
        if (step.outdoor && step.id !== 'b_materials' && nav.underground(bot)) await nav.toSurface(bot).catch(e => log.warn('superfície:', e.message))
        if (this.current !== step.id) log.info(`etapa ${step.id}: ${step.desc}`)
        this.current = step.id
        const rec = memory.state.steps[step.id] = memory.state.steps[step.id] || { attempts: 0, errors: [] }
        // EXECUTAR
        this.phase = 'executar'
        this.abort = new AbortController()
        const signal = this.abort.signal
        let error = null
        try {
          await Promise.race([
            task.run({ signal }, () => step.run(bot, { signal, setWait: (ms, why) => { this.waitUntil = Date.now() + ms; this.waitReason = why } })),
            new Promise((resolve, reject) => setTimeout(() => reject(Object.assign(new Error('etapa excedeu 15min'), { code: 'step_timeout' })), STEP_TIMEOUT)),
            // desconexão/pausa/morte: larga a etapa na hora (promessas do bot antigo podem nunca terminar)
            new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('interrompido'), { code: 'aborted' }))))
          ])
        } catch (e) { error = e }
        this.abort = null
        if (this.bot !== bot || !bot.entity) continue
        // VERIFICAR
        this.phase = 'verificar'
        const ok = !error && (step.repeat || step.done(bot, memory.state))
        if (ok) {
          // REGISTRAR
          this.phase = 'registrar'
          if (rec.attempts > 0) memory.error(`etapa ${step.id}`, `falhou ${rec.attempts}x (${rec.errors.slice(-1)[0]})`, 'resolvida com nova tentativa')
          if (!step.repeat) memory.history(`etapa concluída: ${step.desc}`)
          rec.attempts = 0; rec.errors = []; rec.doneAt = new Date().toISOString()
          memory.save()
          memory.snapshot(bot, this)
          continue
        }
        // CORRIGIR
        this.phase = 'corrigir'
        const code = error?.code || (error ? 'erro' : 'não_verificado')
        if (code === 'aborted') continue
        if (code === 'searching') { await sleep(500); continue }
        rec.attempts++
        rec.errors = [...rec.errors, `${code}: ${(error?.message || '').slice(0, 80)}`].slice(-5)
        memory.save()
        log.warn(`etapa ${step.id} falhou (${rec.attempts}):`, code, error?.message || '')
        const sameErr = rec.errors.length >= 3 && rec.errors.slice(-3).every(e => e.split(':')[0] === code)
        if (sameErr && rec.attempts % 3 === 0) await this.escalate(bot, step, rec)
        if (rec.attempts >= 9) {
          rec.blockedUntil = Date.now() + 10 * 60000
          rec.attempts = 0
          memory.error(`etapa ${step.id} bloqueada 10min`, rec.errors.join(' | '))
          memory.save()
        }
        await sleep(Math.min(60000, 2000 * 2 ** Math.min(rec.attempts, 5)))
      } catch (e) {
        log.error('controller', e.stack || e.message)
        await sleep(5000)
      }
    }
  }

  // Noite: sempre tenta dormir (cama até 32 blocos). Sem cama, só segura etapas ao ar livre.
  // Noite: nenhuma etapa roda (nem as "internas": kit/restock usam /home e levaram o bot pra base
  // cheia de zumbi). No subsolo fica (minerando se faltar pedra); na superfície dorme se der, senão cava abrigo.
  async nightGuard (bot, step) {
    const t = bot.time?.timeOfDay ?? 0
    const night = t >= 12542 && t <= 23460
    if (bot.isSleeping) { this.waitUntil = Date.now() + 5000; this.waitReason = 'dormindo'; return true }
    // com casa pronta: no fim da tarde volta pra casa, dorme; sem dormir, espera lá dentro (não sai do servidor)
    const home = memory.state.home
    // casa infestada (mob trancado lá dentro) não serve de abrigo até a etapa h_clear limpar
    const remote = memory.state.remote && memory.state.remote.until > Date.now()
    if (home?.built && !home.infested && !remote && bot.game.dimension === 'overworld' && t >= 11500 && t <= 23460) {
      const inside = (p) => p.x >= home.x && p.x < home.x + (home.w || 7) && p.z >= home.z && p.z < home.z + (home.w || 7) && Math.abs(p.y - (home.y + 1)) < 2
      const center = new Vec3(home.x + 3, home.y + 1, home.z + 3)
      if (!inside(bot.entity.position.floored()) && bot.entity.position.distanceTo(center) < 300) {
        this.current = 'night'
        this.phase = 'voltando pra casa'
        if (bot.entity.position.distanceTo(center) > 150) await commands.tryHome(bot).catch(() => false)
        await nav.goto(bot, nav.near(center, 1), { timeout: 150000 }).catch(e => log.info('casa: não cheguei —', e.message))
      }
      if (inside(bot.entity.position.floored())) {
        this.current = 'night'
        this.phase = 'noite em casa'
        if (night) {
          // a cama DA CASA (a mais próxima podia ser de outra casa e o renascimento ia pra lá, no meio de mob)
          const bed = home.bed ? bot.blockAt(new Vec3(home.bed.x, home.bed.y, home.bed.z)) : null
          if (bed) {
            await nav.goto(bot, nav.near(bed.position, 1), { timeout: 15000 }).catch(() => {})
            try { await bot.sleep(bed); home.spawnSetAt = Date.now(); memory.save(); log.info('noite: dormindo em casa'); return true } catch (e) { this.waitReason = 'noite em casa (sem dormir: ' + e.message.slice(0, 40) + ')' }
          }
        } else this.waitReason = 'em casa esperando anoitecer pra dormir'
        this.waitUntil = Date.now() + 15000
        return true
      }
      // não conseguiu entrar ainda: tenta de novo em vez de deixar etapa rodar lá fora no escuro
      if (bot.entity.position.distanceTo(center) < 300 && !night) { this.waitUntil = Date.now() + 3000; this.waitReason = 'voltando pra casa'; return true }
    }
    if (!night || bot.game.dimension !== 'overworld') return false
    this.current = 'night'
    this.phase = 'noite'
    // matching por ids usa a busca rápida por paleta; com função varre 260 mil blocos e trava o processo
    const bed = bot.findBlock({ matching: bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id), maxDistance: 32 })
    if (bed) {
      try {
        await nav.goto(bot, nav.near(bed.position, 2), { timeout: 40000 })
        await bot.sleep(bed)
        log.info('noite: dormindo')
        return true
      } catch (e) { log.info('noite: não deu pra dormir —', e.message) }
    }
    // Sem dormir, a noite mata: os mobs daqui (SolarisRPG) tiram 16 de vida por golpe, com ou sem
    // armadura, e abrigo cavado não segurou. Desconecta e volta quando amanhecer.
    const ticks = (23460 - t + 24000) % 24000
    const ms = Math.round(ticks / 20 * 1000) + 15000
    memory.history(`noite sem cama segura: saí do servidor por ${Math.round(ms / 60000)} min`)
    bot.quitWith?.(`night_off:${ms}`)
    this.waitUntil = Date.now() + 60000
    return true
  }


  // De dia nem todo mob queima (creeper, aranha, zumbi de capacete, na sombra...). Antes de sair,
  // espera a área limpar; após ~5 min esperando, sai assim mesmo e confia no reflexo de defesa.
  async mobGuard (bot) {
    const near = Object.values(bot.entities).filter(e => HOSTILE.has(e.name) && e.position.distanceTo(bot.entity.position) < 18)
    if (!near.length) { this.mobWaitSince = 0; return false }
    this.mobWaitSince = this.mobWaitSince || Date.now()
    if (Date.now() - this.mobWaitSince > 5 * 60000) return false
    this.phase = 'cuidado'
    await this.retreat(bot, near).catch(() => {})
    this.waitUntil = Date.now() + 15000
    this.waitReason = `esperando ${near.length} mob(s) hostil(is) sair (${[...new Set(near.map(e => e.name))].join(', ')})`
    return true
  }

  // Esperar parado do lado do mob (ou dentro d'água) é pior que sair: vai para terra firme se estiver
  // na água; senão anda ~14 blocos para longe do grupo de mobs.
  async retreat (bot, near) {
    const me = bot.entity.position
    const wet = /water/.test(bot.blockAt(me)?.name || '') || /water/.test(bot.blockAt(me.offset(0, 1, 0))?.name || '')
    if (wet) {
      const land = bot.findBlock({
        maxDistance: 24,
        count: 1,
        matching: bot.registry.blocksArray.filter(b => b.boundingBox === 'block' && !/leaves|water|ice/.test(b.name)).map(b => b.id),
        useExtraInfo: b => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' && bot.blockAt(b.position.offset(0, 2, 0))?.name === 'air'
      })
      if (land) { this.waitReason = 'saindo da água'; await nav.goto(bot, nav.near(land.position.offset(0, 1, 0), 1), { timeout: 30000 }); return }
    }
    const c = near.reduce((a, e) => a.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / near.length)
    const away = me.minus(c)
    const len = Math.hypot(away.x, away.z) || 1
    await nav.goto(bot, nav.nearXZ(me.x + away.x / len * 14, me.z + away.z / len * 14, 3), { timeout: 20000 })
  }

  // Recupera itens após morte (uma tentativa, até 4 min depois).
  // Sempre volta ao túmulo/local da morte (sem prazo; até 3 tentativas). De noite espera amanhecer.
  // A lista do servidor (/rexgraves list) é a verdade: a memória local já marcou como resgatado túmulo
  // que continuava lá (e esqueceu um com a armadura). Sincroniza depois de morte/resgate e a cada 10 min.
  async syncGraves (bot) {
    const s = memory.state
    if (!s.gravesDirty && Date.now() - (s.gravesSyncedAt || 0) < 10 * 60000) return
    const r = await commands.run(bot, '/rexgraves list').catch(() => null)
    if (!r?.ok) return
    s.gravesSyncedAt = Date.now()
    s.gravesDirty = false
    const list = []
    for (const l of r.lines) {
      const m = l.match(/#(\d+)\s+(\w+)\s*\|\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\|\s*(?:(\d+)h)?\s*(?:(\d+)m)?/)
      if (!m) continue
      const left = ((+m[6] || 0) * 60 + (+m[7] || 0)) * 60000
      list.push({ x: +m[3], y: +m[4], z: +m[5], dim: m[2] === 'world' ? 'overworld' : m[2], at: Date.now() - (24 * 3600000 - left), fromServer: true, idx: +m[1] })
    }
    const same = (a, b) => a && b && Math.abs(a.x - b.x) <= 3 && Math.abs(a.y - b.y) <= 3 && Math.abs(a.z - b.z) <= 3
    s.unreachable = s.unreachable || []
    if (s.lastDeath?.unreachable && !s.unreachable.some(u => same(u, s.lastDeath))) s.unreachable.push({ x: s.lastDeath.x, y: s.lastDeath.y, z: s.lastDeath.z })
    if (s.lastDeath && !s.lastDeath.recovered && !list.some(g => same(g, s.lastDeath))) s.lastDeath.recovered = true
    if (s.lastDeath && s.lastDeath.recovered) {
      const g = list.filter(x => !(s.unreachable || []).some(u => same(u, x))).sort((a, b) => bot.entity.position.distanceTo(new Vec3(a.x, a.y, a.z)) - bot.entity.position.distanceTo(new Vec3(b.x, b.y, b.z)))[0]
      if (g) s.lastDeath = g
    } else if (s.lastDeath && !s.lastDeath.unreachable && list.some(g => same(g, s.lastDeath))) {
      s.lastDeath.recovered = false
    }
    s.graves = list.filter(g => !same(g, s.lastDeath) && !s.unreachable.some(u => same(u, g)))
    if (!s.lastDeath && list.length) s.lastDeath = s.graves.shift()
    s.activeGraves = list.map(g => ({ x: g.x, y: g.y, z: g.z }))
    memory.save()
    if (list.length) log.info(`túmulos ativos no servidor: ${list.map(g => `${g.x} ${g.y} ${g.z}`).join(' · ')}`)
  }

  async recoverDeath (bot) {
    const s = memory.state
    await this.syncGraves(bot).catch(e => log.warn('túmulos:', e.message))
    // terminado (ou expirado) o túmulo atual, puxa o próximo da fila
    s.graves = (s.graves || []).filter(g => !g.recovered && Date.now() - g.at < 24 * 3600000)
    if ((!s.lastDeath || s.lastDeath.recovered || Date.now() - s.lastDeath.at > 24 * 3600000) && s.graves.length) {
      s.lastDeath = s.graves.shift()
      memory.save()
    }
    const d = s.lastDeath
    // casa ocupada por saqueadores: túmulo lá perto espera
    if (d && s.remote && s.remote.until > Date.now() && s.home?.x !== undefined && Math.hypot(d.x - s.home.x, d.z - s.home.z) < 80) return
    // Túmulo do servidor: só o próprio jogador resgata e dura 24h. Tenta de novo a cada 20 min até lá.
    if (!d || d.recovered || Date.now() - d.at > 24 * 3600000 || d.dim !== bot.game.dimension) return
    // longe e sem nada valioso dentro: não vale arriscar (cada ida custou o equipamento novo). Abandona.
    const dist = bot.entity.position.distanceTo(new Vec3(d.x, d.y, d.z))
    if ((dist > 150 || d.y < 50 || (d.tries || 0) >= 2) && d.valuable !== true) {
      d.recovered = true
      d.abandoned = true
      s.unreachable = [...(s.unreachable || []), { x: d.x, y: d.y, z: d.z, abandoned: true }]
      memory.save()
      memory.history(`túmulo em ${d.x} ${d.y} ${d.z} (${Math.round(dist)} blocos, y ${d.y}) sem item valioso: deixei (refazer equipamento é mais seguro)`)
      log.info(`túmulo: ${d.x} ${d.y} ${d.z} longe e sem valioso, deixei`)
      return
    }
    // longe e sem armadura: primeiro se equipa (etapas PREP); ir pelado matou o bot 3 vezes no caminho
    const armored = [5, 6, 7, 8].every(slot => bot.inventory.slots[slot])
    if (!armored && bot.entity.position.distanceTo(new Vec3(d.x, d.y, d.z)) > 150) return
    // pelado: túmulo com mob em volta é armadilha (morreu 5x seguidas indo buscar na área dos husks)
    if (!armored && bot.entity.position.distanceTo(new Vec3(d.x, d.y, d.z)) > 12) return // pelado só pega túmulo do lado
    if (!armored && Object.values(bot.entities).some(e => HOSTILE.has(e.name) && e.position.distanceTo(new Vec3(d.x, d.y, d.z)) < 16)) { d.lastTry = Date.now(); memory.save(); return }
    // túmulo aberto pela metade (mochila encheu): volta logo; não alcançou: espera 20 min
    if (d.lastTry && Date.now() - d.lastTry < (d.partial ? 2 : 5) * 60000) return
    const t = bot.time?.timeOfDay ?? 0
    // de noite só se o túmulo já estiver perto (não atravessa o mapa no escuro)
    const close = bot.entity.position.distanceTo(new Vec3(d.x, d.y, d.z)) < 16
    if (t >= 12542 && t <= 23460) return
    d.tries = (d.tries || 0) + 1
    d.lastTry = Date.now()
    memory.save()
    this.current = 'recover'
    this.phase = 'túmulo'
    const total = () => bot.inventory.items().reduce((n, i) => n + i.count, 0)
    const before = total()
    try {
      const pos = new Vec3(d.x, d.y, d.z)
      // chega por cima (XZ): o túmulo pode estar no fundo d'água e o pathfinder nada mal
      // longe: /rexgraves tp leva direto ao túmulo (não atravessa o mapa sem armadura)
      if (bot.entity.position.distanceTo(pos) > 100) await commands.graveTp(bot, pos).catch(e => log.warn('rexgraves:', e.message))
      // chega perto (chunk carregado) e mede a água ANTES de mergulhar: nadando ele nunca "chega"
      await nav.goto(bot, nav.nearXZ(pos.x, pos.z, 16), { timeout: 300000 }).catch(() => {})
      await bot.waitForChunksToLoad().catch(() => {})
      // túmulo no fundo de água funda: o ar não dá pra descer (morreu tentando). Fica pro dono pegar.
      let depth = 0
      // conta toda a água da coluna acima (o túmulo pode estar numa cavidade sob rocha, com o mar em cima)
      for (let y = pos.y + 1; y < pos.y + 48; y++) if (/water|kelp|seagrass|bubble/.test(bot.blockAt(new Vec3(pos.x, y, pos.z))?.name || '')) depth++
      if (depth > 8) {
        d.recovered = true
        d.unreachable = true
        s.unreachable = s.unreachable || []
        s.unreachable.push({ x: d.x, y: d.y, z: d.z })
        s.gravesDirty = true
        memory.save()
        memory.history(`túmulo em ${d.x} ${d.y} ${d.z} está ${depth} blocos debaixo d'água: inalcançável pro bot, deixei pro dono`)
        memory.decision(`túmulo submerso (${depth} blocos) em ${d.x} ${d.y} ${d.z} não é buscado pelo bot; só o dono (mesma conta) consegue`)
        log.warn(`túmulo: ${depth} blocos debaixo d'água em ${d.x} ${d.y} ${d.z}, desisti`)
        return
      }
      await nav.goto(bot, nav.nearXZ(pos.x, pos.z, 3), { timeout: 90000 }).catch(e => log.info('túmulo: caminho travou —', e.message))
      await bot.waitForChunksToLoad().catch(() => {})
      await sleep(3000) // entidades de item chegam depois dos chunks
      // túmulo de entidade guarda tudo: abre primeiro, antes de gastar ar/tempo varrendo drops
      const graveHere = () => Object.values(bot.entities).some(e => e.name === 'interaction' && e.position.distanceTo(pos) < 4)
      await storage.makeRoom(bot, 14)
      let early = graveHere() && await graves.loot(bot, pos)
      // inventário encheu e o túmulo ficou com o resto: abre espaço e abre de novo
      for (let i = 0; i < 2 && early && graveHere(); i++) {
        await sleep(1500)
        if (!graveHere()) break
        await storage.makeRoom(bot, 14)
        early = await graves.loot(bot, pos)
      }
      let picked = 0
      for (let pass = 0; pass < 4 && !(early && !graveHere()); pass++) {
        const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(pos) < 24)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
        if (!drops.length) break
        for (const it of drops) {
          if (!it.isValid) continue
          await nav.goto(bot, nav.near(it.position, 0), { timeout: 15000 }).catch(() => {})
          await sleep(250)
          picked++
        }
      }
      const looted = early || await graves.loot(bot, pos)
      await bot.equipArmorNow?.().catch(() => {})
      const gained = total() - before
      d.recovered = (looted || gained > 0) && !graveHere()
      d.partial = !d.recovered && looted
      s.gravesDirty = true
      memory.save()
      const nearby = [...new Set(Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(pos) < 8).map(e => e.name))].join(',')
      memory.history(`túmulo: ${d.recovered ? `recuperei ${gained} itens` : 'nada recuperado'} em ${d.x} ${d.y} ${d.z} (${picked} drops visitados, túmulo ${looted ? 'aberto' : 'não aberto'}; entidades perto: ${nearby || 'nenhuma'})`)
    } catch (e) {
      memory.error('recuperar itens do túmulo', e.message)
    }
  }

  // Decisão por IA com contexto mínimo; ações limitadas e determinísticas.
  async escalate (bot, step, rec) {
    const inv = {}
    for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
    const ctx = {
      etapa: step.id,
      descricao: step.desc,
      erros: rec.errors.slice(-3),
      pos: bot.entity.position.floored(),
      dim: bot.game.dimension,
      vida: bot.health,
      fome: bot.food,
      inv
    }
    const known = memory.readNote('Erros/Registro.md')?.split('\n').filter(l => l.includes(step.id)).slice(-3).join('\n')
    const ans = await ai.askJson({
      complex: true,
      system: 'você decide a recuperação de um bot de minecraft survival. responda só um json: {"acao":"retry|wander|wait|skip","motivo":"curto"}. skip só se a etapa for opcional. wander = andar 100 blocos para outro lugar. wait = esperar 5 min.',
      prompt: JSON.stringify(ctx) + (known ? `\nhistórico de erros parecidos:\n${known}` : ''),
      cacheKey: `esc:${step.id}:${rec.errors.slice(-1)[0]?.split(':')[0]}`
    })
    const acao = ans?.acao || 'wander'
    memory.decision(`etapa ${step.id} travada (${rec.errors.slice(-1)[0]}): ${ans ? 'ia' : 'regra local'} escolheu ${acao}${ans?.motivo ? ` — ${ans.motivo}` : ''}`)
    if (acao === 'wander') await nav.wander(bot, 100).catch(() => {})
    else if (acao === 'wait') { this.waitUntil = Date.now() + 5 * 60000; this.waitReason = 'esperando após falhas' } else if (acao === 'skip' && step.id === 'food') rec.skipped = true
  }
}

module.exports = { Controller, MISSIONS }
