import { execSync } from 'node:child_process';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const lock = await readFile(new URL('pnpm-lock.yaml', root), 'utf8');
const lockfileVersion = lock.match(/^lockfileVersion:\s*['"]?([^'"\s]+)/m)?.[1];
if (!lockfileVersion) throw new Error('pnpm-lock.yaml has no lockfileVersion.');

const dependencyTree = JSON.parse(
  execSync('corepack pnpm list --prod --depth Infinity --json', {
    cwd: rootPath,
    encoding: 'utf8',
  }),
);
const packages = new Map();

/**
 * @typedef {{ path: string, version: string, dependencies?: Record<string, Dependency>, optionalDependencies?: Record<string, Dependency> }} Dependency
 * @param {Record<string, Dependency> | undefined} dependencies
 */
function collect(dependencies, optional = false) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    if (!dependency.path || !dependency.version) {
      throw new Error(`pnpm did not resolve the production dependency ${name}`);
    }
    const previous = packages.get(dependency.path);
    packages.set(dependency.path, {
      name,
      version: dependency.version,
      path: dependency.path,
      optional: optional || previous?.optional === true,
    });
    collect(dependency.dependencies, optional);
    collect(dependency.optionalDependencies, true);
  }
}

for (const project of dependencyTree) collect(project.dependencies);
const sections = [
  'Third-party code notices',
  'Generated from pnpm-lock.yaml and the installed production packages.',
  'Copyright (c) 2026 kamkmchess contributors. Original application code is licensed under the GNU General Public License, version 3 or, at your option, any later version (GPL-3.0-or-later). See LICENSE.txt for the full terms and warranty disclaimer.',
  'The combined browser application includes Chessground, chessops and Stockfish under their GPL terms. Third-party code and artwork retain their own licenses. Corresponding source: https://github.com/Kamkmgamer/kamkmchess. Distributors must provide the exact corresponding source for their deployed version, including dependency source and build instructions.',
  'The selectable chess piece styles are Merida by Armando Hernandez Marroquin and Cburnett by Colin M. L. Burnett (GPL-2.0-or-later), Firi by James Faure (CC BY 4.0), and Kaneo by Kadagaden (CC BY 4.0). The SVG artwork is vendored from Lichess and Kadagaden/chess-pieces; src/ui/pieces/UPSTREAM.md records exact source revisions and sizing changes.',
  'The Wikimedia standard chess pieces by Cburnett and Rfc1394 are distributed under CC BY-SA 3.0. They remain only in the retained standard.svg sprite, extracted from the cm-chessboard standard sprite. Source and license notices are embedded in the file.',
  'The landing artwork was generated for kamkm chess. Chess and interface icons are Font Awesome Free SVGs (CC BY 4.0); its JavaScript code is MIT licensed. AI brand names and marks depicted in the artwork remain trademarks of their owners.',
  'The animated landing overlay uses DitherGradient by ripgrim from Boring-Software-Inc/dither-kit, revision 1e7faee9aa252e499651e6736ed65f7a07d9a6bd, declared MIT in upstream package manifests. Source: https://github.com/Boring-Software-Inc/dither-kit. Provenance: src/components/grim-dither-kit/UPSTREAM.md.',
  'Quartz design system source, copyright (c) 2026 Arlan Marat, is included under the MIT license below.',
  await readFile(new URL('docs/design/QUARTZ-LICENSE.txt', root), 'utf8'),
  'The earlier image-dithering core remains vendored from github.com/jvgomg/ditherkit by James Greenaway; the hero no longer imports it.',
  await readFile(new URL('src/components/dither-kit/LICENSE', root), 'utf8'),
];
const inventory = [];

