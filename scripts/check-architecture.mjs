// Enforces the dependency rule of the clean architecture, from package manifests
// and from the import statements in source files:
//
//   domain  <-  application  <-  adapters  <-  composition  <-  apps
//   domain  <-  config  <-  composition
//
// Adapters never depend on each other; only apps and their composition know
// concrete adapters. `node:` built-ins are allowed only in apps.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath decodes the URL; `.pathname` would percent-encode non-ASCII directories.
const root = fileURLToPath(new URL('..', import.meta.url));
const SCOPE = '@vdoc-server/';

const RULES = {
  domain: { internal: [], external: false },
  application: { internal: ['domain'], external: false },
  config: { internal: ['domain'], external: false },
  adapter: { internal: ['domain', 'application'], external: true },
  composition: { internal: ['domain', 'application', 'config', 'adapter'], external: true },
  app: { internal: ['domain', 'application', 'config', 'adapter', 'composition'], external: true },
};

const layerOf = (name) => {
  const short = name.slice(SCOPE.length);
  if (short.startsWith('adapter-')) return 'adapter';
  if (short.startsWith('app-')) return 'app';
  return short;
};

function packageDirs() {
  const dirs = [];
  for (const base of ['packages', 'packages/adapters', 'apps']) {
    for (const entry of readdirSync(join(root, base))) {
      const dir = join(root, base, entry);
      try { statSync(join(dir, 'package.json')); dirs.push(dir); } catch { /* not a package */ }
    }
  }
  return dirs;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const importsOf = (text) => [...text.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
const packageOf = (specifier) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

const problems = [];
for (const dir of packageDirs()) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const layer = layerOf(manifest.name);
  const rule = RULES[layer];
  if (!rule) { problems.push(`${manifest.name}: unknown layer "${layer}"`); continue; }
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
  const devDeclared = new Set(Object.keys(manifest.devDependencies ?? {}));

  for (const dep of declared) {
    if (dep.startsWith(SCOPE)) {
      const target = layerOf(dep);
      if (!rule.internal.includes(target)) problems.push(`${manifest.name} (${layer}) must not depend on ${dep} (${target})`);
    } else if (!rule.external) {
      problems.push(`${manifest.name} (${layer}) must not have external dependencies (${dep})`);
    }
  }

  const srcDir = join(dir, 'src');
  for (const file of sourceFiles(srcDir)) {
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) continue;
      const where = relative(root, file);
      if (specifier.startsWith('node:')) {
        if (layer !== 'app') problems.push(`${where}: "${specifier}" is only allowed in apps`);
        continue;
      }
      if (specifier.startsWith('cloudflare:')) {
        if (layer !== 'app') problems.push(`${where}: "${specifier}" is only allowed in apps`);
        continue;
      }
      const pkg = packageOf(specifier);
      if (!declared.has(pkg)) problems.push(`${where}: imports "${pkg}" without declaring it in dependencies`);
    }
  }

  let testFiles = [];
  try { testFiles = sourceFiles(join(dir, 'test')); } catch { /* no tests */ }
  for (const file of testFiles) {
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier === 'vitest') continue;
      const pkg = packageOf(specifier);
      if (pkg.startsWith(SCOPE) && !declared.has(pkg) && !devDeclared.has(pkg) && layerOf(pkg) !== layer && !rule.internal.includes(layerOf(pkg))) {
        problems.push(`${relative(root, file)}: test imports "${pkg}", which its layer may not use`);
      }
    }
  }
}

// These boundaries matter inside the layers as well: storing an aggregate must
// never become an implicit quota, billing or connection command again.
const sessionStore = readFileSync(join(root, 'packages/application/src/voice-session-store.ts'), 'utf8');
if (/\b(?:PrincipalQuotaStore|SessionQuotaService|RealtimeConnections|settlementId|usageUnit)\b|\.(?:publish|close|reserve|release)\(/.test(sessionStore)) {
  problems.push('VoiceSessionStore must only load and persist session/outbox state');
}
for (const file of sourceFiles(join(root, 'packages/domain/src'))) {
  const source = readFileSync(file, 'utf8');
  if (/\b(?:pendingAuditEvents|nextAuditSequence|stageAuditEvents|TurnMetrics|settlementId|usageUnit)\b/.test(source)) {
    problems.push(`${relative(root, file)}: infrastructure delivery, telemetry and settlement state belongs outside the domain`);
  }
}
for (const file of sourceFiles(join(root, 'packages/application/src'))) {
  if (file === join(root, 'packages/application/src/session-maintenance.ts')) continue;
  if (/\.expireIfOverdue\(/.test(readFileSync(file, 'utf8'))) {
    problems.push(`${relative(root, file)}: expiration writes must go through session maintenance`);
  }
}

if (problems.length > 0) {
  console.error(`Architecture check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Architecture check passed (${packageDirs().length} packages).`);
