#!/usr/bin/env node
/**
 * xneog — CLI oficial do xneog-agentd (F5 do plano xNeog CLI, 24-jul-2026).
 *
 * Cliente de terminal do daemon de sessões agentic (:8802): a MESMA sessão é dirigida
 * daqui, do app iOS/macOS e de qualquer outro cliente do protocolo (PROTOCOL.md v1).
 * Engines: claude (first-party) · grok (jaula Seatbelt) · api (loop próprio via chat-api).
 *
 * Credenciais (BYOK), em ordem: ~/.xneog/config.json → env (XNEOG_BRIDGE/NATIVE_API_KEY)
 * → legado (~/Projects/xneog-tg-poc/.env, p/ o Mac matriz seguir funcionando sem login).
 * `xneog login` grava a config (0600); `--keychain` guarda a key no Keychain do macOS.
 *
 * Perfis de permissão (client-side → permissionMode do daemon):
 *   safe = default (toda ação com efeito colateral pede aprovação)
 *   edit = acceptEdits (edições entram sozinhas; Bash ainda pede)
 *   "full" NÃO existe de propósito: bypassPermissions não é exposto pelo daemon — a fila
 *   de aprovação é a razão da ponte existir (doutrina, enforce server-side).
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const CFG_DIR = `${HOME}/.xneog`;
const CFG_FILE = `${CFG_DIR}/config.json`;
const VERSION = "0.6.1";

const C = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m" };

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
  const legacy = loadEnvFile(`${HOME}/Projects/xneog-tg-poc/.env`);
  return {
    base: process.env.XNEOG_BRIDGE || cfg.base || "http://127.0.0.1:8802",
    key: process.env.NATIVE_API_KEY || cfg.key || legacy.NATIVE_API_KEY || "",
  };
}
const CFG = loadConfig();
const H = { Authorization: `Bearer ${CFG.key}`, "Content-Type": "application/json" };
const api = async (path, opts = {}) => {
  const r = await fetch(`${CFG.base}${path}`, { headers: H, ...opts });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};
function needKey() {
  if (CFG.key) return;
  console.error(`${C.red}sem credencial.${C.reset} rode: ${C.bold}xneog login${C.reset} (ou exporte NATIVE_API_KEY)`);
  process.exit(1);
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
const PROFILES = { safe: "default", edit: "acceptEdits" };
async function cmdNew(cwd, { title, engine, model, profile }) {
  if (profile && !PROFILES[profile]) return console.error(`${C.red}perfil inválido${C.reset} — use safe|edit (full não existe: a fila de aprovação é a doutrina)`);
  const body = { cwd: cwd || process.cwd(), title: title || "" };
  if (engine) body.engine = engine;
  if (model) body.model = model;
  if (profile) body.permissionMode = PROFILES[profile];
  const r = await api("/sessions", { method: "POST", body: JSON.stringify(body) });
  if (r.status !== 200) return console.error("falhou:", r.text);
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
function render(e) {
  switch (e.kind) {
    case "user":  process.stdout.write(`\n${C.cyan}❯ ${e.text}${C.reset}${e.via === "app" ? ` ${C.dim}(do app)${C.reset}` : ""}\n`); break;
    case "delta": process.stdout.write(e.text || ""); break;
    case "text":  break;   // o delta já imprimiu (engines turn-based mandam text sem delta: imprime)
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
      const extra = edicao ? `  ${C.cyan}[e] aceitar edições (lote)${C.reset}` : "";
      process.stdout.write(`\n${C.yellow}⌘ APROVAR ${e.tool}${C.reset}\n`);
      if (!(edicao && renderDiff(e.input))) process.stdout.write(`${C.dim}${(e.input || "").slice(0, 300)}${C.reset}\n`);
      process.stdout.write(`${C.yellow}[y] sim  [n] não  [a] sempre nesta sessão${C.reset}${extra}\n`);
      break;
    }
    case "bulk_resolved":
      process.stdout.write(`\n${C.green}lote: ${e.resolved} ${e.approve ? "aprovada(s)" : "negada(s)"}${e.always ? " · edições liberadas nesta sessão" : ""}${C.reset}\n${C.cyan}❯ ${C.reset}`);
      break;
    case "queued":
      process.stdout.write(`\n${C.dim}⏳ na fila (${e.depth}): ${String(e.text || "").slice(0, 60)}${C.reset}\n${C.cyan}❯ ${C.reset}`);
      break;
    case "queue_cleared":
      process.stdout.write(`\n${C.dim}fila descartada (${e.dropped}) · ${e.reason}${C.reset}\n`);
      break;
    case "permission_resolved":
      process.stdout.write(`${e.approved ? C.green + "aprovado" : C.red + "negado"}${C.reset} ${C.dim}(por ${e.by})${C.reset}\n`);
      break;
    case "turn_end": {
      const rest = e.next ? ` · próxima da fila entrando${e.queued ? ` (${e.queued} atrás)` : ""}` : "";
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
    case "model_changed": process.stdout.write(`\n${C.dim}modelo → ${e.model || "padrão"}${C.reset}\n`); break;
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
  const modo = S.permissionMode === "acceptEdits" ? "aceitar edições"
             : S.permissionMode === "plan" ? "modo do plano"
             : S.permissionMode === "jail" ? "jaula" : "aprovação";
  console.log("");
  console.log(` ${C.cyan}▚▞${C.reset}  ${C.bold}xneog${C.reset} v${VERSION} ${C.dim}·${C.reset} ${engC}${engine}${C.reset} ${C.dim}— ${modelo} · ${modo}${C.reset}`);
  console.log(` ${C.cyan}▞▚${C.reset}  ${C.dim}${cwd} · sessão ${S.id}${(S.aiTitle || S.title) ? ` “${(S.aiTitle || S.title).slice(0, 46)}”` : ""}${C.reset}`);
  console.log("");
  if (S.needsInput > 0)
    console.log(` ${C.yellow}⚠ aprovação pendente nesta sessão — responda y/n/a/e${C.reset}`);
  if (!S.connected && engine === "claude")
    console.log(` ${C.yellow}⚠ sessão sem processo — reanime pelo app (revive) ou crie outra: xneog new${C.reset}`);
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

  let pendingReq = null;
  let sawDelta = false;

  let from = Math.max(0, (S.count || 0) - 40);
  let backoff = 1000;
  (async function stream() {
    for (;;) {
      try {
        const res = await fetch(`${CFG.base}/sessions/${id}/stream?from=${from}&client=terminal`, { headers: { Authorization: H.Authorization } });
        if (res.status === 404) { console.log(`\n${C.red}sessão ${id} não existe mais${C.reset}`); process.exit(0); }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        backoff = 1000;
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
            if (e.kind === "text" && !sawDelta) { process.stdout.write(`\n${e.text || ""}\n`); continue; }
            if (e.kind === "permission_request") pendingReq = e.requestId;
            if (e.kind === "permission_resolved") pendingReq = null;
            render(e);
          }
        }
      } catch {
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  })();

  let cmdMenu = [];
  api("/commands").then(r => { cmdMenu = r.json?.menu || []; }).catch(() => {});
  const LOCAL = [
    { cmd: "/model", desc: "troca o modelo (sonnet|opus|fable|haiku ou claude-*)" },
    { cmd: "/mode",  desc: "troca o modo (default|acceptEdits|plan)" },
    { cmd: "/stop",  desc: "cancela o turno atual (a sessão sobrevive)" },
    { cmd: "/tasks", desc: "subagentes/workflows da sessão (com fases)" },
    { cmd: '"""',    desc: "abre bloco multiline (fecha com \"\"\" e envia) · ou termine a linha com \\" },
    { cmd: "/q",     desc: "sai (a sessão continua no Mac)" },
  ];
  function printMenu() {
    for (const m of LOCAL) process.stdout.write(`${C.cyan}${m.cmd.padEnd(9)}${C.reset} ${C.dim}${m.desc}${C.reset}\n`);
    for (const m of cmdMenu.filter(x => x.scope === "both")) process.stdout.write(`${C.cyan}${m.cmd.padEnd(9)}${C.reset} ${C.dim}${m.desc} (vai como mensagem)${C.reset}\n`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.cyan}❯ ${C.reset}` });
  rl.on("close", () => process.exit(0));
  rl.prompt();
  const PROMPT = `${C.cyan}❯ ${C.reset}`, PROMPT_ML = `${C.dim}… ${C.reset}`;
  const send = async (text) => {
    const r = await api(`/sessions/${id}/message`, { method: "POST", body: JSON.stringify({ text, via: "terminal" }) });
    if (r.status !== 200) console.error(`${C.red}falhou: ${r.text}${C.reset}`);
  };
  let ml = null;   // { mode: "fence"|"bslash", lines: [] }
  rl.on("line", async (raw) => {
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
      const r = await api(`/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model: m }) });
      if (r.status !== 200) console.error(`${C.red}${r.text}${C.reset}`);
      return rl.prompt();
    }
    if (t.startsWith("/mode")) {
      const m = t.split(/\s+/)[1] || "";
      if (!m) { process.stdout.write(`${C.dim}uso: /mode default|acceptEdits|plan${C.reset}\n`); return rl.prompt(); }
      const r = await api(`/sessions/${id}/mode`, { method: "POST", body: JSON.stringify({ mode: m }) });
      if (r.status !== 200) console.error(`${C.red}${r.text}${C.reset}`);
      return rl.prompt();
    }
    if (t === "/stop") { await api(`/sessions/${id}/interrupt`, { method: "POST" }); return rl.prompt(); }
    if (t === "/tasks") {
      const r = await api(`/sessions/${id}/tasks`);
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
    if (pendingReq && t.toLowerCase() === "e") {
      await api(`/sessions/${id}/permission/bulk`, { method: "POST", body: JSON.stringify({ approve: true, always: true }) });
      pendingReq = null;
      return rl.prompt();
    }
    if (pendingReq && ["y", "n", "a"].includes(t.toLowerCase())) {
      const approve = t.toLowerCase() !== "n";
      const always = t.toLowerCase() === "a";
      await api(`/sessions/${id}/permission`, { method: "POST", body: JSON.stringify({ requestId: pendingReq, approve, always }) });
      pendingReq = null;
      return rl.prompt();
    }
    if (!t) return rl.prompt();
    await send(t);
    rl.prompt();
  });
}

// ── entrypoint ───────────────────────────────────────────────────────────────
function help() {
  console.log(`${C.bold}xneog${C.reset} v${VERSION} ${C.dim}— cliente do xneog-agentd (protocolo v1)${C.reset}

${C.cyan}uso:${C.reset}
  xneog login [--base URL] [--key K] [--keychain]   configura credencial (BYOK; valida antes de gravar)
  xneog ls                                lista sessões (título de IA, engine, fila)
  xneog new [cwd] [--engine claude|grok|api] [--model M] [--profile safe|edit] [--title T]
  xneog attach <id>                       entra numa sessão (streaming + composer + aprovação)
  xneog import <claudeSessionId>          importa sessão do Claude Code CLI (reviveável)
  xneog models                            engines/modelos do registry (engines.json)
  xneog meta                              identidade e capabilities do daemon

${C.cyan}perfis:${C.reset} safe = tudo pede aprovação · edit = edições entram sozinhas (Bash pede)
${C.dim}"full" não existe: bypass de aprovação não é exposto pelo daemon — doutrina.${C.reset}

${C.cyan}no attach:${C.reset} "/" menu · /model /mode /stop /tasks · """ multiline · y/n/a/e aprovação · /q sai`);
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
const args = argv.slice(1);

// `xneog` puro num TTY = experiência Claude Code: reusa a sessão viva mais recente DESTE
// diretório, ou cria uma nova aqui e já entra no chat. Help fica em `xneog help` / não-TTY.
async function cmdDefault() {
  needKey();
  const cwd = process.cwd();
  const r = await api("/sessions");
  const S = (r.json?.sessions || [])
    .filter(s => s.cwd === cwd && s.archived !== true && (s.engine || "claude") === (engine || s.engine || "claude"))
    .sort((a, b) => b.lastTs - a.lastTs)[0];
  if (S && !engine) {
    console.log(`${C.dim}retomando sessão ${S.id} deste diretório (nova: xneog new)${C.reset}`);
    return cmdAttach(S.id);
  }
  return cmdNew(cwd, { title, engine, model, profile });
}

if (cmd === "login") await cmdLogin(base, keychain, keyFlag);
else if (cmd === "ls") { needKey(); await cmdLs(); }
else if (cmd === "new") { needKey(); await cmdNew(args[0], { title, engine, model, profile }); }
else if (cmd === "attach" && args[0]) { needKey(); await cmdAttach(args[0]); }
else if (cmd === "import" && args[0]) { needKey(); await cmdImport(args[0]); }
else if (cmd === "models") { needKey(); await cmdModels(); }
else if (cmd === "meta") { needKey(); await cmdMeta(); }
else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (cmd === "help" || cmd === "-h" || cmd === "--help") help();
else if (!cmd && process.stdin.isTTY) await cmdDefault();
else { help(); process.exit(cmd ? 1 : 0); }
