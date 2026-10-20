import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = 'build/rules-worker';
const artifactRoot = resolve(root, outDir);

// dist/ is the public Vercel website output: it is uploaded as static content.
// The private worker bundle must never be written there, so refuse loudly if a
// future edit points the artifact back into the published tree.
const publicDist = resolve(root, 'dist');
const insidePublicDist = relative(publicDist, artifactRoot);
if (insidePublicDist === '' || (!insidePublicDist.startsWith('..') && !isAbsolute(insidePublicDist))) {
  throw new Error(`Rules worker artifact ${artifactRoot} is inside the public dist/ output.`);
}

const protocolSource = await readFile(join(root, 'src/online-rules-worker/protocol.ts'), 'utf8');
const pinnedEngine = protocolSource.match(/ENGINE_VERSION = '([^']+)'/)?.[1];
const pinnedPolicy = protocolSource.match(/RULES_POLICY_VERSION = '([^']+)'/)?.[1];
if (!pinnedEngine || !pinnedPolicy) throw new Error('Rules worker protocol has no pinned engine or policy version.');

const require = createRequire(import.meta.url);

/** Walks up from a resolved module path to the directory holding its manifest.
 * @param {string} resolvedModule
 */
function packageRoot(resolvedModule) {
  let current = dirname(resolvedModule);
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolves a package source link from the manifest's own metadata.
 * @param {{name: string, version: string, homepage?: string, repository?: string | {url?: string}}} manifest
 */
function packageSource(manifest) {
  if (manifest.homepage) return manifest.homepage;
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (typeof repository === 'string') {
    const shorthand = repository.match(/^(?:github|gitlab|bitbucket):(.+)$/);
    if (shorthand) return `https://github.com/${shorthand[1]}`;
    return repository.replace(/^git\+/, '').replace(/\.git$/, '');
  }
  return `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`;
}

/** Reads the license text a distributed package ships next to its manifest.
 * @param {string} directory
 * @param {string} label
 */
async function packageLicense(directory, label) {
  const files = await readdir(directory);
  const name = files.find((file) => /^(?:licen[sc]e|copying)(?:\.(?:txt|md))?$/i.test(file));
  if (!name) throw new Error(`Could not find the license text for ${label}.`);
  return readFile(join(directory, name), 'utf8');
}

const chessopsRoot = packageRoot(require.resolve('chessops'));
if (chessopsRoot === null) throw new Error('Could not locate the installed chessops package.');
const chessopsManifest = JSON.parse(await readFile(join(chessopsRoot, 'package.json'), 'utf8'));
if (chessopsManifest.version !== pinnedEngine) {
  throw new Error(`Rules worker expects chessops ${pinnedEngine} but ${chessopsManifest.version} is installed.`);
}

// chessops is the only direct runtime dependency of the worker bundle; the
// build fails below if any other bare import survives bundling.
const resultRequire = createRequire(join(chessopsRoot, 'package.json'));
const resultRoot = packageRoot(resultRequire.resolve('@badrap/result'));
if (resultRoot === null) throw new Error('Could not locate the installed @badrap/result package.');
const resultManifest = JSON.parse(await readFile(join(resultRoot, 'package.json'), 'utf8'));

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: join(root, 'src/online-rules-worker/main.ts'),
    outDir,
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: false,
    // public/ holds browser assets; the server artifact must stay self-contained.
    copyPublicDir: false,
    rollupOptions: { output: { entryFileNames: 'worker.mjs', format: 'es' } },
  },
  ssr: { noExternal: true },
});

const entry = join(artifactRoot, 'worker.mjs');
const details = await stat(entry);
if (!details.isFile() || details.size === 0) throw new Error('Rules worker bundle was not written.');

const bundle = await readFile(entry, 'utf8');
const importSpecifiers = [
  ...bundle.matchAll(/(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"]([^'"]+)['"]/g),
  ...bundle.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
  ...bundle.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
].map((match) => match[1]);
const bareImports = importSpecifiers.filter(
  (specifier) => specifier !== undefined && !specifier.startsWith('.') && !specifier.startsWith('node:'),
);
if (bareImports.length > 0) {
  throw new Error(`Rules worker still imports external packages: ${[...new Set(bareImports)].join(', ')}`);
}

const [chessopsLicense, resultLicense] = await Promise.all([
  packageLicense(chessopsRoot, 'chessops'),
  packageLicense(resultRoot, '@badrap/result'),
]);

const notices = [
  'Private rules worker distribution notices',
  `Generated by scripts/build-rules-worker.mjs for the ${outDir}/ artifact.`,
  `Copyright (c) 2026 kamkmchess contributors. The worker bundle and this worker-specific build output are licensed under the GNU General Public License, version 3 or, at your option, any later version (GPL-3.0-or-later). The full terms and warranty disclaimer are in LICENSE.txt next to this file.`,
  `The worker is private server code executed by the Go match authority. It is not part of the public browser bundle. Corresponding source: https://github.com/Kamkmgamer/kamkmchess. Distributors that ship this artifact must provide the exact corresponding source for their deployed version, including dependency source and these build instructions.`,
  `The worker evaluates positions with the pinned rules policy ${pinnedPolicy} and bundles exactly these runtime packages; the artifact requires no node_modules at run time.`,
  `${chessopsManifest.name}@${chessopsManifest.version} (${chessopsManifest.license ?? 'license not declared'})`,
  `Source: ${packageSource(chessopsManifest)}`,
  chessopsLicense,
  `${resultManifest.name}@${resultManifest.version} (${resultManifest.license ?? 'license not declared'})`,
  `Source: ${packageSource(resultManifest)}`,
  resultLicense,
];

await mkdir(artifactRoot, { recursive: true });
await copyFile(join(root, 'LICENSE'), join(artifactRoot, 'LICENSE.txt'));
await writeFile(join(artifactRoot, 'THIRD_PARTY_NOTICES.txt'), `${notices.join('\n\n')}\n`);
await writeFile(
  join(artifactRoot, 'DEPENDENCY_INVENTORY.json'),
  `${JSON.stringify({
    artifact: 'worker.mjs',
    rulesPolicyVersion: pinnedPolicy,
    engine: { name: 'chessops', version: pinnedEngine },
    packages: [chessopsManifest, resultManifest].map((manifest) => ({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? null,
      scope: 'runtime',
      source: packageSource(manifest),
    })),
  }, null, 2)}\n`,
);

console.log(
  `Rules worker bundled at ${outDir}/worker.mjs (${details.size} bytes, policy ${pinnedPolicy}, chessops ${pinnedEngine}) with LICENSE.txt, THIRD_PARTY_NOTICES.txt and DEPENDENCY_INVENTORY.json.`,
);
