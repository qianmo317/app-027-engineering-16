#!/usr/bin/env node
/**
 * 交付一键验收（离线交付包）—— 一条命令跑完人工交付前检查：
 *
 *   1. 生产构建（vue-tsc 类型检查 + vite build）
 *   2. 包总体积 / 最大单文件（超上限失败，上限可用环境变量覆盖）
 *   3. 扫产物里指向外部的地址（白名单外的一律失败）
 *   4. 随包纹样与字体一个不少（与 public 源文件逐字节一致）
 *   5. 每个纹样解析出的轮廓数与 README 里页面验收自检记录对账
 *   6. 导出 A4 1:1 检查图，量 100mm 横尺 / 50mm 竖尺与 210×297mm 纸幅
 *   7. 起服务打开几个带参数页面，确认全部回退到同一个 index.html 入口（非空白页）
 *   8. 经 HTTP 跑 /help 页面那套「验收自检」（第 10 节全部用例）
 *   9. 容器：有 docker/podman 就构建镜像、起容器、查 /healthz、量镜像；
 *      这台机器没有容器工具时，这些步骤全部跳过并写明原因（路由检查改走本地预览）
 *
 * 第 2~8 项连跑两轮，逐项比对量到的值，作为「连着跑两次结论一致」的断言。
 *
 * 退出码：全部通过（允许有 SKIP）= 0；任何一项 FAIL = 1。
 *
 * 可用环境变量覆盖上限：
 *   RC_PACKAGE_MAX_MB   包总体积上限（MiB，默认 2）
 *   RC_SINGLE_MAX_KB    单文件体积上限（KiB，默认 512）
 *   RC_IMAGE_MAX_MB     容器镜像上限（MiB，默认 60，规格书 §12）
 *   RC_ROUNDS           重复轮数（默认 2）
 *   RC_SKIP_BUILD=1     跳过构建沿用现有 dist（仅调试失败路径用，正式交付勿设）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------- 常量/路径
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DIST = join(ROOT, 'dist')
const PUBLIC = join(ROOT, 'public')
const OUT = join(HERE, 'out')
const PACKAGE_MAX_BYTES = Math.round(Number(process.env.RC_PACKAGE_MAX_MB ?? 2) * 1024 * 1024)
const SINGLE_MAX_BYTES = Math.round(Number(process.env.RC_SINGLE_MAX_KB ?? 512) * 1024)
const IMAGE_MAX_BYTES = Math.round(Number(process.env.RC_IMAGE_MAX_MB ?? 60) * 1024 * 1024)
const RULER_TOL_MM = 1
const ROUNDS = Math.max(1, Number(process.env.RC_ROUNDS ?? 2))
const PREVIEW_PORT = 4173
const PATTERN_FILES = [
  'window-flower-classic.svg',
  'concentric-three.svg',
  'self-cross-flower.svg',
  'open-spiral.svg',
  'petal-scatter.svg',
  'xi-double-happiness.svg',
  'zodiac-rabbit.svg',
  'zodiac-dragon.svg',
  'lace-border.svg',
  'butterfly-marriage.svg',
]
const FONT_FILE = 'plotter-mono.ttf'
/** 外部地址白名单：SVG 命名空间标识符（XML 规范 ID，浏览器不发起网络请求）
 *  与 Vue 运行时错误提示里的参考文档链接（只在报错文本中出现，不预取、不断网不影响功能） */
const URL_ALLOWLIST = [/^https?:\/\/([a-z0-9-]+\.)*w3\.org\//i, /^https?:\/\/vuejs\.org\/error-reference\//i]
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.xml', '.txt', '.map'])

// ---------------------------------------------------------------- 小工具
const c = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
const human = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push({ path: p, rel: p.slice(dir.length + 1), size: st.size })
  }
  return out
}

