#!/usr/bin/env node
/**
 * 离线交付一键验收 verify-release
 * --------------------------------
 * 一条命令把交付前的人工动作全部跑完（任何一项不过则整条命令失败）：
 *   0. 生产构建（vue-tsc 类型检查 + vite build）
 *   1. 体积：dist 总体积、最大单文件，超过上限即失败（上限可用环境变量覆盖）
 *   2. 外链：扫描产物里所有指向外部的地址，除命名空间/框架错误文档白名单外，发现即失败
 *   3. 纹样与字体：随包文件一个不少（与 public 源逐字节相同），
 *      且每个纹样解析出的轮廓数与验收自检记录（acceptance/expected-contours.json）一致
 *   4. 页面自检内核：在 Node 里原样运行 /help 页同一颗 runSelfTest，全部用例必须通过
 *   5. A4 1:1 检查图：导出一份，按 100mm/50mm 校验尺线段长度与 210×297mm 纸幅核对缩放
 *   6. 带参数页面地址：起静态服务器直开 /design/x 等地址，确认都回落到同一个入口而非空白页
 *   7. 容器：本机有 docker/podman 才跑（构建镜像、healthz、镜像体积上限）；没有则跳过并写明原因
 *   8. 两次一致性：本次量到的关键值与上一次落盘快照比较（第一次跑只记录基线）
 *
 * 上限环境变量（默认值见下）：VERIFY_MAX_TOTAL_BYTES / VERIFY_MAX_FILE_BYTES / VERIFY_MAX_IMAGE_BYTES
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http, { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..', '..')
const DIST = join(APP_ROOT, 'dist')
const OUT_DIR = join(APP_ROOT, 'verify-out')
const CACHE_DIR = join(APP_ROOT, 'node_modules', '.cache', 'verify-release')
const HARNESS_SRC = join(HERE, 'harness-entry.ts')
const HARNESS_BUNDLE = join(CACHE_DIR, 'harness.mjs')
const SNAPSHOT = join(CACHE_DIR, 'snapshot.json')
const BASELINE = join(APP_ROOT, 'acceptance', 'expected-contours.json')
const A4_FILE = join(OUT_DIR, 'a4-check-1to1.svg')

const MAX_TOTAL_BYTES = Number(process.env.VERIFY_MAX_TOTAL_BYTES ?? 2 * 1024 * 1024) // 2MiB
const MAX_FILE_BYTES = Number(process.env.VERIFY_MAX_FILE_BYTES ?? 512 * 1024) // 512KiB
const MAX_IMAGE_BYTES = Number(process.env.VERIFY_MAX_IMAGE_BYTES ?? 60 * 1024 * 1024) // 60MiB
const HTTP_TIMEOUT_MS = 5000

// 外链白名单主机：W3C XML 命名空间标识符（仅标识符，不会被加载）与 Vue 运行时错误文档链接
const URL_HOST_ALLOWLIST = new Set(['www.w3.org', 'vuejs.org'])

const checks = []
let current = null

function section(id, title) {
  current = { id, title, pass: true, lines: [] }
  checks.push(current)
  console.log(`\n[${id}] ${title}`)
}
function line(text) {
  console.log(`    ${text}`)
  current.lines.push(text)
}
function fail(text) {
  current.pass = false
  console.log(`    ✗ ${text}`)
  current.lines.push(`✗ ${text}`)
}
function ok(text) {
  console.log(`    ✓ ${text}`)
  current.lines.push(`✓ ${text}`)
}
function human(bytes) {
  return `${bytes} B（${(bytes / 1024).toFixed(1)} KiB）`
}
function finish(code) {
  process.exit(code)
}

function walkDir(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walkDir(abs, base))
    else out.push({ rel: relative(base, abs), abs, size: st.size })
  }
  return out
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: r.status ?? (r.error ? -1 : 0),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  }
}

function detectContainerTool() {
  for (const t of ['docker', 'podman']) {
    const r = spawnSync(t, ['--version'], { encoding: 'utf8' })
    if (r.status === 0) return t
  }
  return null
}

function serveDist(rootDir) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
  }
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    let abs = urlPath === '/' ? join(rootDir, 'index.html') : join(rootDir, urlPath.slice(1))
    if (!abs.startsWith(rootDir)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      // 哈希资源不存在 → 404；页面路径一律 SPA 回退到同一个 index.html
      if (urlPath.startsWith('/assets/') || urlPath.startsWith('/patterns/') || urlPath.startsWith('/fonts/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      abs = join(rootDir, 'index.html')
    }
    const ext = abs.slice(abs.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' })
    res.end(readFileSync(abs))
  })
  return new Promise((resolvePromise) =>
    server.listen(0, '127.0.0.1', () => resolvePromise({ port: server.address().port, close: () => server.close() })),
  )
}

function httpGet(port, path) {
  return new Promise((resolvePromise) => {
    // 路径里的中文等字符需按 URL 编码（服务端再 decodeURIComponent 还原）
    const reqPath = encodeURI(path)
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, headers: { Accept: 'text/html' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body, contentType: res.headers['content-type'] ?? '' }))
    })
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolvePromise({ status: -1, body: String(e.message), contentType: '' }))
  })
}

// ---------------------------------------------------------------- 0. 构建
section('build', '生产构建（npm run build：vue-tsc 类型检查 + vite build）')
const build = run('npm', ['run', 'build'])
if (build.code !== 0) {
  fail(`构建失败（退出码 ${build.code}）`)
  line('--- 构建输出（尾部） ---')
  for (const l of (build.stdout + build.stderr).trimEnd().split('\n').slice(-30)) line(l)
  printSummaryAndExit()
} else {
  const bundled = (build.stdout.match(/dist\/[^\s]+\.(?:js|css)/g) ?? []).length
  ok(`构建成功，产出 ${bundled} 个带哈希的 JS/CSS 文件`)
  for (const l of build.stdout.trimEnd().split('\n').slice(-4)) line(l)
}

// ---------------------------------------------------------------- 1. 体积
section('size', '交付包体积：总体积与最大单文件（超上限即失败）')
const files = walkDir(DIST)
const totalBytes = files.reduce((s, f) => s + f.size, 0)
const biggest = files.reduce((a, b) => (b.size > a.size ? b : a))
line(`总体积：量得 ${human(totalBytes)}｜上限 ${human(MAX_TOTAL_BYTES)}`)
line(`最大单文件：${biggest.rel} = ${human(biggest.size)}｜上限 ${human(MAX_FILE_BYTES)}`)
if (totalBytes > MAX_TOTAL_BYTES) fail(`总体积超限：${totalBytes} > ${MAX_TOTAL_BYTES}`)
else ok('总体积在上限以内')
if (biggest.size > MAX_FILE_BYTES) fail(`最大单文件超限：${biggest.rel} ${biggest.size} > ${MAX_FILE_BYTES}`)
else ok('最大单文件在上限以内')

// ---------------------------------------------------------------- 2. 外链
section('external', '产物外链扫描：发现任何会指向外部加载的地址即失败')
// 主机必须含点（真实域名，避免把压缩 JS 里正则字面量的 //g 之类误判为协议相对地址），
// 或为 localhost / IP——后两者在离线包里出现同样算外链问题
const urlRe =
  /(?:https?:)?\/\/(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?:[/?#][^\s"'<>`\\)]*)?/g
const findings = []
for (const f of files) {
  // 字体是二进制 TTF，其中的 ASCII 串不构成引用；文本类产物才扫
  if (/\.(ttf|woff2?|png|jpe?g|gif|ico|webp)$/i.test(f.rel)) continue
  const text = readFileSync(f.abs, 'latin1')
  for (const m of text.matchAll(urlRe)) {
    const url = m[0]
    let host = ''
    try {
      host = new URL(url.startsWith('//') ? `https:${url}` : url).host.toLowerCase()
    } catch {
      host = url
    }
    findings.push({ rel: f.rel, url, allowed: URL_HOST_ALLOWLIST.has(host) })
  }
}
const offenders = findings.filter((x) => !x.allowed)
const allowedHosts = [
  ...new Set(
    findings.filter((x) => x.allowed).map((x) => new URL(x.url.startsWith('//') ? `https:${x.url}` : x.url).host),
  ),
]
line(`共扫出 ${findings.length} 处外部地址字面量；白名单主机：${[...URL_HOST_ALLOWLIST].join('、')}`)
if (allowedHosts.length) line(`白名单命中（XML 命名空间标识符 / 框架错误文档，不发起加载）：${allowedHosts.join('、')}`)
if (offenders.length > 0) {
  for (const o of offenders.slice(0, 20)) fail(`外部地址：${o.url}（位于 ${o.rel}）`)
  if (offenders.length > 20) fail(`……另有 ${offenders.length - 20} 处`)
} else {
  ok('产物中没有任何指向外部加载的地址（纹样库/字体均为同源本地路径）')
}

// ---------------------------------------------------------------- 3. 纹样与字体
section('assets', '随包纹样与字体：一个不少，且与 public 源逐字节一致')
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
let assetsPass = true
for (const p of baseline.patterns) {
  const shipped = join(DIST, 'patterns', p.file)
  const source = join(APP_ROOT, 'public', 'patterns', p.file)
  if (!existsSync(shipped)) {
    fail(`纹样缺失：dist/patterns/${p.file}（${p.name}）`)
    assetsPass = false
    continue
  }
  if (sha256(shipped) !== sha256(source)) {
    fail(`纹样内容与 public 源不一致：${p.file}`)
    assetsPass = false
  }
}
const fontRefs = []
for (const f of files.filter((x) => x.rel.endsWith('.css'))) {
  const css = readFileSync(f.abs, 'utf8')
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    if (/\.(?:ttf|woff2?|otf|eot)$/i.test(m[1])) fontRefs.push(m[1])
  }
}
for (const font of baseline.fonts) {
  const shipped = join(DIST, 'fonts', font.file)
  const source = join(APP_ROOT, 'public', 'fonts', font.file)
  if (!existsSync(shipped)) {
    fail(`字体缺失：dist/fonts/${font.file}（${font.name}）`)
    assetsPass = false
    continue
  }
  if (sha256(shipped) !== sha256(source)) {
    fail(`字体内容与 public 源不一致：${font.file}`)
    assetsPass = false
  }
  if (!fontRefs.some((u) => u.endsWith(font.file))) {
    fail(`字体未被产物 CSS 引用：${font.file}`)
    assetsPass = false
  }
}
const patternCount = baseline.patterns.length
const shippedPatterns = existsSync(join(DIST, 'patterns'))
  ? readdirSync(join(DIST, 'patterns')).filter((x) => x.endsWith('.svg')).length
  : 0
line(`纹样：清单 ${patternCount} 个，dist/patterns 实有 ${shippedPatterns} 个 SVG；字体：${baseline.fonts.length} 个，CSS @font-face 引用 ${new Set(fontRefs).size} 个`)
if (shippedPatterns !== patternCount) {
  fail(`dist/patterns 数量 ${shippedPatterns} 与清单 ${patternCount} 不符（有多余或缺失）`)
  assetsPass = false
}
if (assetsPass) ok(`全部 ${patternCount} 个纹样与 ${baseline.fonts.length} 个字体随包、逐字节一致且被引用`)

// ---------------------------------------------------------------- 4+5. 打包并运行自检内核
mkdirSync(CACHE_DIR, { recursive: true })
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: [HARNESS_SRC],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: HARNESS_BUNDLE,
  alias: { '@': join(APP_ROOT, 'src') },
  define: { 'import.meta.env.BASE_URL': JSON.stringify('/') },
  logLevel: 'silent',
})

function runHarness(args) {
  const r = spawnSync(process.execPath, [HARNESS_BUNDLE, ...args], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: { ...process.env, APP_ROOT },
    maxBuffer: 64 * 1024 * 1024,
  })
  const m = /VERIFY_JSON(.*)VERIFY_JSON/s.exec(r.stdout)
  if (!m) return { __error: true, code: r.status, stdout: r.stdout, stderr: r.stderr }
  return JSON.parse(m[1])
}

section('selftest', '页面验收自检内核（/help 同一颗 runSelfTest）+ 轮廓数对验收记录')
const report = runHarness(['selftest'])
const contourSignatures = {}
if (report.__error) {
  fail(`harness 运行失败（退出码 ${report.code}）`)
  line((report.stderr || report.stdout || '').split('\n').slice(-20).join('\n'))
} else {
  const passed = report.checks.filter((c) => c.pass).length
  const failedChecks = report.checks.filter((c) => !c.pass)
  line(`自检用例 ${passed}/${report.checks.length} 通过；总耗时 ${Number(report.totalMs).toFixed(0)}ms`)
  if (failedChecks.length) {
    for (const c of failedChecks) fail(`[${c.id}] ${c.title}：${c.detail}`)
  } else {
    ok('全部自检用例通过')
  }

  // 每个纹样：内核跑出来的轮廓数 == 随包文件解析的轮廓数 == 验收记录
  let contourPass = true
  line('轮廓数三方核对（验收记录 / 自检内核 / 随包文件独立解析）：')
  for (const p of baseline.patterns) {
    const summary = report.summaries.find((s) => s.file === p.file)
    const shipped = report.shipped.find((s) => s.file === p.file)
    const nKernel = summary?.kept
    const nShipped = shipped?.contours
    contourSignatures[p.file] = nShipped
    const match = nKernel === p.expectedContours && nShipped === p.expectedContours
    if (!match) contourPass = false
    line(`  ${match ? '✓' : '✗'} ${p.file}：记录 ${p.expectedContours}｜内核 ${nKernel ?? '—'}｜随包 ${nShipped ?? '—'}`)
    if (!match) fail(`轮廓数对不上：${p.name}（${p.file}）记录 ${p.expectedContours} / 内核 ${nKernel} / 随包 ${nShipped}`)
  }
  if (contourPass) ok(`10 个纹样轮廓数与验收自检记录全部一致（${baseline.patterns.map((p) => contourSignatures[p.file]).join('/')}）`)
}

// ---------------------------------------------------------------- 6. A4 1:1 检查图
section('a4', 'A4 1:1 检查图：导出一份并按校验尺线段长度 + 纸张尺寸核对缩放')
mkdirSync(OUT_DIR, { recursive: true })
const a4meta = runHarness(['a4', A4_FILE])
if (a4meta.__error) {
  fail('A4 检查图导出失败')
  line((a4meta.stderr || a4meta.stdout || '').split('\n').slice(-20).join('\n'))
} else {
  const svg = readFileSync(A4_FILE, 'utf8')
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? ''
  const wMm = /\bwidth="([\d.]+)mm"/.exec(root)
  const hMm = /\bheight="([\d.]+)mm"/.exec(root)
  const vb = /\bviewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(root)
  const widthOk = wMm && Math.abs(Number(wMm[1]) - baseline.sheet.widthMm) < 1e-9
  const heightOk = hMm && Math.abs(Number(hMm[1]) - baseline.sheet.heightMm) < 1e-9
  const viewBoxOk = vb && Number(vb[1]) === baseline.sheet.widthMm && Number(vb[2]) === baseline.sheet.heightMm

  // 0.3 粗的长线段即检查图里的主校验尺：一条 100mm 横向、一条 50mm 竖向
  const rulers = []
  for (const m of svg.matchAll(/<line[^>]*stroke-width="0\.3"[^>]*>/g)) {
    const tag = m[0]
    const attr = (a) => Number(new RegExp(`${a}="([\\d.-]+)"`).exec(tag)?.[1] ?? NaN)
    const x1 = attr('x1'), y1 = attr('y1'), x2 = attr('x2'), y2 = attr('y2')
    rulers.push({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1) })
  }
  const horiz = rulers.filter((r) => Math.abs(r.y2 - r.y1) < 1e-9).sort((a, b) => b.len - a.len)[0]
  const vert = rulers.filter((r) => Math.abs(r.x2 - r.x1) < 1e-9).sort((a, b) => b.len - a.len)[0]
  const hErr = horiz ? Math.abs(horiz.len - baseline.ruler.horizontalMm) : Infinity
  const vErr = vert ? Math.abs(vert.len - baseline.ruler.verticalMm) : Infinity

  line(`纸张尺寸：量得 ${wMm?.[1] ?? '?'}mm × ${hMm?.[1] ?? '?'}mm，viewBox ${vb ? `${vb[1]}×${vb[2]}` : '?'}｜标准 ${baseline.sheet.widthMm}×${baseline.sheet.heightMm}mm`)
  line(`横校验尺：量得 ${horiz ? horiz.len.toFixed(3) : '未找到'}mm（标准 ${baseline.ruler.horizontalMm}mm，误差 ${horiz ? hErr.toFixed(3) : '—'}mm，容差 ±${baseline.ruler.toleranceMm}mm）`)
  line(`竖校验尺：量得 ${vert ? vert.len.toFixed(3) : '未找到'}mm（标准 ${baseline.ruler.verticalMm}mm，误差 ${vert ? vErr.toFixed(3) : '—'}mm，容差 ±${baseline.ruler.toleranceMm}mm）`)
  line(`导出文件：${relative(APP_ROOT, A4_FILE)}（${human(a4meta.bytes)}，打印时须选「实际大小 / 100%」）`)

  if (!widthOk) fail('检查图宽度不是 210mm（缩放或纸幅不对）')
  if (!heightOk) fail('检查图高度不是 297mm（缩放或纸幅不对）')
  if (!viewBoxOk) fail('viewBox 不是 0 0 210 297（1 用户单位 ≠ 1mm）')
  if (!horiz || hErr > baseline.ruler.toleranceMm) fail(`横 100mm 校验尺长度误差超限（${horiz ? hErr.toFixed(3) : '缺失'}mm）`)
  if (!vert || vErr > baseline.ruler.toleranceMm) fail(`竖 50mm 校验尺长度误差超限（${vert ? vErr.toFixed(3) : '缺失'}mm）`)
  if (widthOk && heightOk && viewBoxOk && horiz && hErr <= baseline.ruler.toleranceMm && vert && vErr <= baseline.ruler.toleranceMm) {
    ok('检查图为 210×297mm、viewBox 1:1，横/竖校验尺长度均与标准一致（1:1 打印缩放正确）')
  }
}

// ---------------------------------------------------------------- 7. 带参数页面地址
const server = await serveDist(DIST)
section('routes', '带参数页面地址直开：都必须落到同一个入口（SPA 回退），不能空白页')
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8')
const entryPaths = ['/', '/design/demo-1', '/layout/demo-1?from=selftest', '/export/demo-1?format=plt', '/materials', '/help', '/design/不存在的纹样']
for (const p of entryPaths) {
  const r = await httpGet(server.port, p)
  const isEntry = r.status === 200 && r.body === indexHtml && r.body.includes('<div id="app">')
  if (!isEntry) fail(`GET ${p} → ${r.status}，没有回到同一入口 index.html（可能是空白/404 页）`)
  else ok(`GET ${p} → 200，内容即入口 index.html（${r.body.length} B，含 #app 挂载点）`)
}
// 真正缺失的哈希资源必须 404（确认回退只作用于页面，不会吞坏资源）
const missingAsset = await httpGet(server.port, '/assets/does-not-exist-HASH.js')
if (missingAsset.status !== 404) fail(`GET /assets/does-not-exist-HASH.js → ${missingAsset.status}，缺失资源应明确 404`)
else ok('GET /assets/does-not-exist-HASH.js → 404（缺失资源不被 SPA 回退吞掉）')
// index.html 引用的入口脚本（Vite 产物为 type="module"）必须真实存在；
// 先去掉 HTML 注释再取 src，避免把注释里的 <script src=...> 误当成入口
const indexNoComments = indexHtml.replace(/<!--[\s\S]*?-->/g, '')
const entryScript =
  /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(indexNoComments)?.[1] ??
  /<script[^>]*\bsrc="([^"]+)"/.exec(indexNoComments)?.[1] ??
  ''
if (entryScript && existsSync(join(DIST, entryScript.replace(/^\//, '')))) ok(`入口脚本 ${entryScript} 在产物中存在，页面非空白`)
else fail(`index.html 引用的入口脚本 ${entryScript || '(未找到)'} 在产物中不存在`)
server.close()

// ---------------------------------------------------------------- 8. 容器
const containerTool = detectContainerTool()
section('container', '容器冒烟（构建镜像 → 起容器 → healthz/深路径 → 镜像体积）')
if (!containerTool) {
  line('结论：跳过。原因：本机 PATH 中未找到 docker 或 podman（容器工具不存在），无法执行镜像构建与起容器。')
  line('页面/路由验证已由上一节的本机静态服务器等效完成；在装有容器工具的机器上重跑本命令会自动补上容器冒烟。')
  // 跳过项不算失败，单独标记
  current.skipped = true
} else {
  const imageTag = 'app-027-verify:local'
  const port = 8257
  line(`检测到容器工具：${containerTool}`)
  const imgBuild = run(containerTool, ['build', '-t', imageTag, '.'], { timeoutMs: 600000 })
  if (imgBuild.code !== 0) {
    fail(`镜像构建失败（退出码 ${imgBuild.code}）`)
    line((imgBuild.stderr || imgBuild.stdout).split('\n').slice(-15).join('\n'))
  } else {
    ok('镜像构建成功')
    run(containerTool, ['rm', '-f', 'app-027-verify-run'])
    const up = run(containerTool, ['run', '-d', '--name', 'app-027-verify-run', '-p', `${port}:80`, imageTag])
    if (up.code !== 0) {
      fail('容器启动失败')
      line((up.stderr || up.stdout).split('\n').slice(-10).join('\n'))
    } else {
      await new Promise((r) => setTimeout(r, 1500))
      let health = ''
      let rootStatus = -1
      try {
        health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()
        rootStatus = (await fetch(`http://127.0.0.1:${port}/design/container-smoke`)).status
      } catch {
        /* 保留默认值 */
      }
      if (health.trim() === 'ok' && rootStatus === 200) {
        ok('容器内服务健康：GET /healthz → "ok"，GET /design/container-smoke → 200（SPA 回退）')
      } else {
        fail(`容器内服务异常：healthz=${JSON.stringify(health.trim())}，深路径状态=${rootStatus}`)
      }
      const insp = run(containerTool, ['image', 'inspect', imageTag, '--format', '{{.Size}}'])
      const size = Number.parseInt(insp.stdout.trim(), 10)
      if (Number.isFinite(size)) {
        line(`镜像体积：量得 ${human(size)}｜上限 ${human(MAX_IMAGE_BYTES)}`)
        if (size > MAX_IMAGE_BYTES) fail(`镜像体积超限：${size} > ${MAX_IMAGE_BYTES}`)
        else ok('镜像体积在上限以内')
      }
      run(containerTool, ['rm', '-f', 'app-027-verify-run'])
    }
    run(containerTool, ['rmi', imageTag])
  }
}

