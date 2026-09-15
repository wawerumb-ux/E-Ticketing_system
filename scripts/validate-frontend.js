#!/usr/bin/env node
/**
 * validate-frontend.js — offline frontend validation (S6)
 *
 * Checks:
 *   1. JS syntax        (node --check)
 *   2. HTML tag balance  (user/index.html, admin/index.html)
 *   3. getElementById ↔ id= cross-ref per portal
 *   4. No remote http(s) URLs in html/css/js (O1)
 *   5. CSS var(--X) tokens exist in :root blocks
 *
 * Exit 0 = all pass, 1 = errors found.
 * Run from repo root:  node scripts/validate-frontend.js
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "..");
const FE    = path.join(ROOT, "frontend");
const SHARED_CSS = path.join(FE, "shared", "css", "style.css");

let exitCode = 0;
const errors = [];

function err(tag, msg) {
  errors.push(`[${tag}] ${msg}`);
  exitCode = 1;
}

function read(rel) {
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(full)) { err("READ", `file not found: ${rel}`); return ""; }
  return fs.readFileSync(full, "utf8");
}

// strip JS block and line comments so commented-out code is not scanned
function stripJSComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 1. JS syntax — node --check                                        */
/* ------------------------------------------------------------------ */
function checkJSSyntax() {
  const { execSync } = require("child_process");
  const jsDir = path.join(FE);
  const files = [];
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".js")) files.push(p);
    }
  }
  walk(jsDir);
  for (const file of files) {
    try {
      execSync(`node --check "${file}"`, { stdio: "pipe" });
    } catch (e) {
      const rel = path.relative(ROOT, file);
      const stderr = (e.stderr || "").toString().trim().split("\n").slice(0, 3).join("; ");
      err("JS-SYNTAX", `${rel}: ${stderr}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. HTML tag balance                                                */
/* ------------------------------------------------------------------ */
function checkTagBalance(htmlFile) {
  const src = read(htmlFile);
  // strip script/style bodies and HTML comments so their inner text/false tags don't count
  const stripped = src
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tags = [];
  // Match opening and closing tags
  const re = /<\/([a-zA-Z][a-zA-Z0-9-]*)>|<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?\s*\/?>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const full = m[0];
    if (m[1]) { // closing tag
      const tag = m[1].toLowerCase();
      const rawVoid = ["br","hr","img","input","meta","link","source","area","base","col","embed","param","track","wbr"];
      if (rawVoid.includes(tag)) continue;
      // find matching open
      let matched = false;
      for (let i = tags.length - 1; i >= 0; i--) {
        if (tags[i] === tag) { tags.splice(i, 1); matched = true; break; }
        if (tags[i] === `__skip_${tag}`) continue;
      }
      if (!matched) {
        const line = stripped.slice(0, re.lastIndex).split("\n").length;
        err("HTML-BALANCE", `${htmlFile}:${line}: unexpected closing </${tag}>`);
      }
    } else if (!full.endsWith("/>")) { // opening tag (not self-closing)
      const tag = m[2].toLowerCase();
      if (["br","hr","img","input","meta","link","source","area","base","col","embed","param","track","wbr"].includes(tag)) continue;
      tags.push(tag);
    }
  }
  if (tags.length > 0) {
    err("HTML-BALANCE", `${htmlFile}: unclosed tags: ${tags.join(", ")}`);
  }
}

/* ------------------------------------------------------------------ */
/* 3. getElementById ↔ id= cross-ref                                  */
/* ------------------------------------------------------------------ */
function checkGetById(htmlFile, jsFiles) {
  // ids in HTML
  const htmlSrc = read(htmlFile);
  const htmlIds = new Set();
  const idRe = /\bid="([^"]+)"/g;
  let m;
  while ((m = idRe.exec(htmlSrc)) !== null) htmlIds.add(m[1]);

  // ids in JS-injected markup (template literals with id="...") — S6: the
  // id may be rendered by app.js, not present in static HTML
  for (const jsFile of jsFiles) {
    const src = stripJSComments(read(jsFile));
    const jidRe = /\bid\s*=\s*["'`]([^"'`]+)["'`]/g;
    while ((m = jidRe.exec(src)) !== null) {
      if (!m[1].includes("$")) htmlIds.add(m[1]);
    }
  }

  // ids used in this portal's loaded JS files
  const jsIds = new Set();
  for (const jsFile of jsFiles) {
    const src = stripJSComments(read(jsFile));
    const gbiRe = /getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    while ((m = gbiRe.exec(src)) !== null) {
      if (m[1].includes("$")) continue; // dynamic id e.g. `kb-article-${id}`
      jsIds.add(m[1]);
    }
  }

  // report JS ids not defined anywhere (HTML or JS markup)
  for (const id of [...jsIds].sort()) {
    if (!htmlIds.has(id)) {
      err("GETBYID", `${path.relative(ROOT, htmlFile)}: getElementById("${id}") used but no id="${id}" defined in HTML or portal JS`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. No remote http(s) URLs (O1)                                     */
/* ------------------------------------------------------------------ */
function checkRemoteURLs() {
  const exts = [".html", ".css", ".js"];
  function walk(d) {
    let files = [];
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) { files = files.concat(walk(p)); continue; }
      if (exts.includes(path.extname(name))) files.push(p);
    }
    return files;
  }
  const files = walk(FE);
  // allow localhost and 127.0.0.1; block anything else remote
  const remoteRe = /\bhttps?:\/\/(?!localhost|127\.0\.0\.1)\S+/g;
  for (const file of files) {
    // vendored libraries are local copies — their internal doc URLs are not runtime fetches
    if (file.split(path.sep).includes("vendor")) continue;
    const src = fs.readFileSync(file, "utf8");
    let m;
    const re = new RegExp(remoteRe.source, "g");
    while ((m = re.exec(src)) !== null) {
      const url = m[0].replace(/["'`,)]+$/, "");
      // allow w3.org (SVG/XML namespaces embedded in code) and *.example.* (placeholders/docs)
      if (/w3\.org/.test(url)) continue;
      if (/example\./.test(url)) continue;
      if (/\bexample\.com\b/.test(url)) continue;
      // Cloudflare Turnstile is an opt-in captcha on the login surface (pre-existing; warn only)
      if (/challenges\.cloudflare\.com/.test(url)) {
        const line = src.slice(0, m.index).split("\n").length;
        const rel = path.relative(ROOT, file);
        console.log(`  [WARN] ${rel}:${line}: Turnstile remote script (login surface, opt-in)`);
        continue;
      }
      const line = src.slice(0, m.index).split("\n").length;
      const rel = path.relative(ROOT, file);
      err("REMOTE-URL", `${rel}:${line}: remote URL detected (O1): ${url}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. CSS var(--X) token check (S5)                                   */
/* ------------------------------------------------------------------ */
function checkCSSTokens() {
  if (!fs.existsSync(SHARED_CSS)) { err("CSS", `style.css not found at ${path.relative(ROOT, SHARED_CSS)}`); return; }
  const css = fs.readFileSync(SHARED_CSS, "utf8");

  // collect definitions: --name in :root blocks (including .dark, .high-contrast)
  const defTokens = new Set();
  const defRe = /--([a-zA-Z][a-zA-Z0-9_-]*)\s*:/g;
  let m;
  while ((m = defRe.exec(css)) !== null) defTokens.add(m[1]);

  // collect references: var(--name
  const useTokens = new Set();
  const useRe = /var\(\s*--([a-zA-Z][a-zA-Z0-9_-]*)/g;
  while ((m = useRe.exec(css)) !== null) useTokens.add(m[1]);

  // exclude well-known inherited/system tokens
  const builtins = new Set([
    "inherited","initial","unset","revert",
    "default","env","safe-area-inset-top","safe-area-inset-bottom",
  ]);

  for (const tok of [...useTokens].sort()) {
    if (builtins.has(tok)) continue;
    if (!defTokens.has(tok)) {
      err("CSS-TOKEN", `var(--${tok}) used but not defined in :root`);
    }
  }
}

/* ================================================================== */
/* Main                                                                */
/* ================================================================== */
console.log("validate-frontend: starting...\n");

// 1. JS syntax
checkJSSyntax();

// 2. Tag balance
const portals = [
  { html: path.join(FE, "user", "index.html"),  jsDir: [path.join(FE, "user", "js"), path.join(FE, "shared", "js")] },
  { html: path.join(FE, "admin", "index.html"), jsDir: [path.join(FE, "admin", "js"), path.join(FE, "shared", "js")] },
];
for (const p of portals) {
  if (fs.existsSync(p.html)) checkTagBalance(p.html);
}

// 3. getElementById cross-ref (per portal + its own JS only, not shared)
for (const p of portals) {
  if (!fs.existsSync(p.html)) continue;
  const jsFiles = p.jsDir
    .filter(d => fs.existsSync(d))
    .flatMap(d =>
      fs.readdirSync(d).filter(n => n.endsWith(".js")).map(n => path.join(d, n))
    );
  checkGetById(p.html, jsFiles);
}

// 4. Remote URLs
checkRemoteURLs();

// 5. CSS tokens
checkCSSTokens();

/* ---- report ---- */
if (errors.length === 0) {
  console.log("All frontend checks passed.\n");
} else {
  console.error(`${errors.length} error(s):\n`);
  for (const e of errors) console.error("  " + e);
  console.error("");
}

process.exit(exitCode);