for (const metadata of packages.values()) {
  const directory = metadata.path;
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version) {
    throw new Error(`Installed version differs from lockfile: ${metadata.name}`);
  }

  const files = await readdir(directory);
  const licenseFile = files.find((file) => /^(?:licen[sc]e|copying)(?:-MIT)?(?:\.(?:txt|md))?$/i.test(file));
  // This exact release distributes its complete BSD terms in README.md.
  const readmeLicense = manifest.name === 'glob-to-regexp' && manifest.version === '0.4.1'
    ? (await readFile(join(directory, 'README.md'), 'utf8')).match(/^## License\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim()
    : undefined;
  // toggle-selection 1.0.6 omits LICENSE from its npm archive. Retain the
  // upstream MIT notice, Git blob 4a7395ee831dc1617bf5195dcb353c5bbd89afcd.
  const upstreamLicenseFile = manifest.name === 'toggle-selection' && manifest.version === '1.0.6'
    ? 'toggle-selection-MIT.txt'
    : manifest.name === 'input-otp' && manifest.version === '1.4.2' ? 'input-otp-MIT.txt' : undefined;
  const upstreamLicense = upstreamLicenseFile
    ? await readFile(new URL(`docs/licenses/${upstreamLicenseFile}`, root), 'utf8') : undefined;
  const licenseText = licenseFile ? await readFile(join(directory, licenseFile), 'utf8') : readmeLicense ?? upstreamLicense;
  if (!licenseText) {
    throw new Error(`Review the missing license text for ${manifest.name}`);
  }

  inventory.push({
    path: metadata.name,
    version: metadata.version,
    license: manifest.license,
    scope: 'runtime',
    optional: metadata.optional === true,
  });
  sections.push(
    `${manifest.name}@${manifest.version} (${manifest.license ?? 'license not declared'})`,
    `Source: ${manifest.homepage ?? manifest.repository?.url ?? `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`}`,
    licenseText,
  );
}

sections.push(
  'Previously published kamkmchess code: retained MIT notice. Earlier grants remain valid; the current project is GPL-3.0-or-later.',
  await readFile(new URL('docs/licenses/kamkmchess-MIT.txt', root), 'utf8'),
  'T3 Code theme palette data',
  'Palette values extracted from packages/shared/src/themePalettes.ts at commit 9503155da67add4fbd7fbc51c99ec19a0c8c4a2c (SHA-256 82385050b8b691ff280efc0e93ea9dd8a4bbfd64a4c50cf8536b5c15d1e74479).',
  await readFile(new URL('docs/licenses/T3-Code-MIT.txt', root), 'utf8'),
  await readFile(new URL('docs/licenses/Merida-GPL-2.0-or-later.txt', root), 'utf8'),
  await readFile(new URL('docs/licenses/Cburnett-GPL-2.0-or-later.txt', root), 'utf8'),
  await readFile(new URL('docs/licenses/Firi-CC-BY-4.0.txt', root), 'utf8'),
  await readFile(new URL('docs/licenses/Kaneo-CC-BY-4.0.txt', root), 'utf8'),
  'Wikimedia standard chess pieces',
  'Artists: Cburnett and Rfc1394. Source: https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard. Extracted from cm-chessboard@8.15.3/assets/pieces/standard.svg under Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0): https://creativecommons.org/licenses/by-sa/3.0/. This credit now covers only the retained src/ui/pieces/standard.svg sprite, which contains attribution, source and modification notices.',
  await readFile(new URL('docs/licenses/opponent-logos.txt', root), 'utf8'),
  await readFile(new URL('docs/licenses/LobeHub-Icons-MIT.txt', root), 'utf8'),
  await readFile(new URL('docs/licenses/Stockfish-Website-MIT.txt', root), 'utf8'),
);

await copyFile(new URL('LICENSE', root), new URL('dist/LICENSE.txt', root));
await writeFile(new URL('dist/THIRD_PARTY_NOTICES.txt', root), `${sections.join('\n\n')}\n`);
await writeFile(
  new URL('dist/DEPENDENCY_INVENTORY.json', root),
  `${JSON.stringify({ lockfileVersion, packages: inventory }, null, 2)}\n`,
);
console.log(`Wrote distribution notices to ${fileURLToPath(new URL('dist/', root))}`);
