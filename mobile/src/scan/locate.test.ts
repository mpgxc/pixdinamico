/**
 * Testes da localização sobre um quadro sintético.
 *
 * O alvo principal aqui é o alinhamento de linha (`bytesPerRow`). A câmera
 * entrega o plano Y com as linhas alinhadas, quase sempre mais largas que a
 * imagem; ignorar isso inclina o quadro inteiro progressivamente e o símbolo
 * some. É um erro que não aparece em revisão de código nem em typecheck — só
 * num aparelho, ou num teste que reproduza o alinhamento de propósito.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locateSymbol } from './locate.ts';
import { yPlaneToLuma } from './luma.ts';
import { QUIET, buildSymbol, renderPlane } from './symbol.fixture.ts';

const FRAME = { width: 1920, height: 1080 };

test('yPlaneToLuma respeita o alinhamento de linha', () => {
  const width = 40;
  const height = 8;
  const padding = 24;
  const bytesPerRow = width + padding;
  const plane = new Uint8Array(bytesPerRow * height);

  // Cada linha recebe o próprio índice; o padding recebe 200 (valor impossível
  // no conteúdo), então qualquer vazamento aparece na leitura.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) plane[y * bytesPerRow + x] = y;
    for (let x = width; x < bytesPerRow; x += 1) plane[y * bytesPerRow + x] = 200;
  }

  const luma = yPlaneToLuma(plane, width, height, bytesPerRow, width);
  assert.equal(luma.width, width);
  assert.equal(luma.height, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      assert.equal(luma.data[y * luma.width + x], y, `pixel (${x}, ${y}) veio da linha errada`);
    }
  }
});

test('yPlaneToLuma reduz por média de bloco, sem amostragem simples', () => {
  // Faixas verticais de 1px: a média de bloco devolve o cinza intermediário,
  // enquanto pegar 1 pixel a cada 2 devolveria só preto ou só branco.
  const width = 64;
  const height = 8;
  const plane = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) plane[y * width + x] = x % 2 === 0 ? 0 : 255;
  }

  const luma = yPlaneToLuma(plane, width, height, width, width / 2);
  assert.equal(luma.width, 32);
  assert.ok(
    luma.data.every((v) => v > 60 && v < 195),
    'as faixas finas deveriam virar cinza, não sumir',
  );
});

test('locateSymbol acha o símbolo e mede o módulo na escala do quadro', () => {
  const dimension = 49;
  const scale = 8; // pixels por módulo no quadro original
  const rendered = renderPlane(buildSymbol(dimension), {
    scale, angle: 0.12, padding: 64, ...FRAME,
  });

  const located = locateSymbol(
    rendered.plane, rendered.width, rendered.height, rendered.bytesPerRow,
  );

  assert.equal(located.kind, 'symbol', 'o símbolo deveria ter sido confirmado');
  if (located.kind !== 'symbol') return;
  assert.equal(located.modules, dimension, 'a dimensão deve ser exata');
  assert.ok(
    Math.abs(located.moduleSize - scale) <= 0.6,
    `módulo medido ${located.moduleSize.toFixed(2)}, esperado ~${scale}`,
  );

  // O teto de enquadramento é o módulo que faria o símbolo ocupar 80% do quadro.
  const expectedCeiling = (0.8 * FRAME.width) / (dimension + 2 * QUIET);
  assert.ok(Math.abs(located.maxModuleSize - expectedCeiling) < 0.01);
  assert.ok(located.moduleSize < located.maxModuleSize, 'ainda há espaço para aproximar');
});

test('os cantos saem no espaço da imagem de trabalho e cercam o símbolo', () => {
  const dimension = 49;
  const scale = 8;
  const rendered = renderPlane(buildSymbol(dimension), {
    scale, angle: 0, padding: 64, ...FRAME,
  });

  const located = locateSymbol(
    rendered.plane, rendered.width, rendered.height, rendered.bytesPerRow,
  );
  assert.equal(located.kind, 'symbol');
  if (located.kind !== 'symbol') return;

  assert.equal(located.corners.length, 4);
  for (const corner of located.corners) {
    assert.ok(
      corner.x >= 0 && corner.x <= located.work.width &&
      corner.y >= 0 && corner.y <= located.work.height,
      `canto fora da imagem de trabalho: ${JSON.stringify(corner)}`,
    );
  }

  // Sem rotação e centralizado, o quadrilátero deve cercar o símbolo: lado de
  // dimension * scale pixels no quadro, reduzido para a imagem de trabalho.
  const toWork = located.work.width / rendered.width;
  const expectedSide = dimension * scale * toWork;
  const width = Math.max(...located.corners.map((c) => c.x)) - Math.min(...located.corners.map((c) => c.x));
  assert.ok(
    Math.abs(width - expectedSide) <= 3,
    `lado do quadrilátero ${width.toFixed(1)}, esperado ~${expectedSide.toFixed(1)}`,
  );
});

test('o alinhamento de linha não altera o resultado', () => {
  const matrix = buildSymbol(49);
  const options = { scale: 6, angle: 0.2, ...FRAME };

  const semPadding = renderPlane(matrix, { ...options, padding: 0 });
  const comPadding = renderPlane(matrix, { ...options, padding: 128 });

  const a = locateSymbol(semPadding.plane, semPadding.width, semPadding.height, semPadding.bytesPerRow);
  const b = locateSymbol(comPadding.plane, comPadding.width, comPadding.height, comPadding.bytesPerRow);

  assert.equal(a.kind, 'symbol');
  assert.equal(b.kind, 'symbol');
  if (a.kind !== 'symbol' || b.kind !== 'symbol') return;
  assert.equal(a.modules, b.modules);
  assert.ok(
    Math.abs(a.moduleSize - b.moduleSize) < 0.01,
    `${a.moduleSize} != ${b.moduleSize} — o padding vazou para a imagem`,
  );
});

test('locateSymbol não inventa candidatos numa cena sem QR', () => {
  const width = 1920;
  const height = 1080;
  const bytesPerRow = width + 64;
  const plane = new Uint8Array(bytesPerRow * height).fill(235);

  // Textura listrada: muitas bordas, nenhuma proporção 1:1:3:1:1.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x + y) % 17 < 3) plane[y * bytesPerRow + x] = 25;
    }
  }

  // Nenhum candidato — é essa ausência de falso positivo que autoriza tratar
  // "um candidato solto" como evidência de que há um QR na cena.
  assert.deepEqual(locateSymbol(plane, width, height, bytesPerRow), { kind: 'none' });
});

/** Analisa o símbolo de 49 módulos nesta escala e ângulo. */
function inspect(scale: number, angle: number) {
  const rendered = renderPlane(buildSymbol(49), { scale, angle, padding: 64, ...FRAME });
  return locateSymbol(rendered.plane, rendered.width, rendered.height, rendered.bytesPerRow);
}

