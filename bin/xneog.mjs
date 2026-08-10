#!/usr/bin/env node
/**
 * xneog — CLI oficial do xneog-agentd (F5 do plano xNeog CLI, 24-jul-2026).
 *
 * Cliente de terminal do daemon de sessões agentic (:8802): a MESMA sessão é dirigida
 * daqui, do app iOS/macOS e de qualquer outro cliente do protocolo (PROTOCOL.md v1).
 * Engines: claude (first-party) · grok (jaula Seatbelt) · api (loop próprio via chat-api).
 *
 * Credenciais (BYOK), em ordem: ~/.xneog/config.json → env (XNEOG_BRIDGE/NATIVE_API_KEY)
 * → ~/.xneog/env (arquivo de env compartilhado do host, p/ operar sem login).
 * `xneog login` grava a config (0600); `--keychain` guarda a key no Keychain do macOS.
 *
 * Perfis de permissão (client-side → permissionMode do daemon):
 *   safe = default (toda ação com efeito colateral pede aprovação)
 *   edit = acceptEdits (edições e Bash de LEITURA entram sozinhos; escrita/rede/destrutivo pede)
 *   auto = o daemon aprova tudo, por sessão, com trilha de auditoria (revogável a quente)
 *   "full" NÃO existe de propósito: bypassPermissions não é exposto pelo daemon — a fila
 *   de aprovação é a razão da ponte existir (doutrina, enforce server-side).
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const HOME = homedir();
const CFG_DIR = `${HOME}/.xneog`;
const CFG_FILE = `${CFG_DIR}/config.json`;
const VERSION = "0.10.1";

const C = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m" };

// ── Markdown no stream (padrão Claude Code) ──────────────────────────────────────────────────
// Os deltas chegam em pedaços, então **negrito**, `código` e listas precisam de MÁQUINA DE
// ESTADO com 1 char de lookahead: um "*" ou "`" no fim do pedaço fica PENDENTE até o próximo
// delta decidir se era marcador. mdReset() no fim do turno cospe o pendente (nada some).
let _mdBold = false, _mdCode = false, _mdPend = "", _mdBol = true, _mdHdr = false;
function mdStream(t) {
  let out = "", buf = _mdPend + t; _mdPend = "";
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i], n = buf[i + 1];
    if (!_mdCode && c === "*" && n === undefined) { _mdPend = "*"; break; }          // pode virar ** no próximo delta
    if (!_mdCode && c === "*" && n === "*") { _mdBold = !_mdBold; out += _mdBold ? C.bold : C.reset; i++; continue; }
    if (c === "`") { _mdCode = !_mdCode; out += _mdCode ? C.cyan : C.reset; continue; }
    if (!_mdCode && _mdBol && (c === "-" || c === "*") && n === " ") { out += `${C.dim}•${C.reset}`; _mdBol = false; continue; }
    if (!_mdCode && _mdBol && c === "#") {                                            // # título → negrito ATÉ O FIM DA LINHA
      let j = i; while (buf[j] === "#") j++;
      if (buf[j] === " ") { out += C.bold; _mdBold = true; _mdHdr = true; i = j; _mdBol = false; continue; }
    }
    if (c === "\n" && _mdHdr) { out += C.reset; _mdBold = false; _mdHdr = false; }   // header não vaza pra linha seguinte
    _mdBol = c === "\n";
    out += c;
  }
  return out;
}
function mdReset() {
  let out = _mdPend; _mdPend = "";
  if (_mdBold || _mdCode) out += C.reset;
  _mdBold = _mdCode = _mdHdr = false; _mdBol = true;
  return out;
}

// ── credenciais: config → env → legado ───────────────────────────────────────
function loadEnvFile(p) {
  const o = {};
  if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
}
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CFG_FILE, "utf8")); } catch {}
  if (cfg.key === "@keychain") {
    try { cfg.key = execFileSync("security", ["find-generic-password", "-a", "xneog", "-s", "xneog-cli", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { cfg.key = ""; }
  }
  const legacy = loadEnvFile(`${CFG_DIR}/env`);
  return {
    base: process.env.XNEOG_BRIDGE || cfg.base || "http://127.0.0.1:8802",
    key: process.env.NATIVE_API_KEY || cfg.key || legacy.NATIVE_API_KEY || "",
    device: cfg.device || null,   // conta xNeog: {id, secret} do device pareado — token v2 por request
  };
}
// `xneog ls | head -1` fechava o pipe e o Node cuspia stack trace de EPIPE na cara do usuário
process.stdout.on("error", (e) => { if (e && e.code === "EPIPE") process.exit(0); });

// cmd.exe nasce em codepage 437 e o logo/❯ viram mojibake — o chcp muda o CP do console
// COMPARTILHADO, então rodar como filho conserta o pai. Silencioso e inofensivo fora do Windows.
if (process.platform === "win32") { try { execFileSync("chcp 65001", { stdio: "ignore", shell: true }); } catch {} }
const CFG = loadConfig();
function credencial() {
  if (CFG.device?.id && CFG.device?.secret) {
    const exp = Date.now() + 10 * 60 * 1000;
    const mac = createHmac("sha256", CFG.device.secret).update(`${CFG.device.id}.${exp}`).digest("hex");
    return `Bearer v2.${CFG.device.id}.${exp}.${mac}`;
  }
  return `Bearer ${CFG.key}`;
}
const H = { get Authorization() { return credencial(); }, "Content-Type": "application/json" };
const api = async (path, opts = {}, soft = false) => {
  let r;
  // timeout: daemon travado (aceita conexão e não responde) pendurava o comando pra sempre
  try { r = await fetch(`${CFG.base}${path}`, { headers: H, signal: AbortSignal.timeout(20000), ...opts }); }
  catch {
    // dentro do attach o stream reconecta sozinho — derrubar o processo perderia o composer e o draft
    if (soft) return { status: 0, json: null, text: "offline" };
    console.error(`${C.red}daemon não encontrado em ${CFG.base}${C.reset} — está rodando? suba com ${C.bold}xneog-agentd run${C.reset} (ou confira a URL: xneog login)`);
    process.exit(1);
  }
  if (r.status === 401 || r.status === 403) {
    console.error(`${C.red}credencial recusada pelo daemon (HTTP ${r.status})${C.reset} — a key mudou ou foi revogada. rode: ${C.bold}xneog login${C.reset}`);
    process.exit(1);
  }
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};
function needKey() {
  if (CFG.key || CFG.device?.id) return;   // conta (device) OU key de máquina
  console.error(`${C.red}sem credencial.${C.reset} rode: ${C.bold}xneog login${C.reset} (ou exporte NATIVE_API_KEY)`);
  process.exit(1);
}

// ── `xneog login` puro = padrão Claude Code: abre o browser, você autentica na sua conta
// (Google/Apple) e o terminal recebe a credencial SOZINHO por polling — zero copy-paste.
// Fallbacks: `--code XXXX` (colar código do web) · `--key/--keychain` ou `login maquina` (BYOK).
async function cmdLoginBrowser(baseFlag) {
  if (CFG.device?.id) {
    const quem = CFG.device.id;
    console.log(`${C.dim}já conectado (device ${quem}). Vou reconectar — a credencial atual será substituída.${C.reset}`);
  }
  const BFF = process.env.XNEOG_CONTA_BASE || "https://web.xneog.com";
  let st;
  try {
    const r = await fetch(`${BFF}/auth/cli/start`, { method: "POST" });
    st = await r.json();
    if (!r.ok || !st.code) throw new Error(st.error || `HTTP ${r.status}`);
  } catch (e) { throw new Error(`não conectou em ${BFF} (${e.message})`); }
  const abrir = process.platform === "darwin" ? ["open", [st.url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", st.url]]
    : ["xdg-open", [st.url]];
  try { execFileSync(abrir[0], abrir[1], { stdio: "ignore" }); } catch {}
  console.log(`${C.bold}Abra (ou já abriu) no browser:${C.reset} ${st.url}`);
  console.log(`${C.dim}código ${st.code} · aguardando você entrar na conta… (Ctrl-C cancela)${C.reset}`);
  const fim = Date.now() + (st.expiresInSec || 300) * 1000;
  while (Date.now() < fim) {
    await new Promise((r) => setTimeout(r, 2000));
    let j;
    try {
      const r2 = await fetch(`${BFF}/auth/cli/poll`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: st.code, poll: st.poll }) });
      j = await r2.json();
      if (r2.status === 404) throw new Error("login expirou — rode xneog login de novo");
    } catch { continue; }
    if (j && j.error && /expirad/i.test(j.error)) throw new Error("login expirou — rode xneog login de novo");
    if (j && j.deviceId && j.secret) {
      let atual = {}; try { atual = JSON.parse(readFileSync(CFG_FILE, "utf8")); } catch {}
      mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(CFG_FILE, JSON.stringify({ ...atual, base: j.base, device: { id: j.deviceId, secret: j.secret } }, null, 2), { mode: 0o600 });
      console.log(`${C.green}conectado à sua conta xNeog${C.reset} · ${j.tenant} · device ${j.deviceId}`);
      console.log(`${C.dim}pronto: xneog (retoma) · xneog ls · xneog new${C.reset}`);
      return;
    }
  }
  throw new Error("tempo esgotado — rode xneog login de novo");
}

// ── login de CONTA (padrão Claude Code): código gerado no web app → device pareado no
// agentd da cloud. Sem key na mão: o secret do device fica no config 0600 e cada request
// cunha um token v2 de 10min. `xneog login --code XXXX [--base https://agentd.xneog.com]`.
async function cmdLoginConta(code, baseFlag) {
  const b = (baseFlag || "https://agentd.xneog.com").replace(/\/$/, "");
  let r, j;
  try {
    r = await fetch(`${b}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim().toUpperCase(), name: `cli ${hostname()}`.slice(0, 60) }) });
    j = await r.json();
  } catch (e) { console.error(`${C.red}não conectou em ${b} (${e.message})${C.reset}`); process.exit(1); }
  if (!r.ok || !j.deviceId || !j.secret) {
    console.error(`${C.red}código recusado${C.reset} — ${j.error || `HTTP ${r.status}`}. Gere outro no web app (expira em 5min, uso único).`);
    process.exit(1);
  }
  mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  let atual = {}; try { atual = JSON.parse(readFileSync(CFG_FILE, "utf8")); } catch {}
  writeFileSync(CFG_FILE, JSON.stringify({ ...atual, base: b, device: { id: j.deviceId, secret: j.secret } }, null, 2), { mode: 0o600 });
  console.log(`${C.green}conectado à sua conta xNeog${C.reset} · device ${j.deviceId} · daemon ${b}`);
  console.log(`${C.dim}suas sessões: xneog ls · nova: xneog new --engine api · entrar: xneog attach <id>${C.reset}`);
}

// ── login (BYOK) ─────────────────────────────────────────────────────────────
async function cmdLogin(base, useKeychain, keyFlag) {
  let b = base, k = keyFlag;
  if (!b || !k) {   // interativo; --base/--key cobrem provisioning por script
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("close", () => {});   // EOF no meio: as asks resolvem "" e o fluxo falha limpo
    const ask = (q) => new Promise((res) => { rl.question(q, res); rl.once("close", () => res("")); });
    b = (b || await ask(`URL do daemon ${C.dim}[http://127.0.0.1:8802]${C.reset}: `)).trim() || "http://127.0.0.1:8802";
    k = (k || await ask(`API key do daemon (NATIVE_API_KEY): `)).trim();
    rl.close();
  }
  b = b || "http://127.0.0.1:8802"; k = (k || "").trim();
  if (!k) { console.error(`${C.red}key vazia — nada gravado${C.reset}`); process.exit(1); }
  // valida ANTES de gravar
  try {
    const r = await fetch(`${b}/meta`, { headers: { Authorization: `Bearer ${k}` } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const m = await r.json();
    console.log(`${C.green}ok:${C.reset} ${m.name} · protocol ${m.protocol} · ${m.capabilities.length} capabilities`);
  } catch (e) {
    console.error(`${C.red}não conectou em ${b}/meta (${e.message}) — nada gravado${C.reset}`); process.exit(1);
  }
  mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  let stored = k;
  if (useKeychain) {
    try {
      try { execFileSync("security", ["delete-generic-password", "-a", "xneog", "-s", "xneog-cli"], { stdio: "ignore" }); } catch {}
      execFileSync("security", ["add-generic-password", "-a", "xneog", "-s", "xneog-cli", "-w", k], { stdio: "ignore" });
      stored = "@keychain";
      console.log(`${C.dim}key no Keychain (serviço xneog-cli)${C.reset}`);
    } catch { console.log(`${C.yellow}Keychain falhou — gravando no arquivo (0600)${C.reset}`); }
  }
  writeFileSync(CFG_FILE, JSON.stringify({ base: b, key: stored }, null, 2) + "\n", { mode: 0o600 });
  console.log(`${C.green}config gravada:${C.reset} ${CFG_FILE}`);
}

// ── comandos simples ─────────────────────────────────────────────────────────
async function cmdLs() {
  const r = await api("/sessions");
  const ss = r.json?.sessions || [];
  if (!ss.length) return console.log("(sem sessões)");
  for (const s of ss) {
    const dot = s.connected ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
    const need = s.needsInput > 0 ? ` ${C.yellow}[requer entrada]${C.reset}` : "";
    const fila = s.queued > 0 ? ` ${C.dim}[${s.queued} na fila]${C.reset}` : "";
    const eng = s.engine && s.engine !== "claude" ? ` ${C.yellow}[${s.engine}]${C.reset}` : "";
    const titulo = s.aiTitle || s.title;
    console.log(`${dot} ${C.bold}${s.id}${C.reset}  ${titulo}${eng}${need}${fila}`);
    console.log(`   ${C.dim}${s.cwd} · ${s.turns} turnos · ${s.permissionMode}${s.model ? ` · ${s.model}` : ""}${C.reset}`);
  }
}
async function cmdMeta() {
  const r = await api("/meta");
  if (r.status !== 200) return console.error(`${C.red}${r.text}${C.reset}`);
  console.log(`${C.bold}${r.json.name}${C.reset} · protocol ${r.json.protocol}`);
  console.log(`${C.dim}${r.json.capabilities.join(" · ")}${C.reset}`);
}
async function cmdModels() {
  const r = await api("/models");
  if (r.status !== 200) return console.error(`${C.red}${r.text}${C.reset}`);
  for (const [k, e] of Object.entries(r.json.engines || {})) {
    const ok = e.available !== false;
    console.log(`${ok ? C.green + "●" : C.dim + "○"}${C.reset} ${C.bold}${k}${C.reset}  ${e.label || ""} ${C.dim}${(e.models || []).join(", ")}${C.reset}`);
    if (e.notes) console.log(`   ${C.dim}${e.notes}${C.reset}`);
  }
}
async function cmdImport(cs) {
  const r = await api("/sessions/import", { method: "POST", body: JSON.stringify({ claudeSession: cs }) });
  if (r.status === 409) return console.log(`${C.yellow}já importada:${C.reset} ${r.json.id}`);
  if (r.status !== 200) return console.error(`${C.red}${r.text}${C.reset}`);
  console.log(`${C.green}importada:${C.reset} ${r.json.id} · "${r.json.title}" · ${r.json.events} eventos · reviveável`);
}
const PROFILES = { safe: "default", edit: "acceptEdits", auto: "auto" };
async function cmdNew(cwd, { title, engine, model, profile }) {
  if (profile && !PROFILES[profile]) return console.error(`${C.red}perfil inválido${C.reset} — use safe|edit|auto (auto = daemon aprova tudo sozinho, com auditoria)`);
  const body = { cwd: cwd || process.cwd(), title: title || "" };
  if (engine) body.engine = engine;
  if (model) body.model = model;
  if (profile) body.permissionMode = PROFILES[profile];
  const r = await api("/sessions", { method: "POST", body: JSON.stringify(body) });
  if (r.status !== 200) {
    if (r.status === 429 && /limite de sess/.test(r.text || "")) throw new Error(r.text);
    return console.error("falhou:", r.text);
  }
  const eng = r.json.engine && r.json.engine !== "claude" ? ` ${C.yellow}[${r.json.engine}]${C.reset}` : "";
  console.log(`${C.green}sessão ${r.json.id}${C.reset}${eng} em ${r.json.cwd}`);
  await cmdAttach(r.json.id);
}

// ── render de eventos (paridade com o app) ───────────────────────────────────
function renderDiff(inputStr) {
  let o; try { o = JSON.parse(inputStr || "{}"); } catch { return false; }
  const edits = Array.isArray(o.edits) ? o.edits : [o];
  let shown = 0, any = false;
  if (o.file_path) process.stdout.write(`${C.dim}  ${o.file_path}${C.reset}\n`);
  for (const ed of edits) {
    const oldS = ed.old_string ?? "", newS = ed.new_string ?? ed.content ?? "";
    if (!oldS && !newS) continue;
    any = true;
    for (const l of String(oldS).split("\n")) { if (++shown > 80) { process.stdout.write(`${C.dim}  ⋯${C.reset}\n`); return true; } process.stdout.write(`${C.red}  - ${l}${C.reset}\n`); }
    for (const l of String(newS).split("\n")) { if (++shown > 160) { process.stdout.write(`${C.dim}  ⋯${C.reset}\n`); return true; } process.stdout.write(`${C.green}  + ${l}${C.reset}\n`); }
  }
  return any;
}
let STATUS = "";   // "engine · modelo" — rodapé direito do turn_end (setado no banner)
// Gasto acumulado DESTA sessão de terminal (o daemon manda usage medido em cada turn_end).
const GASTO = { turnos: 0, in: 0, out: 0, usd: 0, modelos: new Set() };
let _limpaDicaHook = null;   // setado pelo attach: evento do stream apaga o menu "/" antes de escrever
function render(e) {
  if (_limpaDicaHook) _limpaDicaHook();
  switch (e.kind) {
    // o readline JÁ ecoou o que você digitou aqui — reimprimir dava tudo em dobro. Do app/outro
    // cliente, imprime (é a única forma de ver o que foi mandado de fora).
    case "user":
      if (e.via === "terminal") break;
      process.stdout.write(`\n${C.cyan}❯ ${e.text}${C.reset} ${C.dim}(${e.via === "app" ? "do app" : "de outro cliente"})${C.reset}\n`);
      break;
    case "delta": process.stdout.write(mdStream(e.text || "")); break;   // limpaDica roda no render()
    case "text":  process.stdout.write(mdReset()); break;   // o delta já imprimiu
    case "tool_use": {
      let d = ""; try { const o = JSON.parse(e.input || "{}"); d = o.description || o.file_path || o.command || o.pattern || ""; } catch {}
      process.stdout.write(`\n${C.dim}  ⚙ ${e.tool}${d ? ` · ${String(d).slice(0, 60)}` : ""}${C.reset}\n`);
      break;
    }
    case "task":
      process.stdout.write(`\n${C.bold}◆ ${e.name}${C.reset} ${C.dim}${e.tool === "Workflow" ? "workflow" : "agente"}${e.desc ? ` · ${e.desc}` : ""}${C.reset}\n`);
      break;
    case "permission_request": {
      const edicao = ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(e.tool);
      // "sempre" NÃO existe para Bash & cia (NEVER_ALWAYS no daemon) — oferecer [a] era promessa falsa
      const semAlways = ["Bash", "KillShell", "KillBash", "BashOutput"].includes(e.tool);
      const extra = edicao ? `  ${C.cyan}[e] aceitar edições (lote)${C.reset}` : "";
      process.stdout.write(`\x07\n${C.yellow}⌘ APROVAR ${e.tool}${C.reset}\n`);   // bell: você pode estar em outra aba
      if (!(edicao && renderDiff(e.input))) {
        // comando INTEIRO (truncar sem avisar = aprovar o que você não viu)
        let txt = e.input || "";
        try { const o = JSON.parse(txt); if (o.command) txt = o.command; } catch {}
        const cap = 1200;
        process.stdout.write(`${C.dim}${txt.slice(0, cap)}${txt.length > cap ? ` ⋯ +${txt.length - cap} chars` : ""}${C.reset}\n`);
      }
      process.stdout.write(`${C.yellow}[y] sim  [n] não${semAlways ? "" : "  [a] sempre nesta sessão"}${C.reset}${extra}`);
      process.stdout.write(` ${C.dim}· ou aprove no iPhone (push enviado) · sem resposta em 120s = negado${C.reset}\n`);
      break;
    }
    case "bulk_resolved":
      process.stdout.write(`\n${C.green}lote: ${e.resolved} ${e.approve ? "aprovada(s)" : "negada(s)"}${e.always ? " · edições liberadas nesta sessão" : ""}${C.reset}\n`);
      break;
    case "queued":
      process.stdout.write(`\n${C.dim}⏳ na fila (${e.depth}): ${String(e.text || "").slice(0, 60)}${C.reset}\n`);
      break;
    case "init":            // modelo REAL da sessão (o banner só sabia a preferência gravada)
      if (e.model) { STATUS = `${STATUS.split(" · ")[0]} · ${e.model.replace(/^claude-/, "")}`;
        process.stdout.write(`${C.dim}▎ modelo: ${e.model}${C.reset}\n`); }
      break;
    case "tool_result": {   // sem isto, erro de ferramenta era invisível: o turno parava sem motivo
      const out = String(e.output || "").trim();
      if (!out) break;
      const cor = e.isError ? C.red : C.dim;
      const linhas = out.split("\n");
      const corte = linhas.slice(0, e.isError ? 12 : 4);
      process.stdout.write(corte.map(l => `${cor}  │ ${l.slice(0, 160)}${C.reset}`).join("\n") + "\n");
      if (linhas.length > corte.length) process.stdout.write(`${C.dim}  │ ⋯ +${linhas.length - corte.length} linhas${C.reset}\n`);
      break;
    }
    case "command":         // slash command local resolvido pelo CLI (chip, não bolha)
      process.stdout.write(`\n${C.cyan}${e.name}${C.reset}${e.output ? `\n${C.dim}${String(e.output).slice(0, 800)}${C.reset}` : ""}\n`);
      break;
    case "session_revived":
      process.stdout.write(`${C.green}sessão reanimada com histórico${C.reset}\n`);
      break;
    case "queue_removed":
      process.stdout.write(`${C.dim}removido da fila (${e.depth} restante(s))${C.reset}\n`);
      break;
    case "queue_cleared":
      process.stdout.write(`\n${C.dim}fila descartada (${e.dropped}) · ${e.reason}${C.reset}\n`);
      break;
    case "permission_resolved":
      process.stdout.write(`${e.approved ? C.green + "aprovado" : C.red + "negado"}${C.reset} ${C.dim}(${{app: "por você no app", "app-bulk": "em lote pelo app", auto: "auto-aprovado · auditado", "auto-read": "leitura · auto-aprovado", always: "grant desta sessão", timeout: "TIMEOUT de 120s — ninguém respondeu"}[e.by] || `por ${e.by}`})${C.reset}\n`);
      break;
    case "turn_end": {
      process.stdout.write(mdReset());
      const rest = e.next ? ` · próxima da fila entrando${e.queued ? ` (${e.queued} atrás)` : ""}` : "";
      if (e.model && e.usage) {   // engine api: número MEDIDO, nunca estimado no cliente
        GASTO.turnos++; GASTO.in += (e.usage.in || 0) + (e.usage.cacheR || 0) + (e.usage.cacheW || 0); GASTO.out += e.usage.out || 0;
        GASTO.modelos.add(e.model.replace(/^claude-/, "").replace(/-\d{8}$/, ""));
        const PRECO = { "claude-haiku-4-5": [1, 5], "claude-sonnet-5": [3, 15], "claude-opus-5": [15, 75], "claude-fable-5": [20, 100] };
        const b = Object.keys(PRECO).find((k) => e.model.startsWith(k));
        const u = e.usage, inTot = (u.in || 0) + (u.cacheR || 0) + (u.cacheW || 0);
        const custo = b ? ((u.in || 0) * PRECO[b][0] + (u.cacheW || 0) * PRECO[b][0] * 1.25 + (u.cacheR || 0) * PRECO[b][0] * 0.1 + (u.out || 0) * PRECO[b][1]) / 1e6 : null;
        const kf = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
        if (custo != null) GASTO.usd += custo;
        STATUS = `api · ${e.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")} · ${kf(inTot)}/${kf(u.out || 0)}${custo != null ? ` · $${custo.toFixed(4)}` : ""}`;
      }
      const left = `— turno concluído${e.durationMs ? ` em ${Math.round(e.durationMs / 1000)}s` : ""}${rest}`;
      const pad = Math.max(1, cols() - left.length - STATUS.length - 1);
      process.stdout.write(`\n${C.dim}${left}${" ".repeat(pad)}${STATUS}${C.reset}\n${e.next ? "" : `${C.cyan}❯ ${C.reset}`}`);
      break;
    }
    case "presence":
      if (typeof e.app === "number") process.stdout.write(`\n${C.dim}▪ app ${e.app > 0 ? "acompanhando ao vivo" : "saiu"} · ${e.app} app / ${e.terminal} terminal${C.reset}\n`);
      break;
    case "session_end": process.stdout.write(`\n${C.red}sessão encerrada${C.reset}\n`); break;
    case "mode_changed":  process.stdout.write(`\n${C.dim}modo → ${e.mode}${C.reset}\n`); break;
    case "model_changed": STATUS = `${STATUS.split(" · ")[0]}${e.model ? ` · ${e.model}` : ""}`; process.stdout.write(`\n${C.dim}modelo → ${e.model || "padrão"}${C.reset}\n`); break;
  }
}
// ── boot banner (padrão dos CLIs de referência: logo compacta + ficha + avisos acionáveis) ──
const cols = () => Math.min(process.stdout.columns || 80, 100);
const hr = () => console.log(`${C.dim}${"─".repeat(cols())}${C.reset}`);
function banner(S) {
  const home = process.env.HOME || "";
  const cwd = S.cwd.startsWith(home) ? "~" + S.cwd.slice(home.length) : S.cwd;
  const engine = S.engine || "claude";
  const engC = engine === "grok" ? C.yellow : engine === "api" ? C.cyan : C.green;
  const modelo = S.model || "padrão";
  const modo = S.permissionMode === "acceptEdits" ? "edições + leitura"
             : S.permissionMode === "plan" ? "modo do plano"
             : S.permissionMode === "jail" ? "jaula"
             : S.permissionMode === "auto" ? `${C.yellow}AUTO-APROVA${C.reset}${C.dim}` : "aprovação";
  console.log("");
  console.log(` ${C.cyan}▚▞${C.reset}  ${C.bold}xneog${C.reset} v${VERSION} ${C.dim}·${C.reset} ${engC}${engine}${C.reset} ${C.dim}— ${modelo} · ${modo}${C.reset}`);
  console.log(` ${C.cyan}▞▚${C.reset}  ${C.dim}${cwd} · sessão ${S.id}${(S.aiTitle || S.title) ? ` “${(S.aiTitle || S.title).slice(0, 46)}”` : ""}${C.reset}`);
  console.log("");
  if (S.needsInput > 0)
    console.log(` ${C.yellow}⚠ aprovação pendente nesta sessão — responda y/n/a/e${C.reset}`);
  if (!S.connected && engine === "claude")
    console.log(` ${C.dim}▪ sessão adormecida — renasce sozinha (com histórico) na próxima mensagem${C.reset}`);
  if (S.queued > 0)
    console.log(` ${C.dim}⏳ ${S.queued} mensagem(ns) na fila${C.reset}`);
  console.log(` ${C.dim}▎ "/" menu · """ multiline · y/n/a/e aprovação · /q sai — a sessão continua (o app iOS vê a mesma)${C.reset}`);
  hr();
  STATUS = `${engine}${S.model ? ` · ${S.model}` : ""}`;
}

// ── attach: streaming + composer ─────────────────────────────────────────────
async function cmdAttach(id) {
  const chk = await api(`/sessions`);
  const S = (chk.json?.sessions || []).find(s => s.id === id || s.id.startsWith(id));
  if (!S) return console.error(`sessão ${id} não existe`);
  id = S.id;
  banner(S);

  // FILA de aprovações, não uma só: o modelo dispara tools em paralelo e o app pode resolver uma
  // enquanto outra segue pendente. Com uma variável única, o "y" caía na aprovação errada — ou virava
  // MENSAGEM pro modelo depois que o app resolveu a única que o terminal conhecia.
  const pending = [];
  let RL = null;          // readline (nasce depois do stream): redesenho da linha em edição
  let sawDelta = false;

  // cursor = `seq` da sessão (id monotônico do daemon). `count` é só o tamanho do buffer e NUNCA é
  // comparável com `i` — deltas consomem seq sem entrar no buffer; usar count despejava a sessão inteira.
  let from = Math.max(0, (S.seq || 0) - 40);
  let backoff = 1000;
  let live = false;   // fronteira histórico↔ao vivo (o replay do daemon vem antes)
  (async function stream() {
    for (;;) {
      try {
        const res = await fetch(`${CFG.base}/sessions/${id}/stream?from=${from}&client=terminal`, { headers: { Authorization: H.Authorization } });
        if (res.status === 404) { console.log(`\n${C.red}sessão ${id} não existe mais${C.reset}`); process.exit(0); }
        if (res.status === 401 || res.status === 403) { console.log(`\n${C.red}credencial recusada no stream (HTTP ${res.status})${C.reset} — rode: xneog login`); process.exit(1); }
        if (res.status === 429) { console.log(`\n${C.yellow}limite de streams desta sessão (8) — feche outro terminal ou o app e tente de novo${C.reset}`); }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        backoff = 1000;
        sawDelta = false;   // reconectou: o texto consolidado do replay precisa aparecer (delta não volta)
        let buf = "";
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString("utf8");
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const f of frames) {
            const line = f.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
            if (typeof e.i === "number") from = e.i + 1;
            if (e.kind === "delta") sawDelta = true;
            if (e.kind === "user") sawDelta = false;
            // primeiro evento AO VIVO depois do replay: marca a fronteira (senão o attach parece
            // que o agente está trabalhando quando na verdade você está lendo o passado)
            if (!live && (e.kind === "turn_end" || e.kind === "permission_request" || e.kind === "delta")) {
              live = true; process.stdout.write(`${C.dim}${"─".repeat(Math.max(10, cols() - 10))} ao vivo${C.reset}\n`);
            }
            if (e.kind === "text" && !sawDelta) { process.stdout.write(`\n${e.text || ""}\n`); continue; }
            if (e.kind === "permission_request") pending.push(e.requestId);
            if (e.kind === "permission_resolved") { const k = pending.indexOf(e.requestId); if (k >= 0) pending.splice(k, 1); }
            try { render(e); } catch (err) { if (process.env.XNEOG_DEBUG) console.error(err); }
            // redesenha a linha que você está digitando (o evento passou por cima dela)
            if (RL && e.kind !== "delta") RL.prompt(true);
          }
        }
        await new Promise(r => setTimeout(r, 250));   // fim limpo (sessão morta): não refazer fetch em busy-loop
      } catch {
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  })();

  let cmdMenu = [];
  api("/commands").then(r => { cmdMenu = r.json?.menu || []; }).catch(() => {});
  const LOCAL = [
    { cmd: "/model",   desc: "troca o modelo (sonnet|opus|fable|haiku)" },
    { cmd: "/mode",    desc: "troca o modo (default|acceptEdits|plan|auto)" },
    { cmd: "/compact", desc: "resume o histórico e continua mais leve/barato" },
    { cmd: "/stop",    desc: "cancela o turno atual (a sessão sobrevive)" },
    { cmd: "/tasks",   desc: "subagentes/workflows da sessão (com fases)" },
    { cmd: "/sessions", desc: "lista suas sessões e troca pra outra sem sair" },
    { cmd: "/init",    desc: "cria o XNEOG.md deste projeto (contexto que o agente lê)" },
    { cmd: "/cost",    desc: "gasto acumulado desta sessão (tokens e US$)" },
    { cmd: "/conta",   desc: "quem sou: credencial, device e daemon" },
    { cmd: "/login",   desc: "conecta este terminal à sua conta (browser)" },
    { cmd: "/q",       desc: "sai (a sessão continua viva no servidor)" },
  ];
  // universo de comandos pro autocomplete (locais + os do daemon que vão como mensagem)
  const todosCmds = () => [...LOCAL, ...cmdMenu.filter(x => x.scope === "both").map(x => ({ cmd: x.cmd, desc: (x.desc || "").slice(0, 46) }))];
  function printMenu() {
    for (const m of LOCAL) process.stdout.write(`${C.cyan}${m.cmd.padEnd(9)}${C.reset} ${C.dim}${m.desc}${C.reset}\n`);
    for (const m of cmdMenu.filter(x => x.scope === "both")) process.stdout.write(`${C.cyan}${m.cmd.padEnd(9)}${C.reset} ${C.dim}${m.desc} (vai como mensagem)${C.reset}\n`);
  }

  // Tab completa comando de "/" (prefixo comum) e, ambíguo, lista as opções — idioma universal
  // de terminal (bash/openclaude). Só age quando a linha é um "/foo" sem espaço.
  function completer(line) {
    if (!line.startsWith("/") || line.includes(" ")) return [[], line];
    const nomes = todosCmds().map(c => c.cmd).filter(c => c.startsWith(line));
    return [nomes.length ? nomes : [], line];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.cyan}❯ ${C.reset}`, completer });
  RL = rl;
  rl.on("close", () => process.exit(0));
  // Ctrl-C = reflexo universal de "para isso" → interrompe o TURNO (a sessão vive). 2º Ctrl-C sai.
  let sigints = 0;
  rl.on("SIGINT", async () => {
    if (++sigints >= 2) { process.stdout.write(`\n${C.dim}saindo — a sessão continua no Mac${C.reset}\n`); process.exit(0); }
    setTimeout(() => { sigints = 0; }, 3000);
    process.stdout.write(`\n${C.dim}interrompendo o turno… (Ctrl-C de novo p/ sair · /q desconecta)${C.reset}\n`);
    await api(`/sessions/${id}/interrupt`, { method: "POST" }, true);
    rl.prompt();
  });
  // Dica ao vivo (padrão Claude Code): conforme digita "/", mostra os comandos que casam numa
  // linha abaixo do cursor via save/restore de cursor (ESC7/ESC8) — não toca no que você escreveu.
  // Some quando a linha não é mais um "/foo". Guardado em try: um terminal exótico nunca quebra o input.
  // Menu de "/" ao vivo (padrão Claude Code): duas colunas — comando (ciano) + descrição (dim) —
  // desenhadas ABAIXO do cursor via save/restore (ESC7/ESC8), filtrando a cada tecla. Abaixo em
  // vez de acima porque em readline cru é o único lado seguro (não briga com o redraw do input).
  let dicaLinhas = 0;
  function limpaDica() {
    if (!dicaLinhas) return;
    try { let out = "\x1b7"; for (let i = 0; i < dicaLinhas; i++) out += "\n\x1b[2K"; out += "\x1b8"; process.stdout.write(out); } catch {}
    dicaLinhas = 0;
  }
  function redesenhaDica() {
    try {
      // No RODAPÉ do terminal os \n do menu fazem SCROLL: a posição salva por ESC7 sobe junto e
      // o ESC8 devolve o cursor pro lugar errado (menu órfão, prompt sobrescrito). Só desenha
      // quando há linhas livres abaixo — senão, dica de uma linha só (que não rola).
      const linhasLivres = (process.stdout.rows || 24) - 2;
      if (linhasLivres < 3) { limpaDica(); return; }
      const l = (rl.line || "").trimStart();
      if (!l.startsWith("/") || l.includes(" ")) { limpaDica(); return; }
      const m = todosCmds().filter(c => c.cmd.startsWith(l)).slice(0, 8);
      limpaDica();
      if (!m.length) return;
      const w = Math.max(...m.map(c => c.cmd.length));
      let out = "\x1b7";
      for (const c of m) out += `\n\x1b[2K  ${C.cyan}${c.cmd.padEnd(w)}${C.reset}  ${C.dim}${c.desc || ""}${C.reset}`;
      out += "\x1b8";
      process.stdout.write(out);
      dicaLinhas = m.length;
    } catch {}
  }
  _limpaDicaHook = limpaDica;
  try {
    process.stdin.on("keypress", () => { if (!ml) setImmediate(redesenhaDica); });
  } catch {}
  rl.prompt();
  const PROMPT = `${C.cyan}❯ ${C.reset}`, PROMPT_ML = `${C.dim}… ${C.reset}`;
  const send = async (text) => {
    const r = await api(`/sessions/${id}/message`, { method: "POST", body: JSON.stringify({ text, via: "terminal" }) }, true);
    if (r.status !== 200) console.error(`${C.red}falhou: ${r.text}${C.reset}`);
  };
  let ml = null;   // { mode: "fence"|"bslash", lines: [] }
  // PASTE: colar um log de 10 linhas disparava 1 turno + 9 na fila. O readline entrega uma linha
  // por vez e não avisa que foi paste; rajada (<45ms entre linhas) = colagem → vira UM turno só.
  // Custo p/ quem digita: 45ms imperceptíveis antes de enviar.
  let burst = [], burstT = null;
  rl.on("line", (raw) => {
    limpaDica();
    burst.push(raw);
    clearTimeout(burstT);
    burstT = setTimeout(async () => {
      const linhas = burst; burst = []; burstT = null;
      if (linhas.length > 1 && !ml) {         // colagem fora do bloco """: um turno com tudo
        const texto = linhas.join("\n").trim();
        process.stdout.write(`${C.dim}(colado: ${linhas.length} linhas → 1 turno)${C.reset}\n`);
        if (texto) await send(texto);
        return rl.prompt();
      }
      for (const l of linhas) await handleLine(l);
    }, 45);
  });

  async function handleLine(raw) {
    if (ml) {
      if (ml.mode === "fence") {
        if (raw.trim() === '"""') {
          const text = ml.lines.join("\n"); ml = null; rl.setPrompt(PROMPT);
          if (text.trim()) await send(text);
        } else ml.lines.push(raw);
        return rl.prompt();
      }
      const r0 = raw.trimEnd();
      if (r0.endsWith("\\")) { ml.lines.push(r0.slice(0, -1)); return rl.prompt(); }
      ml.lines.push(raw);
      const text = ml.lines.join("\n"); ml = null; rl.setPrompt(PROMPT);
      if (text.trim()) await send(text);
      return rl.prompt();
    }
    const t = raw.trim();
    if (t === '"""') {
      ml = { mode: "fence", lines: [] }; rl.setPrompt(PROMPT_ML);
      process.stdout.write(`${C.dim}(multiline — feche com """ numa linha só)${C.reset}\n`);
      return rl.prompt();
    }
    if (!t.startsWith("/") && t !== "\\" && raw.trimEnd().endsWith("\\")) {
      ml = { mode: "bslash", lines: [raw.trimEnd().slice(0, -1)] }; rl.setPrompt(PROMPT_ML);
      return rl.prompt();
    }
    if (t === "/q") { rl.close(); process.exit(0); }
    if (t === "/" || t === "/help") { printMenu(); return rl.prompt(); }
    if (t.startsWith("/model")) {
      const m = t.split(/\s+/)[1] || "";
      if (!m) { process.stdout.write(`${C.dim}uso: /model sonnet|opus|fable|haiku (ou claude-* p/ engine api)${C.reset}\n`); return rl.prompt(); }
      const r = await api(`/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model: m }) }, true);
      if (r.status !== 200) console.error(`${C.red}${r.text}${C.reset}`);
      return rl.prompt();
    }
    if (t.startsWith("/mode")) {
      const m = t.split(/\s+/)[1] || "";
      if (!m) { process.stdout.write(`${C.dim}uso: /mode default|acceptEdits|plan|auto${C.reset}\n`); return rl.prompt(); }
      const r = await api(`/sessions/${id}/mode`, { method: "POST", body: JSON.stringify({ mode: m }) }, true);
      if (r.status !== 200) console.error(`${C.red}${r.text}${C.reset}`);
      return rl.prompt();
    }
    if (t === "/sessions" || t === "/resume") {
      const r = await api("/sessions", {}, true);
      const ss = (r.json?.sessions || []).filter(x => x.archived !== true && x.status !== "dead").sort((a, b) => b.lastTs - a.lastTs);
      if (!ss.length) { process.stdout.write(`${C.dim}nenhuma outra sessão viva${C.reset}\n`); return rl.prompt(); }
      ss.forEach((x, i) => {
        const eu = x.id === id ? ` ${C.green}(esta)${C.reset}` : "";
        const idade = x.lastTs ? `${Math.round((Date.now() - x.lastTs) / 60000)}min` : "—";
        const flag = x.needsInput > 0 ? ` ${C.yellow}[requer entrada]${C.reset}` : x.queued > 0 ? ` ${C.dim}[${x.queued} na fila]${C.reset}` : "";
        process.stdout.write(`  ${C.bold}${i + 1}${C.reset} ${x.id}  ${C.dim}${(x.title || x.engine || "").slice(0, 40)} · ${x.engine || "claude"} · ${idade}${C.reset}${flag}${eu}\n`);
      });
      const esc = await new Promise((res) => rl.question(`${C.dim}número pra entrar (Enter cancela): ${C.reset}`, res));
      const alvo = ss[Number(esc.trim()) - 1];
      if (!alvo || alvo.id === id) return rl.prompt();
      // Troca = RE-EXEC: o attach carrega stream, readline e fila de aprovação; reaproveitar
      // esse estado pra outra sessão é fonte garantida de stream duplicado. Processo novo é
      // barato e limpo; ao sair dele, este também sai (nada empilha na volta).
      process.stdout.write(`${C.dim}entrando em ${alvo.id}…${C.reset}\n`);
      rl.close();
      const rc = spawnSync(process.execPath, [process.argv[1], "attach", alvo.id], { stdio: "inherit" });
      process.exit(rc.status ?? 0);
    }
    if (t === "/init") {
      // Padrão Claude Code: pede pro próprio agente escrever o arquivo de contexto — ele já
      // tem as tools (Glob/Read/Write) e enxerga a pasta melhor que um template genérico.
      await send("Crie o arquivo XNEOG.md nesta pasta (ou atualize se já existir). Antes, explore com Glob/Read o que há aqui. O arquivo é o contexto que VOCÊ vai ler em toda sessão futura: o que é este projeto, como rodar/testar, convenções de código, armadilhas conhecidas e o que NÃO fazer. Denso e específico, sem encher linguiça. Depois de escrever, resuma em 3 linhas o que colocou.");
      return rl.prompt();
    }
    if (t === "/cost") {
      const kf = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
      if (!GASTO.turnos) process.stdout.write(`${C.dim}nenhum turno medido nesta sessão de terminal ainda${C.reset}\n`);
      else process.stdout.write(`${C.bold}${GASTO.turnos} turno${GASTO.turnos > 1 ? "s" : ""}${C.reset} · ${kf(GASTO.in)} in / ${kf(GASTO.out)} out · ${C.bold}$${GASTO.usd.toFixed(4)}${C.reset} ${C.dim}(${[...GASTO.modelos].join(", ")} · só o que este terminal viu)${C.reset}\n`);
      return rl.prompt();
    }
    if (t === "/conta") {
      const quem = CFG.device?.id ? `conta xNeog · device ${CFG.device.id}` : "key de máquina (BYOK)";
      process.stdout.write(`${C.dim}${quem} · daemon ${CFG.base}${C.reset}\n`);
      return rl.prompt();
    }
    if (t.startsWith("/login")) {
      const code = t.split(/\s+/)[1] || "";
      if (!code) {
        process.stdout.write(`${C.dim}abrindo o browser pra autenticar… (ou /login <código>)${C.reset}\n`);
        try { await cmdLoginBrowser(); process.stdout.write(`${C.green}credencial trocada — /q e reabra pra usar a conta nova${C.reset}\n`); }
        catch (e2) { process.stdout.write(`${C.red}${e2.message}${C.reset}\n`); }
        return rl.prompt();
      }
      try {
        const b = (CFG.base.startsWith("http://127.") ? "https://agentd.xneog.com" : CFG.base).replace(/\/$/, "");
        const r = await fetch(`${b}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.toUpperCase(), name: `cli ${hostname()}`.slice(0, 60) }) });
        const j = await r.json();
        if (!r.ok || !j.deviceId || !j.secret) throw new Error(j.error || `HTTP ${r.status}`);
        let atual = {}; try { atual = JSON.parse(readFileSync(CFG_FILE, "utf8")); } catch {}
        mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(CFG_FILE, JSON.stringify({ ...atual, base: b, device: { id: j.deviceId, secret: j.secret } }, null, 2), { mode: 0o600 });
        CFG.base = b; CFG.device = { id: j.deviceId, secret: j.secret };
        process.stdout.write(`${C.green}conectado à sua conta${C.reset} · device ${j.deviceId} — sessões sincronizadas com o web/app\n`);
      } catch (e2) { process.stdout.write(`${C.red}não deu: ${e2.message}${C.reset} (código expira em 5min, uso único)\n`); }
      return rl.prompt();
    }
    if (t === "/stop") { await api(`/sessions/${id}/interrupt`, { method: "POST" }, true); return rl.prompt(); }
    if (t === "/tasks") {
      const r = await api(`/sessions/${id}/tasks`, {}, true);
      const runs = r.json?.runs || [];
      if (!runs.length) process.stdout.write(`${C.dim}(sem subagentes nesta sessão)${C.reset}\n`);
      for (const run of runs) {
        process.stdout.write(`${C.bold}◆ ${run.name}${C.reset} ${C.dim}${run.done}/${run.total}${run.description ? ` · ${run.description}` : ""}${C.reset}\n`);
        const pp = run.phaseProgress || [];
        const agentLine = (a, ind) => {
          const dot = a.running ? `${C.yellow}●${C.reset}` : `${C.green}●${C.reset}`;
          process.stdout.write(`${ind}${dot} ${a.label.slice(0, 56).padEnd(58)} ${C.dim}${a.model} · ${Math.round(a.tokens / 1000)}k tok${C.reset}\n`);
        };
        if (pp.length) {
          for (const p of pp) {
            const ok = p.done === p.total;
            process.stdout.write(`  ${ok ? `${C.green}✔${C.reset}` : `${C.yellow}▸${C.reset}`} ${C.bold}${p.title}${C.reset} ${C.dim}${p.done}/${p.total}${C.reset}\n`);
            for (const a of run.agents.filter(x => x.phase === p.title)) agentLine(a, "    ");
          }
          for (const a of run.agents.filter(x => !pp.some(p => p.title === x.phase))) agentLine(a, "  ");
        } else {
          for (const a of run.agents) agentLine(a, "  ");
        }
      }
      return rl.prompt();
    }
    if (pending.length && t.toLowerCase() === "e") {
      // o lote do daemon só resolve a família de EDIÇÃO — se nada foi resolvido, o pendente segue vivo
      const r = await api(`/sessions/${id}/permission/bulk`, { method: "POST", body: JSON.stringify({ approve: true, always: true }) }, true);
      const n = r.json?.resolved ?? 0;
      if (!n) process.stdout.write(`${C.dim}nada em lote (Bash não entra em "sempre") — responda y/n${C.reset}\n`);
      return rl.prompt();
    }
    if (pending.length && ["y", "n", "a"].includes(t.toLowerCase())) {
      const approve = t.toLowerCase() !== "n";
      const always = t.toLowerCase() === "a";
      const rid = pending[0];   // FIFO: responde o pedido mais antigo, não "o último visto"
      const r = await api(`/sessions/${id}/permission`, { method: "POST", body: JSON.stringify({ requestId: rid, approve, always }) }, true);
      if (r.status !== 200) {
        process.stdout.write(`${C.dim}essa aprovação já tinha sido resolvida (timeout de 120s ou outro cliente)${C.reset}\n`);
        const k = pending.indexOf(rid); if (k >= 0) pending.splice(k, 1);
      }
      return rl.prompt();
    }
    if (!t) return rl.prompt();
    await send(t);
    rl.prompt();
  }
}


// ── headless: manda um prompt pra sessão VIVA deste diretório e sai ─────────
// Nenhum concorrente faz isto: `claude -p` nasce e morre no processo; aqui o turno entra numa
// sessão de longa duração (com histórico) e você lê a resposta no stdout — serve pra cron e script.
async function cmdPrompt(texto, { engine, model, profile } = {}) {
  const r = await api("/sessions");
  const cwd = process.cwd();
  let S = (r.json?.sessions || []).filter(x => x.cwd === cwd && x.archived !== true)
                                   .sort((a, b) => b.lastTs - a.lastTs)[0];
  if (!S) {                                    // sem sessão aqui: cria uma silenciosa
    const body = { cwd, title: cwd.split("/").pop() || "headless" };
    if (engine) body.engine = engine;
    if (model) body.model = model;
    if (profile) body.permissionMode = PROFILES[profile] || "default";
    const c = await api("/sessions", { method: "POST", body: JSON.stringify(body) });
    if (c.status !== 200) { console.error(c.text); process.exit(1); }
    S = { id: c.json.id, seq: 0 };
  }
  const id = S.id;
  let from = Math.max(0, (S.seq || 0));
  const res = await fetch(`${CFG.base}/sessions/${id}/stream?from=${from}&client=terminal`, { headers: { Authorization: H.Authorization } });
  if (!res.ok || !res.body) { console.error(`stream ${res.status}`); process.exit(1); }
  const env = await api(`/sessions/${id}/message`, { method: "POST", body: JSON.stringify({ text: texto, via: "terminal" }) });
  if (env.status !== 200) { console.error(env.text); process.exit(1); }
  let buf = "", saida = "", code = 0;
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf8");
    const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.split("\n").find(l => l.startsWith("data:"));
      if (!line) continue;
      let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
      if (e.kind === "delta") { saida += e.text || ""; process.stdout.write(e.text || ""); }
      else if (e.kind === "text" && !saida) { saida = e.text || ""; process.stdout.write(saida + "\n"); }
      else if (e.kind === "permission_request") {
        // headless não tem quem aprove no terminal — avisa e deixa o app/celular decidir
        process.stderr.write(`\n${C.yellow}⌘ aprovação pendente (${e.tool}) — responda no app; 120s p/ decidir${C.reset}\n`);
      }
      else if (e.kind === "turn_end") { code = e.ok === false ? 1 : 0; process.stdout.write("\n"); process.exit(code); }
      else if (e.kind === "session_end") { process.stderr.write("sessão encerrada\n"); process.exit(1); }
    }
  }
  process.exit(code);
}

// ── doctor: primeira coisa a rodar quando "não conecta" ────────────────────
async function cmdDoctor() {
  const linha = (ok, txt, extra = "") => console.log(`${ok ? C.green + "✔" : C.red + "✘"}${C.reset} ${txt}${extra ? ` ${C.dim}${extra}${C.reset}` : ""}`);
  console.log(`${C.bold}xneog doctor${C.reset} ${C.dim}v${VERSION}${C.reset}\n`);
  // credencial: de onde veio
  const origem = CFG.device?.id ? `conta xNeog · device ${CFG.device.id}`
    : process.env.NATIVE_API_KEY ? "variável de ambiente"
    : (() => { try { return JSON.parse(readFileSync(CFG_FILE, "utf8")).key === "@keychain" ? "Keychain (xneog-cli)" : "~/.xneog/config.json"; } catch { return "~/.xneog/env (host)"; } })();
  const temCred = !!(CFG.key || CFG.device?.id);
  linha(temCred, `credencial: ${temCred ? origem : "AUSENTE — rode xneog login"}`);
  linha(true, `daemon configurado: ${CFG.base}`);
  // alcance + protocolo
  let meta = null;
  try {
    const r = await fetch(`${CFG.base}/meta`, { headers: H, signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) { linha(false, `daemon respondeu ${r.status} — credencial recusada (xneog login)`); }
    else { meta = await r.json(); linha(true, `daemon respondendo`, `${meta.name} · protocol ${meta.protocol}`); }
  } catch (e) { linha(false, `daemon inacessível`, e.message); }
  if (meta) {
    linha(meta.protocol === 1, `protocolo compatível`, meta.protocol === 1 ? "" : `este cliente fala v1, o daemon fala v${meta.protocol} — atualize o xneog`);
    console.log(`  ${C.dim}capabilities: ${(meta.capabilities || []).join(" · ")}${C.reset}`);
    const h = await api("/health");
    if (h.status === 200) linha(true, `sessões: ${h.json.sessions} · aprovações pendentes: ${h.json.pending}`);
    const s = await api("/sessions");
    const pend = (s.json?.sessions || []).filter(x => (x.needsInput || 0) > 0);
    if (pend.length) console.log(`${C.yellow}⚠${C.reset} ${pend.length} sessão(ões) esperando aprovação: ${pend.map(x => x.id).join(", ")}`);
  }
  // PATH: o clássico "done — try it" seguido de command not found
  try {
    const w = execFileSync("which", ["xneog"], { encoding: "utf8" }).trim();
    linha(true, `binário no PATH`, w);
  } catch { linha(false, `xneog não está no PATH`, "adicione o bin global do npm ao PATH (npm bin -g)"); }
  console.log(`\n${C.dim}config: ${CFG_FILE} · segredos do host: ~/.xneog/env${C.reset}`);
}

// ── entrypoint ───────────────────────────────────────────────────────────────
function help() {
  console.log(`${C.bold}xneog${C.reset} v${VERSION} ${C.dim}— cliente do xneog-agentd (protocolo v1)${C.reset}

${C.cyan}uso:${C.reset}
  xneog login                             conecta à sua CONTA pelo browser (padrão Claude Code)
  xneog login --code XXXX                 conecta colando o código do web app
  xneog login --keychain | login maquina  credencial de máquina (BYOK) no Keychain
  xneog logout                            remove a credencial deste terminal
  xneog                                   NOVA sessão limpa (padrão Claude Code)
  xneog --continue | -c                   retoma a sessão mais recente
  xneog ls                                lista sessões (título de IA, engine, fila)
  xneog new [cwd] [--engine claude|grok|api] [--model M] [--profile safe|edit|auto] [--title T]
  xneog attach <id>                       entra numa sessão (streaming + composer + aprovação)
  xneog import <claudeSessionId>          importa sessão do Claude Code CLI (reviveável)
  xneog models                            engines/modelos do registry (engines.json)
  xneog pair [nome]                       código p/ parear um device (app iOS) neste daemon
  xneog meta                              identidade e capabilities do daemon
  xneog doctor                            diagnóstico: credencial, daemon, protocolo, PATH
  xneog -p "texto"                        headless: manda um turno pra sessão viva deste diretório

${C.cyan}perfis:${C.reset} safe = tudo pede · edit = edições + Bash de leitura passam · auto = daemon aprova tudo (auditado)
${C.dim}"full" não existe: bypass global não é exposto pelo daemon — a fila é server-side, até no auto.${C.reset}

${C.cyan}no attach:${C.reset} "/" menu · /model /mode /stop /tasks · """ multiline · y/n/a/e aprovação · Ctrl-C interrompe · /q desconecta`);
}

// ── pair: gera código de uso único p/ registrar um device (app iOS) no daemon ─
async function cmdPair(name) {
  const meta = await api("/meta");
  if (!(meta.json?.capabilities || []).includes("pair"))
    return console.error(`${C.red}este daemon não suporta pairing${C.reset} — atualize o xneog-agentd`);
  const r = await api("/pair/start", { method: "POST", body: JSON.stringify({ name }) });
  if (r.status !== 200) return console.error(`${C.red}${r.text}${C.reset}`);
  const { code, deviceId, expiresInSec } = r.json;
  const pretty = code.replace(/(.{5})/g, "$1 ").trim();
  console.log(`\n${C.bold}código de pareamento:${C.reset}\n`);
  console.log(`   ${C.cyan}${C.bold}${pretty}${C.reset}\n`);
  console.log(`${C.dim}no app xNeog: Ajustes → Parear Mac → digite o código.`);
  console.log(`válido por ${Math.round(expiresInSec / 60)}min · uso único · device ${deviceId}`);
  console.log(`daemon: ${CFG.base} (o app precisa alcançar esta URL)${C.reset}`);
}

const argv = process.argv.slice(2);
const [cmd] = argv;
function flag(name) { const i = argv.indexOf(name); return i >= 0 ? (argv.splice(i, 2)[1] || "") : ""; }
function boolFlag(name) { const i = argv.indexOf(name); if (i >= 0) { argv.splice(i, 1); return true; } return false; }
const title = flag("--title");
const engine = flag("--engine");
const model = flag("--model");
const profile = flag("--profile");
const base = flag("--base");
const keyFlag = flag("--key");
const keychain = boolFlag("--keychain");
const contFlag = boolFlag("--continue") || boolFlag("-c");
const codeFlag = flag("--code");
const nameFlag = flag("--name");
const args = argv.slice(1);

// `xneog` puro num TTY = experiência Claude Code: reusa a sessão viva mais recente DESTE
// diretório, ou cria uma nova aqui e já entra no chat. Help fica em `xneog help` / não-TTY.
async function cmdDefault() {
  needKey();
  const cwd = process.cwd();
  // Padrão Claude Code: `xneog` puro = sessão NOVA e LIMPA. Retomar é EXPLÍCITO com
  // --continue (a mais recente) ou attach <id>. Antes o default retomava e despejava o
  // histórico velho na tela — confuso e caro (todo o contexto antigo volta pro modelo).
  if (contFlag) {
    const r = await api("/sessions");
    const vivas = (r.json?.sessions || [])
      .filter(s => s.archived !== true && s.status !== "dead")
      .sort((a, b) => b.lastTs - a.lastTs);
    const S = CFG.device?.id ? vivas[0]
      : vivas.filter(s => s.cwd === cwd && (s.engine || "claude") === (engine || s.engine || "claude"))[0];
    if (S) { console.log(`${C.dim}retomando ${S.id}${CFG.device?.id ? " da sua conta" : ""}${C.reset}`); return cmdAttach(S.id); }
    console.log(`${C.dim}nenhuma sessão pra retomar — criando uma nova${C.reset}`);
  }
  try { return await cmdNew(cwd, { title, engine, model, profile }); }
  catch (e) {
    if (/limite de sessões/.test(String(e?.message || e))) {
      const r = await api("/sessions");
      const viva = (r.json?.sessions || []).filter(s => s.archived !== true && s.status !== "dead").sort((a, b) => b.lastTs - a.lastTs)[0];
      if (viva) { console.log(`${C.dim}teto de sessões atingido — entrando na mais recente (${viva.id}). Libere com kill no web/app.${C.reset}`); return cmdAttach(viva.id); }
    }
    throw e;
  }
}

function cmdLogout() {
  try { unlinkSync(CFG_FILE); } catch {}
  try { execFileSync("security", ["delete-generic-password", "-a", "xneog", "-s", "xneog-cli"], { stdio: "ignore" }); } catch {}
  console.log(`${C.green}deslogado${C.reset} — credencial removida. Reconecte com ${C.bold}xneog login${C.reset}.`);
}
if (cmd === "logout" || cmd === "sair") cmdLogout();
else if (cmd === "login" && codeFlag) await cmdLoginConta(codeFlag, base);
else if (cmd === "login" && (keyFlag || keychain)) await cmdLogin(base, keychain, keyFlag);
else if (cmd === "login" && args[0] === "maquina") await cmdLogin(base, keychain, keyFlag);
else if (cmd === "login") await cmdLoginBrowser(base).catch((e) => { console.error(`${C.red}${e.message}${C.reset}`); process.exit(1); });
else if (cmd === "ls") { needKey(); await cmdLs(); }
else if (cmd === "new") { needKey(); await cmdNew(args[0], { title, engine, model, profile }); }
else if (cmd === "attach" && args[0]) { needKey(); await cmdAttach(args[0]); }
else if (cmd === "import" && args[0]) { needKey(); await cmdImport(args[0]); }
else if (cmd === "models") { needKey(); await cmdModels(); }
else if (cmd === "pair") { needKey(); await cmdPair(nameFlag || args[0] || ""); }
else if (cmd === "meta") { needKey(); await cmdMeta(); }
else if (cmd === "doctor") { await cmdDoctor(); }
else if (cmd === "-p" || cmd === "--prompt") { needKey(); await cmdPrompt(args.join(" "), { engine, model, profile }); }
else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (cmd === "help" || cmd === "-h" || cmd === "--help") help();
else if (!cmd && process.stdin.isTTY) await cmdDefault();
else { help(); process.exit(cmd ? 1 : 0); }
