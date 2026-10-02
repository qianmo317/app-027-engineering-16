/**
 * 验收 harness 入口（Node 侧）。
 * 打包的是「页面 /help 里那颗验收自检按钮」调用的同一个 runSelfTest 内核，
 * 不复制任何判定逻辑：页面上跑的几何解析 / 清理 / 连刀 / 排序 / 导出代码在这里原样执行。
 *
 * 用法：
 *   node harness.mjs selftest         -> 跑完整自检 + 解析 dist 里随包纹样的轮廓数
 *   node harness.mjs a4 <outfile>     -> 复刻自检里的 A4 检查图导出，写到指定文件
 */
import './dom-shim'

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PATTERN_LIBRARY } from '@/data/patterns'
import { defaultMaterials } from '@/data/materials'
import { DEFAULT_CUT_SETTINGS, type Shape } from '@/logic/types'
import { importSvgText } from '@/logic/importer'
import { runSelfTest } from '@/logic/selftest'
import { computeShape } from '@/logic/pipeline'
import { buildJob } from '@/logic/job'
import { buildA4Sheet, computePlacement, type ExportMeta } from '@/logic/exporters'

const ROOT = resolve(process.env.APP_ROOT ?? process.cwd())
const DIST = join(ROOT, 'dist')

/**
 * 页面里纹样是通过 fetch(`${BASE_URL}patterns/${file}`) 同源读取的；
 * 这里把同源 fetch 落到 dist/ 上，读的是「实际随包拷出去」的那一份文件。
 */
;(globalThis as unknown as { fetch: (url: string) => Promise<Response> }).fetch = (url: string) => {
  const rel = url.replace(/^\//, '')
  let text = ''
  let ok = false
  try {
    text = readFileSync(join(DIST, rel), 'utf8')
    ok = true
  } catch {
    text = ''
  }
  return Promise.resolve({
    ok,
    status: ok ? 200 : 404,
    text: () => Promise.resolve(text),
  } as unknown as Response)
}

/** 直接解析「dist 里随包的」纹样文件，得到保留下来的轮廓数（独立于自检管线再数一遍） */
function parseShippedPatterns(): Array<{ file: string; name: string; contours: number; error?: string }> {
  return PATTERN_LIBRARY.map((p) => {
    try {
      const text = readFileSync(join(DIST, 'patterns', p.file), 'utf8')
      const res = importSvgText(text, {
        toleranceMm: DEFAULT_CUT_SETTINGS.toleranceMm,
        closeToleranceMm: DEFAULT_CUT_SETTINGS.closeToleranceMm,
      })
      return { file: p.file, name: p.name, contours: res.contours.length }
    } catch (e) {
      return { file: p.file, name: p.name, contours: -1, error: (e as Error).message }
    }
  })
}

/** 复刻 selftest.ts 中导出 A4 检查图的那段编排（经典八角窗花 + A4 纵向） */
function buildA4(outFile: string): {
  file: string
  bytes: number
  sheet: { widthMm: number; heightMm: number }
  shapeName: string
} {
  const text = readFileSync(join(DIST, 'patterns', 'window-flower-classic.svg'), 'utf8')
  const res = importSvgText(text, {
    toleranceMm: DEFAULT_CUT_SETTINGS.toleranceMm,
    closeToleranceMm: DEFAULT_CUT_SETTINGS.closeToleranceMm,
  })
  const mat = defaultMaterials()[0]
  const settings = DEFAULT_CUT_SETTINGS
  const shape: Shape = { id: 'verify_a4', name: '经典八角窗花', contours: res.contours, layer: 0 }
  const comp = computeShape(shape, settings, mat)
  const sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }
  const job = buildJob([shape], new Map([[shape.id, comp]]), [0], {
    sharedEdge: false,
    start: { x: 0, y: 0 },
  })
  const pl = computePlacement(job.steps, sheet, 1)
  const meta: ExportMeta = {
    projectName: '离线交付验收',
    formName: shape.name,
    material: mat,
    bridgeWidthMm: settings.bridgeWidthMm,
    passes: mat.passes,
    sheet,
    cutLengthMm: job.cutLengthMm,
    travelMm: job.travelMm,
  }
  const svg = buildA4Sheet(job.steps, sheet, meta, pl, { showNumbers: true, showTravel: true, title: '离线交付验收' })
  writeFileSync(outFile, svg, 'utf8')
  return { file: outFile, bytes: Buffer.byteLength(svg, 'utf8'), sheet: { widthMm: 210, heightMm: 297 }, shapeName: shape.name }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'a4') {
    const outFile = process.argv[3]
    if (!outFile) throw new Error('缺少 A4 输出文件参数')
    const out = buildA4(outFile)
    process.stdout.write(`VERIFY_JSON${JSON.stringify({ kind: 'a4', ...out })}VERIFY_JSON`)
    return
  }

  const report = await runSelfTest(DEFAULT_CUT_SETTINGS, defaultMaterials()[0])
  const shipped = parseShippedPatterns()
  process.stdout.write(
    `VERIFY_JSON${JSON.stringify({
      kind: 'selftest',
      totalMs: report.totalMs,
      checks: report.checks.map((c) => ({ id: c.id, title: c.title, pass: c.pass, detail: c.detail })),
      summaries: report.summaries.map((s) => ({
        file: s.file,
        name: s.name,
        kept: s.kept,
        notClosed: s.notClosed,
        selfIntersect: s.selfIntersect,
        duplicates: s.duplicates,
        maxDepth: s.maxDepth,
        bridges: s.bridges,
        fragments: s.fragments,
      })),
      shipped,
    })}VERIFY_JSON`,
  )
}

main().catch((e) => {
  process.stderr.write(`harness 执行失败：${(e as Error).stack ?? e}\n`)
  process.exit(2)
})
