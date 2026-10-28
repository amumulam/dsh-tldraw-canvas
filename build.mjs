import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));

const result = await build({
  entryPoints: ['src/client-entry.js'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/client',
    'react-dom/server',
  ],
  loader: { '.css': 'text', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

const code = result.outputFiles[0].text;
const wrapper = `window.__ModuleLoader__.load({\n  id: '${manifest.name}',\n  factory(require) {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code}\n    return module.exports;\n  },\n});\n`;

await writeFile('client.js', wrapper);
console.log(`client.js written (${(Buffer.byteLength(wrapper) / 1024 / 1024).toFixed(2)} MiB)`);