/** 调 esbuild 把 TS harness 与应用内核一起打成单文件 CJS（只需应用 devDependencies 里已有的 esbuild） */
function buildHarness() {
  const esbuild = require(join(ROOT, 'node_modules', 'esbuild'))
  const bundle = join(OUT, 'harness.cjs')
  esbuild.buildSync({
    entryPoints: [join(HERE, 'harness.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.MODE': '"production"' },
    logLevel: 'silent',
  })
  return bundle
}

function runHarness(bundle, command, argv = [], extraEnv = {}) {
  const r = run(process.execPath, [bundle, command, ...argv], { env: { ...process.env, CHECK_DIST: DIST, ...extraEnv } })
  if (r.status !== 0) throw new Error(`harness ${command} 退出码 ${r.status}\n${r.stderr}`)
  const line = r.stdout.split('\n').find((l) => l.startsWith('__CHECK_JSON__'))
  if (!line) throw new Error(`harness ${command} 未输出结果\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(line.slice('__CHECK_JSON__'.length))
}

// ---------------------------------------------------------------- 检查记录
/** @typedef {{id:string,name:string,measured:string,limit:string,status:'PASS'|'FAIL'|'SKIP',detail?:string,compare?:unknown}} Check */
function makeCheck(id, name) {
  return { id, name, measured: '', limit: '', status: 'PASS', detail: '', compare: null }
}
function finish(ch, pass, measured, limit, detail = '', compare = null) {
  ch.measured = measured
  ch.limit = limit
  ch.status = pass ? 'PASS' : 'FAIL'
  ch.detail = detail
  ch.compare = compare
  return ch
}
function skip(ch, measured, reason) {
  ch.measured = measured
  ch.limit = '—（本机环境不适用）'
  ch.status = 'SKIP'
  ch.detail = reason
  return ch
}
function printCheck(ch) {
  const tag = ch.status === 'PASS' ? c.green('[通过]') : ch.status === 'FAIL' ? c.red('[失败]') : c.yellow('[跳过]')
  console.log(`  ${tag} ${c.bold(ch.name)}`)
  console.log(`        量到：${ch.measured}${ch.limit ? `｜上限/标准：${ch.limit}` : ''}｜结论：${ch.status}`)
  if (ch.detail) console.log(c.dim(`        ${ch.detail}`))
}

// ---------------------------------------------------------------- 各检查项
function checkSizes() {
  const files = walk(DIST)
  const total = files.reduce((a, f) => a + f.size, 0)
  const biggest = files.reduce((a, f) => (f.size > a.size ? f : a), files[0])
  const chTotal = makeCheck('package-size', '交付包总体积（dist 全量）')
  finish(
    chTotal,
    total <= PACKAGE_MAX_BYTES,
    `${human(total)}（${files.length} 个文件）`,
    `≤ ${human(PACKAGE_MAX_BYTES)}（RC_PACKAGE_MAX_MB 可覆盖）`,
    `目录：${DIST}`,
    total,
  )
  const chBig = makeCheck('largest-file', '最大单文件')
  finish(
    chBig,
    biggest.size <= SINGLE_MAX_BYTES,
    `${biggest.rel} = ${human(biggest.size)}`,
    `≤ ${human(SINGLE_MAX_BYTES)}（RC_SINGLE_MAX_KB 可覆盖）`,
    '',
    { rel: biggest.rel, size: biggest.size },
  )
  return [chTotal, chBig]
}

function checkExternalRefs() {
  const ch = makeCheck('external-refs', '产物外部地址扫描（断网可用性）')
  const hits = []
  const urlRe = /(?:https?|wss?):\/\/[^\s"'`<>)]+/gi
  const protoRelRe = /(?:url\(\s*|["'`])\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)]*/gi
  for (const f of walk(DIST)) {
    const dot = f.rel.slice(f.rel.lastIndexOf('.'))
    if (!TEXT_EXT.has(dot)) continue
    const text = readFileSync(f.path, 'utf8')
    for (const m of text.matchAll(urlRe)) {
      const url = m[0].replace(/[.,;]+$/, '')
      hits.push({ file: f.rel, url, allowed: URL_ALLOWLIST.some((re) => re.test(url)) })
    }
    for (const m of text.matchAll(protoRelRe)) {
      hits.push({ file: f.rel, url: m[0].replace(/^url\(\s*/, '').replace(/^["'`]/, ''), allowed: false })
    }
  }
  const bad = hits.filter((h) => !h.allowed)
  const allowedNote = hits
    .filter((h) => h.allowed)
    .map((h) => h.url)
    .filter((v, i, a) => a.indexOf(v) === i)
  finish(
    ch,
    bad.length === 0,
    `外部地址命中 ${hits.length} 处，其中非白名单 ${bad.length} 处`,
    '非白名单外部地址 = 0',
    bad.length
      ? `违规：\n${bad.map((h) => `          - ${h.file}: ${h.url}`).join('\n')}`
      : `白名单豁免（不发网络请求，已逐一确认）：\n${allowedNote.map((u) => `          - ${u}`).join('\n')}`,
    hits.map((h) => `${h.file}|${h.url}|${h.allowed}`),
  )
  return [ch]
}

function checkBundledAssets() {
  const ch = makeCheck('bundled-assets', '随包纹样与字体齐全（逐字节核对）')
  const missing = []
  const diff = []
  const present = []
  for (const f of [...PATTERN_FILES, FONT_FILE]) {
    const kind = f.endsWith('.svg') ? 'patterns' : 'fonts'
    const inDist = join(DIST, kind, f)
    const inPub = join(PUBLIC, kind, f)
    if (!existsSync(inDist)) missing.push(`${kind}/${f}`)
    else if (sha256(readFileSync(inDist)) !== sha256(readFileSync(inPub))) diff.push(f)
    else present.push(`${kind}/${f} (${human(statSync(inDist).size)})`)
  }
  const n = PATTERN_FILES.length + 1
  const patternOk = PATTERN_FILES.filter((f) => !missing.includes(`patterns/${f}`) && !diff.includes(f)).length
  const fontOk = !missing.includes(`fonts/${FONT_FILE}`) && !diff.includes(FONT_FILE) ? 1 : 0
  finish(
    ch,
    missing.length === 0 && diff.length === 0,
    `纹样 ${patternOk}/${PATTERN_FILES.length}、字体 ${fontOk}/1（齐全且与源文件逐字节一致）`,
    `${n}/${n} 齐全且一致`,
    missing.length || diff.length
      ? `缺失：${missing.join('，') || '无'}；内容不一致：${diff.join('，') || '无'}`
      : present.map((p) => `          - ${p}`).join('\n'),
    present.slice().sort(),
  )
  return [ch]
}

/** README 验收记录：27/23/6/4/24/23/28/12/10/23 条轮廓（顺序同纹样库索引） */
function readmeBaseline() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const m = /(\d+(?:\/\d+){9})\s*条轮廓/.exec(readme)
  if (!m) throw new Error('README.md 里找不到「…条轮廓」验收记录')
  return m[1].split('/').map(Number)
}

function checkContours(rows, baseline, source) {
  const ch = makeCheck('contour-counts', `纹样轮廓数与页面验收自检记录对账（${source}）`)
  const measured = rows.map((r) => r.contours)
  const mism = []
  const lines = rows.map((r, i) => {
    const ok = r.contours === baseline[i]
    if (!ok) mism.push(`${r.file}: 实测 ${r.contours} ≠ 记录 ${baseline[i]}`)
    return `          ${ok ? '✓' : '✗'} ${r.file.padEnd(30)} 实测 ${String(r.contours).padStart(2)}｜记录 ${baseline[i]}`
  })
  finish(
    ch,
    mism.length === 0 && measured.length === PATTERN_FILES.length,
    measured.join('/'),
    baseline.join('/'),
    lines.join('\n'),
    measured,
  )
  return ch
}

function a4CheckFromResult(r, a4File) {
  const ch = makeCheck('a4-ruler', 'A4 一比一检查图（校验尺 + 纸张尺寸）')
  const hErr = r.rulerHorizontalMm == null ? null : Math.abs(r.rulerHorizontalMm - 100)
  const vErr = r.rulerVerticalMm == null ? null : Math.abs(r.rulerVerticalMm - 50)
  const paperOk = r.widthAttr && r.heightAttr && r.viewBoxOk
  const rulerOk = hErr != null && vErr != null && hErr <= RULER_TOL_MM && vErr <= RULER_TOL_MM
  finish(
    ch,
    rulerOk && paperOk,
    `横尺 ${r.rulerHorizontalMm?.toFixed(3)}mm（标准 100，误差 ${hErr?.toFixed(3)}）｜` +
      `竖尺 ${r.rulerVerticalMm?.toFixed(3)}mm（标准 50，误差 ${vErr?.toFixed(3)}）｜` +
      `纸幅 ${r.paperWidthMm}×${r.paperHeightMm}mm（width/height 属性=${r.widthAttr && r.heightAttr}，viewBox 1:1=${r.viewBoxOk}）`,
    `尺误差 ≤ ${RULER_TOL_MM}mm；纸幅 210×297mm；viewBox="0 0 210 297"`,
    `已导出：${a4File}（打印时选「实际大小/100%」，用直尺复核横尺应为 100mm）`,
    { h: r.rulerHorizontalMm, v: r.rulerVerticalMm, paperOk },
  )
  return ch
}

async function waitForServer(origin, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(origin + '/', { signal: AbSignal(2000) })
      if (res.status === 200) return true
    } catch {}
    await sleep(300)
  }
  return false
}
function AbSignal(ms) {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), ms)
  return ac.signal
}

function startPreview() {
  // 直接起 vite 可执行文件（不走 npm run：npm 包装进程收到 SIGTERM 不会带走 vite 子进程，会泄漏 4173 端口）
  const bin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const log = join(OUT, 'preview.log')
  const child = spawn(process.execPath, [bin, 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 自成进程组，stop 时整组回收
  })
  let buf = ''
  const append = (d) => { buf += d }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  let stopped = false
  return {
    child,
    origin: `http://127.0.0.1:${PREVIEW_PORT}`,
    stop() {
      if (stopped) return
      stopped = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      writeFileSync(log, buf)
    },
  }
}

async function checkEntryRoutes(origin, source) {
  const paths = [
    '/',
    '/design/window-flower-classic',
    '/layout/petal-scatter',
    '/export/xi-double-happiness',
    '/materials',
    '/help',
    '/this/route/does/not/exist',
  ]
  const bodies = new Map()
  const rows = []
  for (const p of paths) {
    const res = await fetch(origin + p, { redirect: 'manual', signal: AbSignal(5000) })
    const text = await res.text()
    bodies.set(p, { status: res.status, hash: sha256(text), size: text.length, text })
    rows.push({ path: p, status: res.status, size: text.length })
  }
  const home = bodies.get('/')
  const index = home.text
  const hasApp = /<div id="app"><\/div>/.test(index)
  const scripts = [...index.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
  const sameEntry = [...bodies.values()].every((b) => b.hash === home.hash && b.status === 200)
  // 生产 index.html 被压到很小（本包 421B），非空白靠结构判定而非体积：有挂载点、有入口脚本，且脚本 HTTP 可达（asset-http 项）
  const nonBlank = home.size >= 200 && scripts.length > 0 && hasApp
  const ch = makeCheck('entry-routes', `带参数页面全部落到同一入口（${source}）`)
  finish(
    ch,
    sameEntry && nonBlank,
    rows.map((r) => `${r.path}→${r.status}/${r.size}B`).join('｜'),
    '7 个地址全部 200 且返回体与 / 完全一致（SPA 回退到同一 index.html）',
    `入口 HTML ${home.size}B，含 #app=${hasApp}，引用 ${scripts.length} 个脚本：${scripts.join('、')}\n` +
      `非空白判定：返回体一致 + 含挂载点 + 入口脚本存在（脚本 HTTP 可达性由 asset-http 项确认）`,
    home.hash,
  )
  return { ch, scripts, indexText: index }
}

async function checkAssetHttp(origin, indexText, sourceLabel) {
  const ch = makeCheck('asset-http', `随包纹样/字体/入口脚本经服务可达（${sourceLabel}）`)
  const probes = [
    { url: '/patterns/self-cross-flower.svg', disk: join(DIST, 'patterns/self-cross-flower.svg'), type: '纹样' },
    { url: `/patterns/${PATTERN_FILES[0]}`, disk: join(DIST, 'patterns', PATTERN_FILES[0]), type: '纹样' },
    { url: `/fonts/${FONT_FILE}`, disk: join(DIST, 'fonts', FONT_FILE), type: '字体' },
  ]
  const scriptSrc = [...indexText.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])[0]
  if (scriptSrc) probes.push({ url: scriptSrc, disk: join(DIST, scriptSrc.replace(/^\//, '')), type: '入口脚本' })
  const detail = []
  let ok = true
  for (const p of probes) {
    const res = await fetch(origin + p.url, { signal: AbSignal(5000) })
    const buf = Buffer.from(await res.arrayBuffer())
    const same = res.status === 200 && sha256(buf) === sha256(readFileSync(p.disk))
    if (!same) ok = false
    detail.push(`${same ? '✓' : '✗'} ${p.type} ${p.url} → HTTP ${res.status}，${human(buf.length)}，与包内文件${same ? '一致' : '不一致'}`)
  }
  finish(ch, ok, detail.map((d) => d.replace(/^[✓✗] /, '')).join('｜'), '全部 HTTP 200 且与 dist 内文件 sha256 一致', detail.map((d) => `          ${d}`).join('\n'), probes.length)
  return ch
}

function checkSelftest(report) {
  const ch = makeCheck('selftest', '页面验收自检（/help「运行验收自检」同一套代码，经 HTTP 读包内纹样）')
  const allPass = report.total === 19 && report.failed.length === 0
  const baseline = readmeBaseline()
  const httpCounts = report.summaries.map((s) => s.kept)
  const countsMatch = JSON.stringify(httpCounts) === JSON.stringify(baseline)
  const failList = report.failed.map((f) => `          - [${f.id}] ${f.title}：${f.detail}`).join('\n')
  finish(
    ch,
    allPass && countsMatch,
    `${report.passed}/${report.total} 通过；HTTP 自检解析轮廓数 ${httpCounts.join('/')}`,
    '19/19 通过；轮廓数与 README 记录 ' + baseline.join('/') + ' 一致',
    allPass
      ? `通过 HTTP 实际加载 dist/patterns/*.svg 完成（非源码直读），证明断网交付包内纹样可解析${countsMatch ? '' : '；但轮廓数与记录不符！'}`
      : `失败项：\n${failList || '（用例总数不是 19：实际 ' + report.total + '）'}`,
    { passed: report.passed, total: report.total, counts: httpCounts },
  )
  return ch
}

// ---------------------------------------------------------------- 容器相关
function detectRuntime() {
  const docker = run('bash', ['-lc', 'command -v docker && docker info >/dev/null 2>&1 && echo OK']).stdout.includes('OK')
  if (docker) return { bin: 'docker', compose: ['docker', 'compose'] }
  const podman = run('bash', ['-lc', 'command -v podman && podman info >/dev/null 2>&1 && echo OK']).stdout.includes('OK')
  if (podman) return { bin: 'podman', compose: ['podman', 'compose'] }
  // 区分「没装」和「装了但守护进程不可用」
  const installed = run('bash', ['-lc', 'command -v docker || command -v podman || true']).stdout.trim()
  return { bin: null, reason: installed ? `检测到 ${installed} 但守护进程不可用（docker/podman info 失败）` : '本机未安装 docker / podman（PATH 中均不存在）' }
}

function staticNginxCheck() {
  const ch = makeCheck('nginx-spa', '容器 nginx 配置：SPA 回退 / 资源缓存（静态核对）')
  const conf = readFileSync(join(ROOT, 'nginx.conf'), 'utf8')
  const spa = /try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/.test(conf)
  const health = /location\s*=\s*\/healthz/.test(conf)
  const patterns = /location\s*\^~\s*\/patterns\//.test(conf)
  const fonts = /location\s*\^~\s*\/fonts\//.test(conf)
  const ok = spa && health && patterns && fonts
  finish(
    ch,
    ok,
    `SPA 回退=${spa}｜/healthz=${health}｜/patterns/=${patterns}｜/fonts/=${fonts}`,
    '四项配置必须全部存在',
    '该检查不依赖容器运行时，保证日后在有容器工具的机器上构建出的镜像行为正确',
    { spa, health, patterns, fonts },
  )
  return ch
}

function containerPort() {
  const yml = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
  const m = /['"]?(\d+):80['"]?/.exec(yml)
  return m ? Number(m[1]) : 8107
}

async function containerSteps(rt) {
  const checks = []
  const chRt = makeCheck('container-runtime', '容器运行时探测')
  if (!rt.bin) {
    skip(chRt, '未发现可用的 docker / podman', rt.reason)
    checks.push(chRt)
    for (const id of ['container-build', 'container-up', 'container-routes', 'image-size', 'container-down']) {
      const s = makeCheck(id, {
        'container-build': '容器镜像构建',
        'container-up': '容器启动与 /healthz',
        'container-routes': '容器内带参数路由',
        'image-size': '运行镜像体积',
        'container-down': '容器清理',
      }[id])
      skip(s, '—', `跳过原因：${rt.reason}；路由/入口检查改由本地 vite preview 对同一 dist 产物执行，结论等价`)
      checks.push(s)
    }
    return checks
  }
  finish(chRt, true, `检测到 ${rt.bin} 且守护进程可用`, '存在即可执行容器步骤')
  checks.push(chRt)

  const port = containerPort()
  const composeArgs = ['compose', '-f', join(ROOT, 'docker-compose.yml'), '-p', 'app027_releasecheck']

  const chBuild = makeCheck('container-build', '容器镜像构建（多阶段 Dockerfile）')
  const b = run(rt.bin, [...composeArgs, 'build'], { timeout: 600000 })
  finish(chBuild, b.status === 0, `退出码 ${b.status}`, '退出码 0', b.status === 0 ? '' : b.stderr.split('\n').slice(-15).join('\n'))
  checks.push(chBuild)
  if (b.status !== 0) return checks

  const chUp = makeCheck('container-up', `容器启动与 /healthz（:${port}）`)
  const u = run(rt.bin, [...composeArgs, 'up', '-d'])
  let healthOk = false
  if (u.status === 0) {
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbSignal(2000) })
        if (res.status === 200 && (await res.text()).trim() === 'ok') { healthOk = true; break }
      } catch {}
      await sleep(1000)
    }
  }
  finish(chUp, u.status === 0 && healthOk, `up 退出码 ${u.status}；/healthz=${healthOk ? '200 ok' : '未通过'}`, 'up=0 且 /healthz 返回 200 ok', u.status === 0 ? '' : u.stderr.split('\n').slice(-10).join('\n'))
  checks.push(chUp)

  if (u.status === 0 && healthOk) {
    const origin = `http://127.0.0.1:${port}`
    const routes = await checkEntryRoutes(origin, '容器 nginx')
    const chRoutes = routes.ch
    chRoutes.id = 'container-routes'
    chRoutes.name = '容器内带参数页面全部落到同一入口'
    checks.push(chRoutes)
  } else {
    const s = makeCheck('container-routes', '容器内带参数路由')
    skip(s, '—', '容器未启动或健康检查未通过，无法在容器内测路由')
    checks.push(s)
  }

  const chSize = makeCheck('image-size', '运行镜像体积（docker image inspect rootfs）')
  const insp = run(rt.bin, ['image', 'inspect', 'app-027-engineering-16:latest', '--format', '{{.Size}}'])
  const bytes = Number((insp.stdout || '').trim())
  finish(chSize, insp.status === 0 && bytes > 0 && bytes <= IMAGE_MAX_BYTES, Number.isFinite(bytes) ? human(bytes) : `inspect 失败：${insp.stderr}`, `≤ ${human(IMAGE_MAX_BYTES)}（规格书 §12：镜像 < 60MB）`, '', bytes)
  checks.push(chSize)

  const chDown = makeCheck('container-down', '容器清理（compose down）')
  const d = run(rt.bin, [...composeArgs, 'down', '--remove-orphans'])
  finish(chDown, d.status === 0, `退出码 ${d.status}`, '退出码 0')
  checks.push(chDown)
  return checks
}

// ---------------------------------------------------------------- 主流程
function consistencyCheck(rounds) {
  const ch = makeCheck('consistency', `连跑 ${ROUNDS} 轮结论一致（确定性比对）`)
  const keys = new Set()
  rounds[0].forEach((x) => keys.add(x.id))
  const diffs = []
  for (const id of keys) {
    const vals = rounds.map((r) => {
      const x = r.find((y) => y.id === id)
      return x ? { status: x.status, compare: JSON.stringify(x.compare) } : null
    })
    const base = JSON.stringify(vals[0])
    vals.forEach((v, i) => {
      if (JSON.stringify(v) !== base) diffs.push(`${id}：第 1 轮 ${base} ≠ 第 ${i + 1} 轮 ${JSON.stringify(v)}`)
    })
  }
  finish(ch, diffs.length === 0, `参与比对的 ${keys.size} 项在 ${ROUNDS} 轮中状态与测量值全部一致`, '两轮逐项相等（体积/轮廓数/校验尺/外链清单/入口哈希/自检结果）', diffs.map((d) => `          - ${d}`).join('\n'))
  return ch
}

async function main() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  console.log(c.bold('\n=== 剪纸刻绘工作室 · 离线交付包一键验收 ===\n'))

  // 0) 依赖
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.log('node_modules 不存在，先执行 npm ci ……')
    const r = run('npm', ['ci'], { timeout: 600000 })
    if (r.status !== 0) {
      console.log(c.red('npm ci 失败：\n' + r.stderr))
      process.exit(1)
    }
  }

  // 1) 构建（只构建一次；两轮针对同一产物）
  // RC_SKIP_BUILD=1 仅用于本地调试校验逻辑（例如手动篡改 dist 验证失败路径）；正常交付检查必须带构建
  const skipBuild = process.env.RC_SKIP_BUILD === '1'
  const chBuild = makeCheck('build', '生产构建（vue-tsc --noEmit && vite build）')
  if (skipBuild) {
    if (!existsSync(join(DIST, 'index.html'))) {
      console.log(c.red('RC_SKIP_BUILD=1 但 dist/index.html 不存在，无法跳过构建。'))
      process.exit(1)
    }
    skip(chBuild, `跳过（RC_SKIP_BUILD=1），沿用现有 dist（${human(statSync(DIST).size)} 目录项）`, '调试开关：正常交付验收不要设置该变量')
    console.log(c.bold('── 0. 构建 ──'))
    printCheck(chBuild)
    console.log(c.yellow('  注意：本轮跳过了构建，只适合本地调试校验逻辑。'))
  } else {
    const t0 = Date.now()
    const b = run('npm', ['run', 'build'], { timeout: 300000 })
    const buildMs = Date.now() - t0
    finish(chBuild, b.status === 0, `退出码 ${b.status}，耗时 ${(buildMs / 1000).toFixed(1)}s`, '退出码 0', b.status === 0 ? '' : b.stdout.split('\n').slice(-20).join('\n') + '\n' + b.stderr.split('\n').slice(-20).join('\n'))
    console.log(c.bold('── 0. 构建 ──'))
    printCheck(chBuild)
    if (b.status !== 0) {
      console.log(c.red('\n构建失败，后续检查无产物可验，终止。'))
      process.exit(1)
    }
  }

  // 静态配置检查（与轮次无关）
  const chNginx = staticNginxCheck()

  // harness 打包
  const harness = buildHarness()
  const baseline = readmeBaseline()

  // 本地预览服务（两轮共用）；任何退出路径都回收子进程，避免 4173 端口被残留进程占用
  console.log(c.bold(`\n── 启动本地预览服务（vite preview :${PREVIEW_PORT}，两轮共用）──`))
  const preview = startPreview()
  const cleanupPreview = () => { try { preview.stop() } catch {} }
  process.once('exit', cleanupPreview)
  process.once('SIGINT', () => { cleanupPreview(); process.exit(130) })
  process.once('SIGTERM', () => { cleanupPreview(); process.exit(143) })
  const serverOk = await waitForServer(preview.origin)
  if (!serverOk) {
    cleanupPreview()
    console.log(c.red(`预览服务 ${preview.origin} 在 30s 内未就绪，见 ${join(OUT, 'preview.log')}`))
    process.exit(1)
  }
  console.log(c.dim(`服务就绪：${preview.origin}`))

  const rounds = []
  try {
    for (let round = 1; round <= ROUNDS; round++) {
      console.log(c.bold(`\n── 第 ${round}/${ROUNDS} 轮验收 ──`))
      const checks = []

      for (const x of checkSizes()) { checks.push(x); printCheck(x) }
      for (const x of checkExternalRefs()) { checks.push(x); printCheck(x) }
      for (const x of checkBundledAssets()) { checks.push(x); printCheck(x) }

      // 轮廓数：harness 直接解析包内 SVG
      const contours = runHarness(harness, 'contours')
      const chContours = checkContours(contours.rows, baseline, '直接解析 dist 产物')
      checks.push(chContours); printCheck(chContours)

      // A4 1:1 检查图
      const a4Out = join(OUT, `a4-check-round${round}.svg`)
      const a4Res = runHarness(harness, 'a4', [a4Out])
      const chA4 = a4CheckFromResult(a4Res, a4Out)
      checks.push(chA4); printCheck(chA4)

      // HTTP：入口路由 / 资源可达 / 页面自检
      const routes = await checkEntryRoutes(preview.origin, '本地 vite preview')
      checks.push(routes.ch); printCheck(routes.ch)
      const chAsset = await checkAssetHttp(preview.origin, routes.indexText, '本地 vite preview')
      checks.push(chAsset); printCheck(chAsset)

      const st = runHarness(harness, 'selftest', [], { CHECK_BASE_URL: preview.origin + '/' })
      const chSelf = checkSelftest(st)
      checks.push(chSelf); printCheck(chSelf)

      rounds.push(checks)
    }
  } finally {
    preview.stop()
  }

  // nginx 静态配置（轮次外，只报一次，但参与一致性时两轮视为相同）
  console.log(c.bold('\n── 容器配置静态核对 ──'))
  printCheck(chNginx)

  // 容器步骤
  console.log(c.bold('\n── 容器步骤 ──'))
  const rt = detectRuntime()
  const ctrChecks = await containerSteps(rt)
  for (const x of ctrChecks) printCheck(x)

  // 两轮一致性
  console.log(c.bold(`\n── 重复性 ──`))
  // 把轮次外的检查并入每轮视图用于比对（构建/nginx/容器在两轮间天然相同）
  const fixed = [chBuild, chNginx, ...ctrChecks].map((x) => ({ ...x }))
  const chCons = consistencyCheck([
    [...rounds[0], ...fixed],
    ...rounds.slice(1).map((r) => [...r, ...fixed.map((x) => JSON.parse(JSON.stringify(x)))]),
  ])
  printCheck(chCons)

  // 汇总
  const all = [...rounds[0], ...fixed, chCons]
  const fails = all.filter((x) => x.status === 'FAIL')
  const skips = all.filter((x) => x.status === 'SKIP')
  console.log(c.bold('\n=== 验收总结 ==='))
  console.log(`通过 ${all.length - fails.length - skips.length} 项｜失败 ${fails.length} 项｜跳过 ${skips.length} 项（${skips.map((s) => s.name).join('、') || '无'}）`)
  if (fails.length) {
    console.log(c.red('失败项：'))
    for (const f of fails) console.log(c.red(`  - [${f.id}] ${f.name}`))
    console.log(c.red('\n结论：交付包不通过，禁止拷走交付。'))
    process.exit(1)
  }
  console.log(c.green('\n结论：全部通过——这一包拷到无网机器可直接用。'))
  process.exit(0)
}

main().catch((e) => {
  console.error(c.red('\n验收脚本自身异常：'), e)
  process.exit(1)
})