test('abaixo de ~2,5px por módulo no sensor o símbolo não é mais confirmável', () => {
  // Este é o regime que justifica a aproximação automática: o detalhe não está
  // no sensor, e nenhum processamento o recupera. Só aproximar a lente traz
  // informação nova.
  for (const angle of [0, 0.15, 0.4]) {
    assert.notEqual(inspect(2, angle).kind, 'symbol', `confirmou a 2px/mód, ${angle} rad`);
  }

  // Bem acima do piso, a confirmação é sólida em qualquer ângulo.
  for (const angle of [0, 0.15, 0.4]) {
    assert.equal(inspect(5, angle).kind, 'symbol', `não confirmou a 5px/mód, ${angle} rad`);
  }
});

test('na faixa marginal ainda sobra detecção parcial', () => {
  // Entre "confirma" e "não vê nada" existe uma faixa onde os três finder
  // patterns não fecham mas candidatos aparecem. É o sinal que tira a
  // aproximação do lugar quando não há medida — e ele existe justamente onde a
  // confirmação começa a falhar.
  const marginal: string[] = [];
  for (const scale of [2.5, 3, 3.5, 4]) {
    for (const angle of [0, 0.15, 0.4]) marginal.push(inspect(scale, angle).kind);
  }

  assert.ok(
    marginal.some((kind) => kind === 'partial'),
    `nenhuma detecção parcial na faixa marginal: ${marginal.join(', ')}`,
  );
  assert.ok(
    marginal.filter((kind) => kind === 'symbol').length >= 6,
    `a faixa marginal deveria confirmar na maioria dos casos: ${marginal.join(', ')}`,
  );
});