// ---------------------------------------------------------------- 9. 两次一致性
section('repeatability', '两次连跑一致性：本次关键值与上一次快照比较')
const snapshotData = {
  totalBytes,
  biggestFile: biggest.rel,
  biggestSize: biggest.size,
  externalOffenders: offenders.map((o) => `${o.rel}|${o.url}`),
  contours: contourSignatures,
  checkVerdicts: report.__error ? [] : report.checks.map((c) => `${c.id}:${c.pass}`),
}
let previous = null
if (existsSync(SNAPSHOT)) {
  try {
    previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  } catch {
    previous = null
  }
}
if (!previous) {
  line('未发现上一次快照：本次若全部通过，将在汇总后写入基线快照；再跑一次本命令即会与之比对。')
  line(`快照位置：${relative(APP_ROOT, SNAPSHOT)}（体积/最大文件/外链结论/10 纹样轮廓数/逐项自检结论；耗时类数值不参与比较）`)
  ok('首次运行：通过后记录基线，结论有效')
} else {
  const diffs = []
  for (const key of ['totalBytes', 'biggestFile', 'biggestSize', 'externalOffenders', 'contours', 'checkVerdicts']) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(snapshotData[key])) {
      diffs.push(`${key}: 上次 ${JSON.stringify(previous[key]).slice(0, 120)} → 本次 ${JSON.stringify(snapshotData[key]).slice(0, 120)}`)
    }
  }
  if (diffs.length === 0) ok('与上一次完全一致：体积、最大文件、外链结论、10 个纹样轮廓数、自检逐项结论全部相同')
  else for (const d of diffs) fail(`两次结果不一致：${d}`)
}

