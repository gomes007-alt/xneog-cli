#!/usr/bin/env python3
# E2E do ecossistema xNeog na cloud (09-ago-2026). Roda do Mac contra os hostnames públicos;
# partes box-local via ssh. Tenant de teste próprio (teste-e2e) criado e MORTO no fim.
import json, subprocess, sys, time, hmac, hashlib, urllib.request, urllib.error

AG = "https://agentd.xneog.com"
KEY = [l.split("=",1)[1].strip() for l in open("/Users/erck/.xneog/env") if l.startswith("AGENTD_CLOUD_KEY=")][0]
ok_n = 0; fail_n = 0
def chk(nome, cond, extra=""):
    global ok_n, fail_n
    if cond: ok_n += 1; print(f"  ok   {nome}")
    else: fail_n += 1; print(f"  FAIL {nome} {extra}")

def req(url, method="GET", data=None, hdr=None, timeout=90):
    r = urllib.request.Request(url, method=method, data=json.dumps(data).encode() if data is not None else None)
    r.add_header("content-type", "application/json")
    r.add_header("User-Agent", "xneog-e2e/1.0 (curl-compat)")
    for k, v in (hdr or {}).items(): r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            # SSE nunca fecha: lê em pedaços e devolve o PARCIAL no timeout — descartar o que já
            # veio (comportamento default do urllib) fazia stream vivo parecer falha.
            chunks = []
            try:
                while True:
                    # readline devolve assim que a LINHA chega — read(N) bloqueava até juntar N
                    # bytes e o timeout descartava um replay de 2KB inteiro.
                    c = resp.readline()
                    if not c: break
                    chunks.append(c)
                    if sum(len(x) for x in chunks) > 1_500_000: break
            except Exception:
                pass
            return resp.status, b"".join(chunks).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)

print("== 1. superfícies públicas")
st, body = req("https://conta.xneog.com/v1/health")
h = json.loads(body) if st == 200 else {}
chk("conta /health 200", st == 200)
chk("anthropic+google+gemini configurados", h.get("anthropic_configured") and h.get("google_client_id") and h.get("gemini_fallback"))
for host in ["doutrina", "planos", "report"]:
    st, _ = req(f"https://{host}.xneog.com/")
    chk(f"{host} 200", st == 200)
st, _ = req("https://web.xneog.com/auth/config")
chk("web /auth/config 200", st == 200)
st, body = req("https://web.xneog.com/auth/google", "POST", {})
chk("web /auth/google sem token = 400", st == 400, body[:60])
st, _ = req("https://web.xneog.com/auth/eu")
chk("web /auth/eu sem cookie = 401", st == 401)

print("== 2. agentd cloud: tenancy do membro de teste")
st, body = req(f"{AG}/meta", hdr={"Authorization": f"Bearer {KEY}"})
caps = json.loads(body).get("capabilities", []) if st == 200 else []
chk("meta 200 com tenancy", st == 200 and "session-state" in caps and "pair" in caps)
st, body = req(f"{AG}/pair/start", "POST", {"owner": "teste-e2e", "name": "e2e"}, {"Authorization": f"Bearer {KEY}"})
code = json.loads(body).get("code") if st == 200 else None
chk("pair/start owner=teste-e2e", bool(code))
st, body = req(f"{AG}/pair/claim", "POST", {"code": code, "name": "e2e"})
dev = json.loads(body) if st == 200 else {}
chk("pair/claim devolve device+secret", bool(dev.get("deviceId") and dev.get("secret")))
def tok():
    exp = int(time.time()*1000) + 600000
    mac = hmac.new(dev["secret"].encode(), f"{dev['deviceId']}.{exp}".encode(), hashlib.sha256).hexdigest()
    return {"Authorization": f"Bearer v2.{dev['deviceId']}.{exp}.{mac}"}

print("== 3. sessão do membro: create, defaults, turno com custo")
st, body = req(f"{AG}/sessions", "POST", {}, tok())
S = json.loads(body) if st == 200 else {}
chk("create sem engine → api", S.get("engine") == "api", body[:100])
chk("cwd forçado pra jaula do tenant", "MembrosWork" in S.get("cwd", "") and "teste-e2e" in S.get("cwd", ""))
sid = S.get("id")
st, _ = req(f"{AG}/sessions/{sid}/message", "POST", {"text": "responda apenas: E2E-OK"}, tok())
chk("message 200", st == 200)
time.sleep(14)
st, body = req(f"{AG}/sessions/{sid}/stream?from=0", hdr=tok(), timeout=8)
chk("turno respondeu E2E-OK", "E2E-OK" in body)
chk("turn_end com model haiku (default de membro)", '"model":"claude-haiku' in body, body[-300:])
chk("turn_end com usage medido", '"usage":{"in"' in body)

