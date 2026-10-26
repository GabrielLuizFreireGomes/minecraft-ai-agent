// Cria o esqueleto do vault "Minecraft AI Agent" (não sobrescreve notas existentes).
const fs = require('fs')
const path = require('path')
const { vaultDir } = require('../src/config')

const notes = {
  'Índice.md': `# Minecraft AI Agent

Memória durável do agente. Estado operacional frequente fica em \`data/state.json\` (projeto).

- [[Estado/Atual|Estado atual]] — posição, vida, inventário, objetivo
- [[Mundo/Locais|Locais]] — bases, aldeias, flecheiros, coordenadas
- [[Conhecimento/Negociações|Negociações]] · [[Conhecimento/Receitas|Receitas]] · [[Conhecimento/Mecânicas|Mecânicas]]
- [[Servidor/Servidor|Servidor]] — plugins, comandos, limitações
- [[Projetos/Esmeraldas|Projeto: esmeraldas]]
- [[Erros/Registro|Erros]] — problemas, soluções, tentativas falhas
- Histórico: pasta \`Histórico/\` (um arquivo por dia)
- [[Decisões/Decisões|Decisões]] — escolhas tomadas para não repetir pesquisa
- [[Decisões/Arquitetura|Arquitetura]]
`,
  'Estado/Atual.md': '# Estado atual\n\nVoltar: [[Índice]]\n\n(atualizado automaticamente pelo agente)\n',
  'Mundo/Locais.md': '# Locais\n\nVoltar: [[Índice]]\n\nFormato: nome x y z (dimensão) nota\n\n',
  'Conhecimento/Negociações.md': '# Negociações\n\nVoltar: [[Índice]]\n\n- flecheiro (novato): 32 gravetos → 1 esmeralda (vanilla; confirmar no servidor)\n- aldeão desempregado vira flecheiro ao reivindicar uma mesa de flechas (2 sílex + 4 tábuas)\n- aldeões reabastecem trocas até 2x por dia no posto de trabalho\n',
  'Conhecimento/Receitas.md': '# Receitas\n\nVoltar: [[Índice]]\n\n- 1 tronco → 4 tábuas; 2 tábuas → 4 gravetos (1 tronco = 8 gravetos)\n- mesa de trabalho: 4 tábuas · baú: 8 tábuas · fornalha: 8 pedregulhos\n- mesa de flechas: 2 sílex + 4 tábuas\n',
  'Conhecimento/Mecânicas.md': '# Mecânicas\n\nVoltar: [[Índice]]\n\n',
  'Servidor/Servidor.md': `# Servidor

Voltar: [[Índice]]

- host: caiosujinho.jogar.io — Paper 26.2 (protocolo 776)
- online-mode: **false** (confirmado em 2026-10-23); conta NapoLtz com plugin de /login
- regra: nada de fly/speed/exploits; não destruir construções de outros; sem OP
- mesmo nome não entra duas vezes ("Este jogador já está online") → bot só roda com o dono offline

## Comandos descobertos
`,
  'Projetos/Esmeraldas.md': `# Projeto: esmeraldas

Voltar: [[Índice]]

Objetivo: começar sem itens e ter fonte sustentável de esmeraldas vendendo gravetos a flecheiros.

## Etapas (missão \`emeralds\`)
1. wood — troncos
2. wooden_pickaxe
3. stone_tools — picareta, machado, espada de pedra
4. food — caça
5. find_village — exploração em pernas de 96 blocos
6. go_village (usa /home se disponível)
7. base — baú do agente + /sethome base
8. fletcher — achar flecheiro ou criar com mesa de flechas
9. trade_loop — madeira → gravetos → esmeraldas → baú (repete; espera reabastecer)

Progresso: ver [[Estado/Atual]] e \`Histórico/\`.
`,
  'Erros/Registro.md': '# Erros\n\nVoltar: [[Índice]]\n\n',
  'Decisões/Decisões.md': '# Decisões\n\nVoltar: [[Índice]]\n\n',
  'Decisões/Arquitetura.md': `# Arquitetura

Voltar: [[Índice]]

- **Bot**: Mineflayer 4.39 + dados 26.2 do PrismarineJS/minecraft-data (PR #1339, protocolo 776) injetados no postinstall. Mineflayer oficial só testa até 26.1.
- **Navegação/coleta**: mineflayer-pathfinder, collectblock, tool. Blocos de construção na lista de proibidos.
- **Execução local**: controlador planejar→executar→verificar→corrigir→registrar→continuar; checkpoint em data/state.json.
- **IA**: \`claude -p\` (assinatura) com --tools "" e --setting-sources project ≈1,3k tokens/chamada. Haiku para chat, Sonnet para etapas travadas (3 falhas iguais). Limite por hora.
- **Controle**: HTTP 127.0.0.1:3077 + MCP \`minecraft-agent\` (.mcp.json) + ctl.bat.
`
}

for (const [rel, content] of Object.entries(notes)) {
  const p = path.join(vaultDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (!fs.existsSync(p)) fs.writeFileSync(p, content)
}
console.log('vault ok:', vaultDir)
