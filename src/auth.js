// Login do nLogin: na 26.2 o servidor mostra um diálogo (show_dialog) na fase de configuração.
// Responde ao diálogo de login com a senha do .env; nunca cria conta (diálogo de registro => aborta).
const nbt = require('prismarine-nbt')
const config = require('./config')
const log = require('./log')

function simplify (d) { try { return nbt.simplify(d) } catch { return d } }

const varint = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b) } while (n); return Buffer.from(out) }

// O vanilla codifica o payload como lengthPrefixed(optionalTag); o protocol.json do minecraft-data
// usa option+NBT sem tamanho e o servidor derruba a conexão. Monta o pacote à mão.
function sendClickAction (client, id, value) {
  const tag = nbt.writeUncompressed({ type: 'compound', name: '', value }, 'big')
  const anon = Buffer.concat([tag.subarray(0, 1), tag.subarray(3)]) // NBT de rede: compound sem nome
  const idBuf = Buffer.from(id, 'utf8')
  const packetId = client.state === 'configuration' ? 0x08 : null
  if (packetId === null) return client.write('custom_click_action', { id, nbt: { type: 'compound', name: '', value } })
  // 26.2 (javap): STREAM_CODEC = Identifier + lengthPrefixed(65536)(optionalTagCodec) — sem byte de Optional.
  client.writeRaw(Buffer.concat([varint(packetId), varint(idBuf.length), idBuf, varint(anon.length), anon]))
}

function attach (client, onFatal) {
  // Cliente vanilla envia brand na configuração; alguns plugins esperam por ele.
  client.once('select_known_packs', () => {
    client.write('custom_payload', { channel: 'minecraft:brand', data: Buffer.from([7, ...Buffer.from('vanilla')]) })
  })
  client.on('packet', (data, meta) => {
    if (meta.name === 'disconnect' || meta.name === 'kick_disconnect') log.warn('auth: servidor desconectou', JSON.stringify(simplify(data.reason) ?? data).replace(/"(color|bold|italic)":[^,}]+,?/g, '').slice(0, 300))
  })
  client.on('end', (r) => log.info('auth: conexão terminou', r, 'estado', client.state))
  client.on('show_dialog', (packet) => {
    const d = simplify(packet.dialog)
    if (!d || typeof d !== 'object') return
    const actions = (d.actions || []).map(a => a.action?.id || a.action?.command || '').filter(Boolean)
    log.info('auth: diálogo', JSON.stringify({ type: d.type, inputs: (d.inputs || []).map(i => ({ key: i.key, type: i.type, initial: i.initial })), actions }))
    const title = JSON.stringify(d.title || '').toLowerCase()
    // ids do nLogin: "nlogin:register/confirm", "nlogin:login/confirm" (o prefixo "nlogin" não conta)
    const verb = (a) => a.split(':').pop()
    const register = actions.find(a => /^register/i.test(verb(a))) || /criando uma senha|registr/.test(title)
    const login = actions.find(a => /^(login|auth)/i.test(verb(a)) && !/exit/.test(a))
    if (register && !login) {
      log.error('auth: servidor pediu REGISTRO (conta não existe com este nome). Não registro automaticamente.')
      return onFatal('register_required')
    }
    if (!login) { log.warn('auth: diálogo desconhecido', actions.join(',')); return }
    if (!config.password) { log.error('auth: diálogo de login e MC_PASSWORD vazio no .env'); return onFatal('no_password') }
    const value = {}
    for (const input of d.inputs || []) {
      if (/boolean/.test(input.type)) value[input.key] = nbt.byte(input.initial ? 1 : 0)
      else if (/text/.test(input.type) && /pass|senha|pwd/i.test(input.key)) value[input.key] = nbt.string(config.password)
      else if (/text/.test(input.type)) value[input.key] = nbt.string(String(input.initial || ''))
    }
    sendClickAction(client, login, value)
    log.info('auth: login enviado pelo diálogo')
  })
}

module.exports = { attach }
