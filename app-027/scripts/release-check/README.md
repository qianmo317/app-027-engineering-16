# 交付前一键验收（release:check）

把「人跑一遍」的交付前检查并成一条命令：

```bash
npm run release:check
```

在 `app-027/` 目录下执行。**全部通过退出码 0；任何一项失败退出码 1**，失败项会在结尾逐条列出 `[检查 id] 名称`。

## 检查项（每项都打印「量到的值｜上限/标准｜PASS/FAIL/SKIP」）

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 生产构建 | `vue-tsc --noEmit && vite build` 退出码 0 |
| 2 | 交付包总体积 | `dist/` 全量 ≤ 2 MiB（`RC_PACKAGE_MAX_MB` 覆盖） |
| 3 | 最大单文件 | dist 内最大文件 ≤ 512 KiB（`RC_SINGLE_MAX_KB` 覆盖） |
| 4 | 外部地址扫描 | 产物文本里非白名单的 `http(s)/ws(s)://…`、协议相对地址 = 0 |
| 5 | 纹样/字体齐全 | 10 个纹样 + 1 个字体都在 dist 内，且与 `public/` 源文件 sha256 一致 |
| 6 | 轮廓数对账 | 每个纹样用**应用自身的导入器**解析，轮廓数与 README 验收记录 27/23/6/4/24/23/28/12/10/23 逐一相等 |
| 7 | A4 1:1 检查图 | 导出的 SVG 中横尺 100mm、竖尺 50mm（容差 1mm），纸幅 210×297mm，`viewBox="0 0 210 297"` |
| 8 | 带参数页面入口 | `/`、`/design/…`、`/layout/…`、`/export/…`、`/materials`、`/help`、未知路径全部 200 且返回体与 `/` 逐字节相同（SPA 回退到同一 index.html，非空白） |
| 9 | 资源 HTTP 可达 | 纹样/字体/入口脚本经服务取到的内容与 dist 文件 sha256 一致 |
| 10 | 页面验收自检 | 经 HTTP 实际加载包内纹样，跑 `/help` 页同一套 `runSelfTest`：19/19 通过，轮廓数与 README 一致 |
| 11 | nginx 配置静态核对 | `try_files … /index.html`、`/healthz`、`/patterns/`、`/fonts/` 四条配置都在（不依赖容器运行时） |
| 12 | 容器六步 | 有 docker/podman：compose build → up → `/healthz` 200 → 容器内路由 → 镜像 ≤ 60MiB（规格书 §12）→ down；**本机无容器工具时六步全部 SKIP 并写明原因**，路由检查改由本地 `vite preview` 对同一 dist 执行 |
| 13 | 两轮一致性 | 第 2~10 项连跑两轮，逐项比对状态与测量值（体积/轮廓数/校验尺/外链清单/入口哈希/自检结果），不一致即失败 |

A4 检查图导出在 `scripts/release-check/out/a4-check-round{1,2}.svg`，可直接打印（选「实际大小/100%」）用直尺复核。

## 为什么白名单里有几个外部地址

扫描会把命中的地址全部打印出来，下列两类经逐一确认不发网络请求、不影响断网使用，列入白名单；其余任何外部地址都会让检查失败：

- `http://www.w3.org/2000/svg` 等：XML/SVG 命名空间**标识符**（规范 ID 字符串，浏览器不会去访问）；
- `https://vuejs.org/error-reference/#runtime-…`：Vue 运行时只在抛错时拼接进报错文本的参考链接，不预取。

## 实现说明

- `verify.mjs`：编排器（纯 Node 内置模块）。
- `harness.ts`：复用 `src/logic/*`（导入器、管线、A4 导出器、页面自检），由 esbuild（devDependency 里已有）打成单文件 CJS 后在 Node 运行，保证脚本量到的数和页面上是同一套代码算出来的。
- `xml-polyfill.ts`：Node 没有浏览器的 `DOMParser`，这里提供一个只覆盖 importer 所需 API 的精简 XML 解析器，仅在验收 harness 中使用，不进生产产物。

## 调试开关

`RC_SKIP_BUILD=1` 跳过构建、沿用现有 dist，仅用于本地验证失败路径（例如手动删一个 dist 文件看检查是否变红）；正式交付验收不要设置。
