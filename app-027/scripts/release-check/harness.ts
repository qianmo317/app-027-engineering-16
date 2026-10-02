/**
 * 交付验收 harness：直接复用应用自身的几何内核（与 /help 页面「验收自检」同一套代码）。
 *
 * 三个子命令（由 verify.mjs 通过 esbuild 打包后以 Node 运行，结果统一打到 stdout 的最后一行 JSON）：
 *   contours   解析 dist/patterns 下全部纹样，输出每个纹样的轮廓数（对比 README 验收记录）
 *   a4         用与自检完全相同的参数生成 A4 1:1 检查图，导出到指定路径并量校验尺/纸张尺寸
 *   selftest   跑页面那套 runSelfTest（第 10 节全部用例），输出每条用例的通过情况与 10 纹样汇总
 *
 * selftest 内部经 fetch(`${BASE_URL}patterns/...`) 取纹样；这里把 fetch 指到 verify.mjs
 * 起起来的本地静态服务（CHECK_BASE_URL），这样读的就是「随包打进去的产物」而不是 public 源文件。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installDomPolyfill } from './xml-polyfill'

// Node 没有浏览器的 DOMParser；importer 只用极小一块 DOM API，用自带的精简 XML 解析器顶上
installDomPolyfill()

import { PATTERN_LIBRARY } from '@/data/patterns'
import { DEFAULT_CUT_SETTINGS } from '@/logic/types'
import { defaultMaterials } from '@/data/materials'
import { importSvgText } from '@/logic/importer'
import { computeShape } from '@/logic/pipeline'
import { buildJob } from '@/logic/job'
import { buildA4Sheet, computePlacement, type ExportMeta } from '@/logic/exporters'
import { runSelfTest } from '@/logic/selftest'

type Out = Record<string, unknown>

const distRoot = process.env.CHECK_DIST || 'dist'
const baseUrl = process.env.CHECK_BASE_URL || '/'

/** 把应用里 fetch 纹样的请求指向本地静态服务（或 dist 目录的文件协议） */
function patchFetch(): void {
  const urlFor = (u: string) => {
    const rel = String(u).replace(/^\/+/, '')
    return new URL(rel, baseUrl)
  }
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: URL | string, init?: RequestInit) => {
    const u = input instanceof URL ? input : urlFor(input)
    const res = await originalFetch(u, init)
    return res
  }) as typeof fetch
}
const originalFetch = globalThis.fetch

function emit(out: Out): never {
  process.stdout.write('\n__CHECK_JSON__' + JSON.stringify(out) + '\n')
  process.exit(0)
}

function fail(step: string, message: string): never {
  process.stderr.write(`[harness] ${step} 失败：${message}\n`)
  process.exit(1)
}

const command = process.argv[2]

if (command === 'contours') {
  const rows = PATTERN_LIBRARY.map((p) => {
    const file = join(distRoot, 'patterns', p.file)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      fail('contours', `产物中缺纹样 ${p.file}（${(e as Error).message}）`)
    }
    const res = importSvgText(text, {
      toleranceMm: DEFAULT_CUT_SETTINGS.toleranceMm,
      closeToleranceMm: DEFAULT_CUT_SETTINGS.closeToleranceMm,
    })
    return {
      file: p.file,
      name: p.name,
      contours: res.contours.length,
      notClosed: res.cleanup.notClosed,
      selfIntersect: res.cleanup.selfIntersect,
      duplicates: res.cleanup.duplicates,
    }
  })
  emit({ rows })
}

if (command === 'a4') {
  // 与 selftest.ts 第 6 节同一参数：经典八角窗花、A4 纵向、placement scale=1
  const outFile = process.argv[3]
  const text = readFileSync(join(distRoot, 'patterns', 'window-flower-classic.svg'), 'utf8')
  const res = importSvgText(text, {
    toleranceMm: DEFAULT_CUT_SETTINGS.toleranceMm,
    closeToleranceMm: DEFAULT_CUT_SETTINGS.closeToleranceMm,
  })
  const mat = defaultMaterials()[0]
  const settings = DEFAULT_CUT_SETTINGS
  const shape = { id: 'a4-check', name: '经典八角窗花', contours: res.contours, layer: 0 }
  const comp = computeShape(shape, settings, mat)
  const sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }
  const job = buildJob([shape], new Map([[shape.id, comp]]), [0], { sharedEdge: false, start: { x: 0, y: 0 } })
  const pl = computePlacement(job.steps, sheet, 1)
  const meta: ExportMeta = {
    projectName: '交付验收',
    formName: shape.name,
    material: mat,
    bridgeWidthMm: settings.bridgeWidthMm,
    passes: mat.passes,
    sheet,
    cutLengthMm: job.cutLengthMm,
    travelMm: job.travelMm,
  }
  const svg = buildA4Sheet(job.steps, sheet, meta, pl, { showNumbers: true, showTravel: true, title: '交付验收 1:1 检查图' })
  writeFileSync(outFile, svg, 'utf8')

  // 量校验尺：buildA4Sheet 里有两条 stroke-width="0.3" 的主尺线——
  // 横尺 100mm（x1≠x2, y1=y2，先出现）、竖尺 50mm（x1=x2, y1≠y2，后出现）
  const mainLines = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#000" stroke-width="0.3"\/>/g)].map((m) => ({
    x1: Number(m[1]),
    y1: Number(m[2]),
    x2: Number(m[3]),
    y2: Number(m[4]),
  }))
  const horizontal = mainLines.find((l) => Math.abs(l.y1 - l.y2) < 1e-9)
  const vertical = mainLines.find((l) => Math.abs(l.x1 - l.x2) < 1e-9)
  const rulerHLen = horizontal ? Math.abs(horizontal.x2 - horizontal.x1) : null
  const rulerVLen = vertical ? Math.abs(vertical.y2 - vertical.y1) : null
  const widthAttr = new RegExp(`width="${sheet.widthMm}mm"`).test(svg)
  const heightAttr = new RegExp(`height="${sheet.heightMm}mm"`).test(svg)
  const viewBoxOk = svg.includes(`viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}"`)
  emit({
    file: outFile,
    rulerHorizontalMm: rulerHLen,
    rulerVerticalMm: rulerVLen,
    paperWidthMm: sheet.widthMm,
    paperHeightMm: sheet.heightMm,
    widthAttr,
    heightAttr,
    viewBoxOk,
  })
}

if (command === 'selftest') {
  patchFetch()
  runSelfTest(DEFAULT_CUT_SETTINGS, defaultMaterials()[0])
    .then((report) => {
      emit({
        total: report.checks.length,
        passed: report.checks.filter((c) => c.pass).length,
        failed: report.checks.filter((c) => !c.pass).map((c) => ({ id: c.id, title: c.title, detail: c.detail })),
        checks: report.checks.map((c) => ({ id: c.id, pass: c.pass })),
        summaries: report.summaries.map((s) => ({ file: s.file, name: s.name, kept: s.kept })),
      })
    })
    .catch((e: Error) => fail('selftest', e.stack || e.message))
} else if (command !== 'contours' && command !== 'a4') {
  fail('harness', `未知子命令：${command ?? '(空)'}（contours | a4 | selftest）`)
}
