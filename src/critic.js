// Agente avaliador: vigia o bot sem IA (regras baratas a cada 2 min) e, quando algo dá errado de
// verdade (mortes seguidas, etapa falhando em loop, sem progresso, longe de casa), chama o Sonnet com um
// relatório curto pra diagnosticar e escolher UMA ação de uma lista segura. O diagnóstico e a lição vão
// pro Obsidian (Decisões/Avaliador.md) e entram no próximo relatório: o bot aprende com os próprios erros.
const ai = require('./ai')
const memory = require('./memory')
const log = require('./log')
const { Vec3 } = require('./skills/util')

const COOLDOWN = 25 * 60000 // por motivo
const MIN_GAP = 10 * 60000 // entre quaisquer duas chamadas

const SYSTEM = `você é o avaliador de um bot de minecraft survival (servidor com mobs muito fortes: 8-18 de dano por golpe).
recebe um relatório e decide UMA correção. responda só json:
{"diagnostico":"curto, a causa provável","acao":"none|block_step|reset_step|go_home|set_goal|wait","etapa":"id da etapa (para block_step/reset_step)","minutos":numero,"objetivo":"texto (para set_goal)","licao":"uma frase para o bot lembrar no futuro"}
- block_step: tira a etapa da fila por N minutos (máx 60) quando ela só falha ou mata o bot.
- reset_step: zera as tentativas da etapa (quando a falha era passageira e já mudou algo).
- go_home: volta pra casa agora (quando está longe ou se arriscando).
- set_goal: muda o objetivo manual (orienta o plano).
- wait: fica parado em segurança N minutos (máx 3; o dia do jogo dura ~10 min, esperar muito joga o dia fora).
- none: se nada precisa mudar.
prefira ações que evitem morte e andanças longas. seja específico no diagnóstico.`

class Critic {
  constructor (controller) {
    this.controller = controller
    // persistido: reinício (após cada melhoria) não pode fazer reavaliar as mesmas mortes
    const st = memory.state.critic = memory.state.critic || { lessons: [] }
    this.lastBy = st.lastBy = st.lastBy || {}
    this.lastCall = st.lastCall || 0
    this.timer = setInterval(() => this.tick().catch(e => log.warn('avaliador:', e.message)), 120000)
  }

  triggers (bot) {
    const now = Date.now()
    const ev = log.events(200).filter(e => now - e.t < 30 * 60000)
    const out = []
    const deaths = ev.filter(e => e.kind === 'morte').length
    if (deaths >= 2) out.push(['mortes', `${deaths} mortes em 30 min`])
    const fails = {}
    for (const e of ev.filter(e => e.kind === 'falha')) {
      const id = (e.text.match(/^etapa (\S+) falhou/) || [])[1]
      if (id) fails[id] = (fails[id] || 0) + (e.n || 1)
    }
    for (const [id, n] of Object.entries(fails)) if (n >= 5) out.push([`falha:${id}`, `etapa ${id} falhou ${n}x em 30 min`])
    const s = memory.state
    const cur = this.controller.current
    const rec = cur && s.steps[cur]
    if (cur && rec && !rec.doneAt) {
      this.since = this.since && this.sinceStep === cur ? this.since : now
      this.sinceStep = cur
      if (now - this.since > 50 * 60000) out.push([`lento:${cur}`, `etapa ${cur} há ${Math.round((now - this.since) / 60000)} min sem terminar`])
    }
    // parado: 25 min sem nenhum evento de progresso (ficou 30 min esperando túmulo e ninguém notou)
    const useful = log.events(200).filter(e => ['etapa', 'craft', 'estoque', 'túmulo', 'viagem', 'obra'].includes(e.kind)).pop()
    this.onlineSince = this.onlineSince || now
    const lastUseful = Math.max(useful?.t || 0, this.onlineSince)
    if (now - lastUseful > 25 * 60000) out.push(['parado', `${Math.round((now - lastUseful) / 60000)} min sem progresso (fase: ${this.controller.phase}; ${this.controller.waitReason || ''})`])
    const a = require('./skills/nav').anchor()
    if (a && bot?.entity) {
      const d = Math.hypot(bot.entity.position.x - a.x, bot.entity.position.z - a.z)
      if (d > 300) out.push(['longe', `a ${Math.round(d)} blocos de casa`])
    }
    return out.filter(([k]) => now - (this.lastBy[k] || 0) > COOLDOWN)
  }

