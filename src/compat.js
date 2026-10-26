// Mineflayer 4.39 testa até 26.1; os dados 26.2 vêm do patch em scripts/patch-mcdata.js.
const v = require('mineflayer/lib/version')
if (!v.testedVersions.includes('26.2')) {
  v.testedVersions.push('26.2')
  v.latestSupportedVersion = '26.2'
}
// Seções uniformes do chunk (todo ar, toda pedra) vêm como SingleValueContainer, sem `palette`. O
// findBlocks do mineflayer usa a paleta para pular seções; sem ela varre 4096 blocos por seção e,
// no alto (só céu em volta), trava o processo por minutos. Paleta de um valor resolve.
const { SingleValueContainer } = require('prismarine-chunk/src/pc/common/PaletteContainer')
if (!Object.getOwnPropertyDescriptor(SingleValueContainer.prototype, 'palette')) {
  Object.defineProperty(SingleValueContainer.prototype, 'palette', { get () { return [this.value] } })
}

// O plugin resource_pack do mineflayer serializa o UUID como objeto (uuid-1345) e o servidor 26.2
// nunca recebe o aceite certo, travando na fase de configuração. Responde com o UUID em string.
function fixResourcePack (client) {
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (name === 'resource_pack_receive' && typeof params.uuid !== 'string') return
    return write(name, params)
  }
  client.on('add_resource_pack', (data) => {
    for (const result of [3, 4, 0]) client.write('resource_pack_receive', { uuid: String(data.uuid), result })
  })
}

// 26.2: o servidor valida o pulo pelo pacote player_input (teclas do cliente). O mineflayer só
// manda esse pacote ao agachar, então todo pulo era desfeito (teleporte de volta). Manda o estado
// completo das teclas sempre que alguma muda.
function fixPlayerInput (bot) {
  const set = bot.setControlState
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
  let last = ''
  bot.setControlState = (control, state) => {
    set(control, state)
    const s = Object.fromEntries(keys.map(k => [k, bot.getControlState(k)]))
    const inputs = { forward: s.forward, backward: s.back, left: s.left, right: s.right, jump: s.jump, shift: s.sneak, sprint: s.sprint }
    const key = JSON.stringify(inputs)
    if (key === last) return
    last = key
    bot._client.write('player_input', { inputs })
  }
}

// 26.2: pacotes de movimento levam o flag horizontalCollision; o mineflayer manda sempre falso e o
// servidor desfaz o movimento quando o bot encosta numa parede (não consegue nem subir degrau).
function fixMovementFlags (bot) {
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if (params?.flags && /^(position|position_look|look|flying)$/.test(name)) {
      params.flags = { ...params.flags, hasHorizontalCollision: !!bot.entity?.isCollidedHorizontally }
    }
    // Encostado numa parede, a física do mineflayer deixa a borda da caixa (x±0.3) exatamente na
    // face do bloco e o arredondamento de double faz ela invadir o bloco por ~1e-13: o servidor
    // trata como "dentro do bloco" e teleporta de volta a cada tick (bot não sobe nem degrau).
    if ((name === 'position' || name === 'position_look') && bot.entity) {
      for (const k of ['x', 'z']) {
        const hi = params[k] + 0.3
        const lo = params[k] - 0.3
        if (Math.abs(hi - Math.round(hi)) < 1e-6) params[k] = Math.round(hi) - 0.3 - 1e-5
        else if (Math.abs(lo - Math.round(lo)) < 1e-6) params[k] = Math.round(lo) + 0.3 + 1e-5
        bot.entity.position[k] = params[k]
      }
    }
    return write(name, params)
  }
  // o cliente 1.21.2+ fecha cada tick com tick_end (depois do pacote de movimento)
  bot.on('physicsTick', () => setImmediate(() => { if (bot._client.state === 'play') write('tick_end', {}) }))
}

module.exports = { ...v, fixResourcePack, fixPlayerInput, fixMovementFlags }
