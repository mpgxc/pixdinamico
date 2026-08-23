/**
 * Confere que todo o pipeline de visão vira worklet de fato.
 *
 * O localizador roda na thread de worklets do frame processor, e o runtime de
 * lá só executa funções que o plugin do Babel transformou. Uma função sem a
 * diretiva `'worklet'` — ou um plugin mal configurado — compila, empacota,
 * passa no typecheck e só quebra quando o primeiro quadro chega da câmera.
 *
 * Este script fecha essa lacuna comparando, arquivo a arquivo, quantas funções
 * estão marcadas no fonte com quantas o Babel realmente transformou.
 */

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

import { transformFileSync } from '@babel/core';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * Só o que precisa de marcação explícita. Callbacks passados a hooks do
 * Reanimated (`useAnimatedReaction` e afins) são workletizados pelo plugin sem
 * diretiva nenhuma — cobrá-la deles daria falso alarme.
 */
const PATTERNS = ['src/scan/*.ts', 'src/camera/steer.ts'];
const IGNORED = /\.test\.ts$|\.fixture\.ts$/;

const files = PATTERNS.flatMap((pattern) => globSync(pattern, { cwd: ROOT }))
  .filter((file) => !IGNORED.test(file))
  .sort();

let failures = 0;
let total = 0;

for (const file of files) {
  const absolute = path.join(ROOT, file);
  const source = readFileSync(absolute, 'utf8');
  const declared = (source.match(/^\s*'worklet';$/gm) ?? []).length;

  const output = transformFileSync(absolute, {
    cwd: ROOT,
    root: ROOT,
    filename: absolute,
    configFile: path.join(ROOT, 'babel.config.js'),
    caller: { name: 'metro', platform: 'android', isDev: false, supportsStaticESM: true },
  });
  const compiled = (output?.code?.match(/__workletHash/g) ?? []).length;

  const ok = declared > 0 && compiled === declared;
  if (!ok) failures += 1;
  total += declared;

  console.log(
    `${ok ? 'ok  ' : 'FALHA'} ${file.padEnd(26)} marcadas=${String(declared).padStart(2)} compiladas=${String(compiled).padStart(2)}`,
  );
}

if (failures > 0) {
  console.error(
    `\n${failures} arquivo(s) do pipeline não viraram worklets. ` +
      'Toda função alcançável a partir do frame processor precisa da diretiva ' +
      "'worklet'; sem ela o app quebra no primeiro quadro da câmera.",
  );
  process.exit(1);
}

console.log(`\n${total} funções do pipeline confirmadas como worklets em ${files.length} arquivos.`);
