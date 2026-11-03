'use strict'
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
/** 统一虚拟文件路径。 @param {string} value @returns {string} */
function normalize(value) { return value.replace(/\\/g, '/') }
const sources = new Map(['dock', 'notifications'].map((name) => [normalize(path.join(root, `helper/typecheck-${name}.js`)), 'export {};\n' + fs.readFileSync(path.join(root, `helper/${name}.html`), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]]))
sources.set(normalize(path.join(root, 'helper/typecheck-globals.d.ts')), 'interface Window { sessionDock: any }')
// 现有无 tsconfig 的 JavaScript 项目按非 strict 模式检查 DOM 与 JSDoc 类型。
const options = { allowJs: true, checkJs: true, noEmit: true, strict: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true }
const host = ts.createCompilerHost(options)
const read = host.readFile.bind(host), exists = host.fileExists.bind(host)
host.readFile = (file) => sources.get(normalize(file)) ?? read(file)
host.fileExists = (file) => sources.has(normalize(file)) || exists(file)
const program = ts.createProgram([...sources.keys(), path.join(root, 'settings-client.js'), path.join(root, 'runtime-manager.js')], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: normalize, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
if (diagnostics.length) process.exit(1)
console.log('PASS: TypeScript checkJs for dock, notification, settings-client and runtime-manager scripts')
