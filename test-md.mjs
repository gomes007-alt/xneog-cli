let _mdBold = false, _mdCode = false, _mdPend = "", _mdBol = true, _mdHdr = false;
function mdStream(t) {
  let out = "", buf = _mdPend + t; _mdPend = "";
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i], n = buf[i + 1];
    if (c === "*" && n === undefined) { _mdPend = "*"; break; }          // pode virar ** no próximo delta
    if (c === "*" && n === "*") { _mdBold = !_mdBold; out += _mdBold ? "<B>" : "<R>"; i++; continue; }
    if (c === "`") { _mdCode = !_mdCode; out += _mdCode ? "<C>" : "<R>"; continue; }
    if (_mdBol && (c === "-" || c === "*") && n === " ") { out += `${"<D>"}•${"<R>"}`; _mdBol = false; continue; }
    if (_mdBol && c === "#") {                                            // # título → negrito ATÉ O FIM DA LINHA
      let j = i; while (buf[j] === "#") j++;
      if (buf[j] === " ") { out += "<B>"; _mdBold = true; _mdHdr = true; i = j; _mdBol = false; continue; }
    }
    if (c === "\n" && _mdHdr) { out += "<R>"; _mdBold = false; _mdHdr = false; }   // header não vaza pra linha seguinte
    _mdBol = c === "\n";
    out += c;
  }
  return out;
}
function mdReset() {
  let out = _mdPend; _mdPend = "";
  if (_mdBold || _mdCode) out += "<R>";
  _mdBold = _mdCode = _mdHdr = false; _mdBol = true;
  return out;
}

const casos = [
  [["Olá **mundo** fim"], "Olá <B>mundo<R> fim"],
  [["Olá **mu","ndo** fim"], "Olá <B>mundo<R> fim"],
  [["use `code` aqui"], "use <C>code<R> aqui"],
  [["- item\n- outro\n"], "<D>•<R> item\n<D>•<R> outro\n"],
  [["## Titulo\ntexto"], "<B>Titulo<R>\ntexto"],
  [["sem marcacao"], "sem marcacao"],
  [["fim com asterisco *"], "fim com asterisco *"],
];
let ok=0, fail=0;
for (const [partes, esp] of casos) {
  _mdBold=_mdCode=_mdHdr=false; _mdPend=""; _mdBol=true;
  const got = partes.map(mdStream).join("") + mdReset();
  if (got === esp) { ok++; } else { fail++; console.log("  FAIL", JSON.stringify(partes.join("")), "→", JSON.stringify(got)); }
}
console.log(`${ok} ok · ${fail} fail`);