// ---------------------------------------------------------------- 汇总
function printSummaryAndExit() {
  const failedList = checks.filter((c) => !c.pass)
  const skipped = checks.filter((c) => c.skipped)
  console.log('\n================ 验收汇总 ================')
  for (const c of checks) {
    const tag = c.skipped ? '○ 跳过' : c.pass ? '✓ 通过' : '✗ 失败'
    console.log(`${tag}  [${c.id}] ${c.title}`)
  }
  console.log('==========================================')
  if (failedList.length) {
    console.log(`\n结论：${failedList.length} 项未通过 —— ${failedList.map((c) => `【${c.id}】${c.title}`).join('；')}`)
    console.log('（本次存在失败项，未更新一致性快照基线）')
    finish(1)
  }
  // 全部通过才落盘快照，保证失败运行不会污染基线
  writeFileSync(SNAPSHOT, JSON.stringify(snapshotData, null, 2))
  if (!previous) line(`基线快照已写入：${relative(APP_ROOT, SNAPSHOT)}`)
  const skipNote = skipped.length ? `（${skipped.length} 项按规则跳过：${skipped.map((c) => c.id).join('、')}）` : ''
  console.log(`\n结论：全部必检项通过${skipNote}，这包拷到无网机器可直接用。`)
  finish(0)
}

printSummaryAndExit()
