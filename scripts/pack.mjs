#!/usr/bin/env node
/** Bundle a portable release folder + tarball for another machine. */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'release');
const dist = join(root, 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ missing — run npm run build first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(dist, join(out, 'dist'), { recursive: true });
cpSync(join(root, 'server.mjs'), join(out, 'server.mjs'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: 'module',
      scripts: { start: 'node server.mjs' },
      engines: pkg.engines,
      dependencies: {},
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(out, 'README.md'),
  `# Chart Desk (portable build)

Requires **Node.js 18+**.

\`\`\`bash
npm install --omit=dev
npm start
\`\`\`

Open http://127.0.0.1:4173/

Optional: \`HOST=0.0.0.0 PORT=8080 npm start\`
`,
);

const tarName = `chart-desk-${pkg.version}.tar.gz`;
execSync(`tar -czf ${tarName} -C ${root} release`, { stdio: 'inherit' });
console.log(`Packed ${tarName}`);