print("== 4. auto-modo: Bash negado na hora (sem fila de 120s)")
t0 = time.time()
req(f"{AG}/sessions/{sid}/message", "POST", {"text": "rode este comando via Bash agora: echo oi"}, tok())
time.sleep(16)
st, body = req(f"{AG}/sessions/{sid}/stream?from=0", hdr=tok(), timeout=8)
seg = body.split("rode este comando")[-1]
chk("Bash: recusa fixa OU nem tentou (system prompt obedecido)", ("Bash não está disponível neste servidor" in seg) or ('"name":"Bash"' not in seg and '"kind":"turn_end"' in seg))
chk("sem approval pendurada", '"kind":"permission_request"' not in body.split("rode este comando")[-1] if "rode este comando" in body else True)

print("== 5. teto do tenant (F11): 3 vivas, a 4ª recusa com motivo certo")
extras = []
for i in range(3):
    st, body = req(f"{AG}/sessions", "POST", {}, tok())
    if st == 200: extras.append(json.loads(body)["id"])
    else: break
chk("teto atingido com motivo de MEMBRO", st == 429 and "membro" in body, f"st={st} {body[:80]}")

print("== 6. kill limpa e dead não conta no teto")
for x in [sid] + extras:
    req(f"{AG}/sessions/{x}/kill", "POST", {}, tok())
st, body = req(f"{AG}/sessions", hdr=tok())
vivos = [s for s in json.loads(body).get("sessions", []) if s.get("status") != "dead"]
chk("todas mortas pós-kill", len(vivos) == 0, str([s['id'] for s in vivos]))
st, body = req(f"{AG}/sessions", "POST", {}, tok())
chk("create volta a funcionar após kill", st == 200)
if st == 200: req(f"{AG}/sessions/{json.loads(body)['id']}/kill", "POST", {}, tok())

print("== 7. CLI no box (conta do Gomes)")
r = subprocess.run(["ssh", "-o", "BatchMode=yes", "Administrator@100.106.183.14", "xneog --version 2>NUL"],
                   capture_output=True, text=True, timeout=60)
# Versão do box == versão do repo: pinar número literal envelhece a cada release (este teste
# já falhou sozinho por isso). O que importa é que o deploy no box aconteceu.
vlocal = json.load(open("/Users/erck/Projects/xneog-cli/package.json"))["version"]
vbox = next((l.strip() for l in r.stdout.splitlines() if l.strip()[:1].isdigit()), "")
chk(f"CLI do box na versão do repo ({vlocal})", vbox == vlocal, f"box={vbox}")
r = subprocess.run(["ssh", "-o", "BatchMode=yes", "Administrator@100.106.183.14", "xneog ls 2>NUL"],
                   capture_output=True, text=True, timeout=60)
chk("xneog ls do box lista só o tenant dele", "leandro.1416.ls.ls" in r.stdout and "teste-e2e" not in r.stdout)

print("== 8. chat da conta (SSE) com upstream real")
script = '''import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync("C:/tools/chatapi/.env","utf8").split("\\n").map(l=>l.split("=")).filter(a=>a.length>=2).map(a=>[a[0],a.slice(1).join("=")]));
const r = await fetch("http://100.106.183.14:3848/v1/chat", { method:"POST",
  headers: { Authorization: `Bearer ${env.SHARED_TOKEN.trim()}`, "content-type":"application/json" },
  body: JSON.stringify({ prompt: "responda apenas: CHAT-E2E-OK", mode: "chat" }) });
const reader = r.body.getReader(); const dec = new TextDecoder(); let buf="";
for(;;){ const {done,value}=await reader.read(); if(done) break; buf+=dec.decode(value); if(buf.includes("event: done")||buf.length>4000) break; }
console.log(buf.includes("CHAT-E2E-OK")?"CHAT-OK":"CHAT-FAIL", buf.includes("fallback")?"(fallback)":"(primario-anthropic)");'''
open("/tmp/chate2e.mjs", "w").write(script)
subprocess.run(["scp", "-q", "/tmp/chate2e.mjs", "Administrator@100.106.183.14:C:/tools/chatapi/chate2e.mjs"], timeout=60)
r = subprocess.run(["ssh", "-o", "BatchMode=yes", "Administrator@100.106.183.14",
                    "cd C:\\tools\\chatapi && node chate2e.mjs && del chate2e.mjs"], capture_output=True, text=True, timeout=120)
chk("chat SSE responde", "CHAT-OK" in r.stdout, r.stdout[:120])
chk("primário Anthropic (key no box)", "primario-anthropic" in r.stdout)

print("== 9. segurança: portas cruas fechadas no IP público")
for porta in [3848, 8795, 8799, 8812]:
    r = subprocess.run(["nc", "-z", "-G", "3", "80.190.74.220", str(porta)], capture_output=True, timeout=15)
    chk(f"porta {porta} fechada na internet", r.returncode != 0)

print(f"\n════ PLACAR: {ok_n} ok · {fail_n} fail ════")
sys.exit(1 if fail_n else 0)
