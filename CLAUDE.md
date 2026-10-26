# Minecraft AI Agent

Agente Mineflayer (Paper 26.2, caiosujinho.jogar.io, conta NapoLtz, offline-mode + /login).

## Regras permanentes
- Survival legítimo: sem fly/speed/teleporte ilegítimo/exploits/pacotes alterados; não quebrar construções alheias; sem OP.
- Nunca ler, logar ou repetir MC_PASSWORD (.env). Nunca enviar segredos ao chat ou à IA.
- Chat: pt-br, minúsculas, curto, só responde quando falam com ele (src/chat.js).
- Economia de tokens: execução é local; IA (`claude -p`, src/ai.js) só para chat sem regra e etapa travada. Não chamar IA por movimento.
- Não usar API paga. Um agente Claude por vez.

## Onde está cada coisa
- Código: `src/` (controller.js = máquina de estados; missions/emeralds.js = missão 1; skills/ = ações determinísticas)
- Estado operacional: `data/state.json` · logs: `data/logs/`
- Memória durável: `vault/` (junction → vault Obsidian `minecraft/Minecraft AI Agent`). Comece por `vault/Índice.md`; leia só o arquivo relevante (Erros/Registro.md antes de depurar, Decisões/ antes de pesquisar).
- Plugins/comandos do servidor: `vault/Servidor/Plugins.md` (homes do dono home/roger/portal são intocáveis; bot só usa `/home base`).
- Lançar desacoplado da sessão do Claude (senão morre junto): `Invoke-CimMethod Win32_Process Create` com `cmd /c "cd /d <projeto> && node --env-file=.env src/index.js >> dataun.out 2>> dataun.err"`.
- Controle: `start.bat`, `ctl.bat status|pause|resume|stop`, MCP `minecraft-agent` (.mcp.json).
- 26.2: dados de `vendor/minecraft-data` (PR #1339) injetados por `scripts/patch-mcdata.js` no postinstall.
