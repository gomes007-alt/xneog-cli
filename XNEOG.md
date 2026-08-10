# xneog-cli — contexto do projeto

Cliente de terminal do **xneog-agentd** (daemon de sessões agentic). Um arquivo só:
`bin/xneog.mjs` (~900 linhas, Node puro, zero dependência). Publicado como `@xneog/cli`;
repo público (MIT no cliente, daemon é fechado).

## Como rodar e testar
- `node --check bin/xneog.mjs` — sintaxe (sempre antes de instalar).
- `node test-md.mjs` — máquina de estado do markdown no stream (7 casos).
- Instalar local: `npm i -g .` · empacotar: `npm pack`.
- No winserver: `scp` do tgz + `npm i -g <tgz>` (o box não tem git).

## Convenções desta base
- **Zero dependência de runtime.** Nada de framework TUI: readline puro. Se um recurso
  exigir Ink/blessed, é decisão de produto, não conveniência.
- Comentário explica **por que**, não o que; toda decisão contra-intuitiva tem a razão junto
  (é o que impede a próxima sessão de "consertar" de volta).
- Versão vive em DOIS lugares: `package.json` e `const VERSION` — bump nos dois.
- pt-BR em mensagens ao usuário; README público em inglês.

## Armadilhas já pagas (não repita)
- **Credencial de CONTA (`CFG.device`) precisa ser cidadã de primeira** em todo caminho que
  pergunta "tem credencial?" — `needKey` e `doctor` já quebraram por olhar só `CFG.key`;
  em máquina limpa (sem `~/.xneog/env` legado) isso mata todos os comandos.
- **`H.Authorization` é getter**: token v2 do device é cunhado por request (TTL 10min). Não
  transformar em string fixa — attach de horas expira no meio.
- **Markdown no stream** chega picado: `*` no fim do pedaço fica pendente até o próximo
  delta; `mdReset()` no fim do turno cospe o pendente.
- **Menu `/` usa ESC7/ESC8**: no rodapé do terminal o `\n` causa scroll e o restore volta
  errado — por isso só desenha com linhas livres, e qualquer evento do stream limpa antes.
- Sessão **morta** não conta como "viva" no `--continue` (retomar `dead` dava boot em cima
  de "sessão encerrada").
- Erro no browser-login **lança** (nunca `process.exit`): o `/login` de dentro da TUI não
  pode matar a sessão do usuário.

## O que NÃO fazer
- Não expor bypass global de aprovação (`--yolo`): a fila é server-side, por doutrina.
- Não gravar credencial antes de validar contra o daemon.
- Não imprimir segredo (token/secret) em log ou tela.