  report (bot, why) {
    const s = memory.state
    const inv = {}
    for (const i of bot?.inventory?.items() || []) inv[i.name] = (inv[i.name] || 0) + i.count
    const top = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([n, c]) => `${n} ${c}`).join(', ')
    const a = require('./skills/nav').anchor()
    const pos = bot?.entity?.position
    const steps = this.controller.mission.steps.map(st => {
      const r = s.steps[st.id] || {}
      let done = false
      try { done = !!(bot && st.done(bot, s)) } catch {}
      return `${st.id}${done ? ' ✓' : ''}${r.attempts ? ` (${r.attempts} falhas: ${(r.errors || []).slice(-1)[0] || ''})` : ''}${r.blockedUntil > Date.now() ? ' [bloqueada]' : ''}`
    }).join('\n')
    const ev = log.events(30).map(e => `${new Date(e.t).toISOString().slice(11, 16)} ${e.kind}: ${e.text}${e.n > 1 ? ' x' + e.n : ''}`).join('\n')
    const lessons = (s.critic?.lessons || []).slice(-6).map(l => '- ' + l).join('\n')
    return `motivo da avaliação: ${why.map(w => w[1]).join('; ')}
missão: ${this.controller.mission.title}; etapa atual: ${this.controller.current || '-'}; objetivo manual: ${s.goal || '-'}
posição: ${pos ? pos.floored() : '?'}; casa: ${s.home?.x !== undefined ? `${s.home.x + 3} ${s.home.z + 3}${s.home.infested ? ' (INFESTADA: mob dentro, cama quebrada)' : ''}` : 'sem casa'}; ${s.remote && s.remote.until > Date.now() ? `MODO REMOTO ativo em ${s.remote.x} ${s.remote.z} (${s.remote.why}) — NÃO voltar pra casa` : ''}; vida ${bot?.health ?? '?'}; hora ${bot?.time?.timeOfDay ?? '?'}
armadura: ${bot ? [5, 6, 7, 8].map(i => bot.inventory.slots[i]?.name || '-').join(' ') : '?'}
inventário: ${top || 'vazio'}
etapas:
${steps}
últimos eventos:
${ev}
lições anteriores:
${lessons || '(nenhuma)'}`
  }

  async tick () {
    const bot = this.controller.bot
    if (!bot?.entity || memory.state.paused) return
    if (Date.now() - this.lastCall < MIN_GAP || !ai.budgetOk()) return
    const why = this.triggers(bot)
    if (!why.length) return
    for (const [k] of why) this.lastBy[k] = Date.now()
    this.lastCall = memory.state.critic.lastCall = Date.now()
    memory.save()
    log.warn(`avaliador: chamando IA — ${why.map(w => w[1]).join('; ')}`)
    const ans = await ai.askJson({ complex: true, system: SYSTEM, prompt: this.report(bot, why) })
    if (!ans) return
    await this.apply(bot, ans)
  }

  async apply (bot, ans) {
    const s = memory.state
    const c = this.controller
    const min = Math.max(1, Math.min(60, Number(ans.minutos) || 15))
    const step = c.mission.steps.find(st => st.id === ans.etapa)
    let did = 'nada'
    switch (ans.acao) {
      case 'block_step':
        // não bloqueia etapa que acabou de avançar (bloqueou a fazenda no meio do muro por falha antiga)
        if (step && step.id === c.current && log.events(60).some(e => ['obra', 'craft'].includes(e.kind) && Date.now() - e.t < 5 * 60000)) { did = `não bloqueei ${step.id}: está avançando`; break }
        if (step) { s.steps[step.id] = { ...(s.steps[step.id] || { attempts: 0, errors: [] }), blockedUntil: Date.now() + min * 60000 }; c.interrupt('avaliador'); did = `bloqueei ${step.id} por ${min} min` }
        break
      case 'reset_step':
        if (step) { delete s.steps[step.id]; did = `zerei ${step.id}` }
        break
      case 'go_home': {
        // casa ocupada (saqueadores) ou infestada: voltar pra lá é morrer; ignora
        if ((s.remote && s.remote.until > Date.now()) || s.home?.infested) { did = 'não voltei: casa ocupada/infestada'; break }
        const a = require('./skills/nav').anchor()
        if (a) {
          c.queue('home', 'voltando pra casa (avaliador)', async (b, signal) => {
            const nav = require('./skills/nav')
            if (b.entity.position.distanceTo(new Vec3(a.x, b.entity.position.y, a.z)) > 150) await require('./commands').tryHome(b).catch(() => false)
            await nav.goto(b, nav.nearXZ(a.x, a.z, 3), { timeout: 240000, signal })
          })
          did = 'mandei voltar pra casa'
        }
        break
      }
      case 'set_goal':
        if (ans.objetivo) { s.goal = String(ans.objetivo).slice(0, 200); did = `objetivo: ${s.goal}` }
        break
      case 'wait':
        // dia aqui dura ~10 min: espera longa jogava o dia fora
        c.waitUntil = Date.now() + Math.min(3, min) * 60000
        c.waitReason = 'avaliador mandou esperar'
        did = `esperar ${Math.min(3, min)} min`
        break
    }
    s.critic = s.critic || { lessons: [] }
    if (ans.licao) s.critic.lessons = [...s.critic.lessons, String(ans.licao).slice(0, 160)].slice(-20)
    memory.save()
    log.warn(`avaliador: ${String(ans.diagnostico || '').slice(0, 140)} → ${did}`)
    memory.appendNote('Decisões/Avaliador.md', `- ${new Date().toISOString().slice(0, 16)} ${String(ans.diagnostico || '').slice(0, 200)} → **${did}**${ans.licao ? ` · lição: ${ans.licao}` : ''}`, '# Avaliador\n\nDiagnósticos automáticos do agente avaliador (Sonnet) quando o bot entra em loop ou morre.\n')
  }

  stop () { clearInterval(this.timer) }
}

module.exports = { Critic }
