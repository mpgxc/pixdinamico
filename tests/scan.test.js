/**
 * Testes do pipeline de leitura.
 *
 * As etapas de visão computacional são funções puras sobre buffers, então dão
 * para testar no Node sem navegador nem câmera: o teste sintetiza um símbolo
 * (finder patterns em posições conhecidas), rasteriza com a rotação desejada e
 * confere se o pipeline reencontra exatamente o que foi desenhado.
 *
 * Executar com: `npm test` (ou `node --test`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toLuma } from '../src/scan/luma.js';
import { BLACK, WHITE, binarize, binaryToLuma } from '../src/scan/binarize.js';
import {
  findFinderPatterns,
  measureModuleSize,
  orderFinderPatterns,
  rotationCorrectedModuleSize,
  selectFinderTriple,
} from '../src/scan/finder.js';
import { distance } from '../src/scan/geometry.js';
import { estimateSymbolQuad, expandQuad, scaleQuad } from '../src/scan/quad.js';
import { cropSizeFor, projectPoint, squareToQuad, warpToSquare } from '../src/scan/warp.js';

const QUIET_MODULES = 4;
const FINDER_SIZE = 7;

/**
 * Monta a matriz de um símbolo com os três finder patterns nos cantos.
 * O miolo é opcional (`fill`), para testar com e sem dados em volta.
 */
function buildSymbol(dimension, { fill = false } = {}) {
  const matrix = Array.from({ length: dimension }, () => new Uint8Array(dimension));

  const drawFinder = (originRow, originColumn) => {
    for (let r = 0; r < FINDER_SIZE; r += 1) {
      for (let c = 0; c < FINDER_SIZE; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[originRow + r][originColumn + c] = border || center ? BLACK : WHITE;
      }
    }
  };

  if (fill) {
    // Xadrez de 1 módulo no miolo: nunca produz a proporção 1:1:3:1:1, mas
    // enche a imagem de bordas — é o ruído que derruba detector ingênuo.
    for (let r = FINDER_SIZE + 2; r < dimension - FINDER_SIZE - 2; r += 1) {
      for (let c = FINDER_SIZE + 2; c < dimension - FINDER_SIZE - 2; c += 1) {
        matrix[r][c] = (r + c) % 2 === 0 ? BLACK : WHITE;
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, dimension - FINDER_SIZE);
  drawFinder(dimension - FINDER_SIZE, 0);

  return matrix;
}

/**
 * Rasteriza a matriz em RGBA, com zona de silêncio e rotação opcional.
 * Devolve também o mapeamento módulo -> pixel, para as asserções.
 */
function renderSymbol(matrix, { scale = 6, angle = 0 } = {}) {
  const dimension = matrix.length;
  const content = (dimension + 2 * QUIET_MODULES) * scale;
  const side = Math.ceil(content * Math.SQRT2);
  const center = side / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  /** Coordenadas de módulo (fracionárias) -> pixel na imagem. */
  const toPixel = (moduleX, moduleY) => {
    const x = (moduleX + QUIET_MODULES) * scale - content / 2;
    const y = (moduleY + QUIET_MODULES) * scale - content / 2;
    return { x: center + x * cos - y * sin, y: center + x * sin + y * cos };
  };

  const rgba = new Uint8ClampedArray(side * side * 4);

  for (let py = 0; py < side; py += 1) {
    for (let px = 0; px < side; px += 1) {
      // Inverso de `toPixel`, para saber qual módulo cobre este pixel.
      const dx = px + 0.5 - center;
      const dy = py + 0.5 - center;
      const x = dx * cos + dy * sin + content / 2;
      const y = -dx * sin + dy * cos + content / 2;
      const column = Math.floor(x / scale) - QUIET_MODULES;
      const row = Math.floor(y / scale) - QUIET_MODULES;

      const isBlack =
        row >= 0 && row < dimension && column >= 0 && column < dimension &&
        matrix[row][column] === BLACK;

      const offset = (py * side + px) * 4;
      const value = isBlack ? 0 : 255;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }

  return { rgba, side, scale, toPixel };
}

/** Atalho: rasteriza, converte para luminância e binariza. */
function prepare(matrix, options) {
  const rendered = renderSymbol(matrix, options);
  const luma = toLuma(rendered.rgba, rendered.side, rendered.side);
  return { ...rendered, luma, binary: binarize(luma) };
}

test('binarize separa preto e branco de um símbolo sintético', () => {
  const { binary, side, toPixel } = prepare(buildSymbol(25));

  const at = ({ x, y }) => binary[Math.round(y - 0.5) * side + Math.round(x - 0.5)];

  assert.equal(at(toPixel(3.5, 3.5)), BLACK, 'centro do finder pattern é preto');
  assert.equal(at(toPixel(1.5, 3.5)), WHITE, 'anel branco do finder pattern');
  assert.equal(at(toPixel(-2, -2)), WHITE, 'zona de silêncio é branca');
});

test('binaryToLuma devolve uma imagem de dois níveis', () => {
  const { binary, side } = prepare(buildSymbol(25));
  const hardened = binaryToLuma(binary, side, side);

  assert.equal(hardened.width, side);
  assert.equal(hardened.data.length, side * side);
  assert.ok(hardened.data.every((value) => value === 0 || value === 255));
});

test('findFinderPatterns acha os três alvos nas posições desenhadas', () => {
  const dimension = 25;
  const { binary, side, scale, toPixel } = prepare(buildSymbol(dimension));

  const patterns = findFinderPatterns(binary, side, side);
  assert.ok(patterns.length >= 3, `esperava ao menos 3 candidatos, veio ${patterns.length}`);

  const ordered = selectFinderTriple(patterns);
  assert.ok(ordered, 'o trio deveria ser plausível');

  const expected = {
    topLeft: toPixel(3.5, 3.5),
    topRight: toPixel(dimension - 3.5, 3.5),
    bottomLeft: toPixel(3.5, dimension - 3.5),
  };

  for (const key of Object.keys(expected)) {
    assert.ok(
      distance(ordered[key], expected[key]) <= scale,
      `${key} fora de posição por ${distance(ordered[key], expected[key]).toFixed(1)}px`,
    );
    assert.ok(Math.abs(ordered[key].moduleSize - scale) <= 1, `módulo estimado em ${key}`);
  }
});

test('a localização sobrevive a ruído no miolo e a rotação', () => {
  for (const angle of [0, Math.PI / 12, Math.PI / 4, -Math.PI / 3]) {
    const dimension = 29;
    const { binary, side, scale, toPixel } = prepare(buildSymbol(dimension, { fill: true }), {
      scale: 7,
      angle,
    });

    const ordered = selectFinderTriple(findFinderPatterns(binary, side, side));
    assert.ok(ordered, `nenhum trio encontrado a ${angle.toFixed(2)} rad`);

    // Os rótulos precisam bater com o desenho, não só as posições.
    assert.ok(
      distance(ordered.topLeft, toPixel(3.5, 3.5)) <= 7,
      `topLeft trocado a ${angle.toFixed(2)} rad`,
    );
    assert.ok(
      distance(ordered.topRight, toPixel(dimension - 3.5, 3.5)) <= 7,
      `topRight trocado a ${angle.toFixed(2)} rad`,
    );
    assert.ok(
      distance(ordered.bottomLeft, toPixel(3.5, dimension - 3.5)) <= 7,
      `bottomLeft trocado a ${angle.toFixed(2)} rad`,
    );

    // A medida crua infla com a rotação (1/cos θ, o dobro a 60°). A correção
    // pelo cosseno aproxima; a medida ao longo do eixo do símbolo acerta.
    assert.ok(
      Math.abs(rotationCorrectedModuleSize(ordered) - scale) <= 0.25 * scale,
      `módulo corrigido = ${rotationCorrectedModuleSize(ordered).toFixed(2)} a ${angle.toFixed(2)} rad`,
    );
    const measured = measureModuleSize(binary, side, side, ordered);
    assert.ok(
      Math.abs(measured - scale) <= 0.5,
      `módulo medido = ${measured.toFixed(2)} (real ${scale}) a ${angle.toFixed(2)} rad`,
    );
  }
});

test('orderFinderPatterns rotula pelos lados do triângulo, não pela ordem de entrada', () => {
  const corners = [
    { x: 10, y: 10, moduleSize: 2, count: 3 }, // superior esquerdo
    { x: 90, y: 10, moduleSize: 2, count: 3 }, // superior direito
    { x: 10, y: 90, moduleSize: 2, count: 3 }, // inferior esquerdo
  ];

  for (const trio of [corners, [corners[2], corners[0], corners[1]], [corners[1], corners[2], corners[0]]]) {
    const ordered = orderFinderPatterns(trio);
    assert.deepEqual([ordered.topLeft.x, ordered.topLeft.y], [10, 10]);
    assert.deepEqual([ordered.topRight.x, ordered.topRight.y], [90, 10]);
    assert.deepEqual([ordered.bottomLeft.x, ordered.bottomLeft.y], [10, 90]);
  }

  assert.equal(orderFinderPatterns([corners[0], corners[1], { x: 50, y: 10 }]), null);
});

test('estimateSymbolQuad devolve os cantos do símbolo com zona de silêncio', () => {
  const dimension = 25;
  const { binary, side, scale, toPixel } = prepare(buildSymbol(dimension));
  const ordered = selectFinderTriple(findFinderPatterns(binary, side, side));

  const quad = estimateSymbolQuad(ordered, {
    measuredModuleSize: measureModuleSize(binary, side, side, ordered),
  });

  assert.equal(quad.modules, dimension);
  assert.equal(quad.sampledModules, dimension + 2 * QUIET_MODULES);

  const expected = {
    topLeft: toPixel(-QUIET_MODULES, -QUIET_MODULES),
    topRight: toPixel(dimension + QUIET_MODULES, -QUIET_MODULES),
    bottomRight: toPixel(dimension + QUIET_MODULES, dimension + QUIET_MODULES),
    bottomLeft: toPixel(-QUIET_MODULES, dimension + QUIET_MODULES),
  };

  for (const key of Object.keys(expected)) {
    assert.ok(
      distance(quad[key], expected[key]) <= 1.5 * scale,
      `canto ${key} errado por ${distance(quad[key], expected[key]).toFixed(1)}px`,
    );
  }
});

test('scaleQuad e expandQuad reprojetam sem deslocar o centro', () => {
  const quad = {
    topLeft: { x: 10, y: 10 },
    topRight: { x: 30, y: 10 },
    bottomRight: { x: 30, y: 30 },
    bottomLeft: { x: 10, y: 30 },
    moduleSize: 2,
    modules: 21,
    sampledModules: 29,
  };

  const scaled = scaleQuad(quad, 3, 3);
  assert.deepEqual(scaled.topLeft, { x: 30, y: 30 });
  assert.deepEqual(scaled.bottomRight, { x: 90, y: 90 });
  assert.equal(scaled.moduleSize, 6);
  assert.equal(scaled.modules, 21, 'metadados de módulo são preservados');

  const expanded = expandQuad(quad, 1.5);
  assert.deepEqual(expanded.topLeft, { x: 5, y: 5 });
  assert.deepEqual(expanded.bottomRight, { x: 35, y: 35 });
});

test('squareToQuad mapeia o quadrado unitário sobre os quatro cantos', () => {
  const quad = {
    topLeft: { x: 4, y: 8 },
    topRight: { x: 44, y: 2 },
    bottomRight: { x: 50, y: 60 },
    bottomLeft: { x: 2, y: 52 },
  };
  const transform = squareToQuad(quad);

  const closeTo = (actual, expected) => {
    assert.ok(Math.abs(actual.x - expected.x) < 1e-6 && Math.abs(actual.y - expected.y) < 1e-6);
  };

  closeTo(projectPoint(transform, 0, 0), quad.topLeft);
  closeTo(projectPoint(transform, 1, 0), quad.topRight);
  closeTo(projectPoint(transform, 1, 1), quad.bottomRight);
  closeTo(projectPoint(transform, 0, 1), quad.bottomLeft);
});

test('cropSizeFor respeita os limites de resolução', () => {
  const limits = { pixelsPerModule: 6, min: 256, max: 1024 };
  assert.equal(cropSizeFor(100, limits), 600);
  assert.equal(cropSizeFor(10, limits), 256, 'nunca abaixo do mínimo');
  assert.equal(cropSizeFor(400, limits), 1024, 'nunca acima do máximo');
});

test('warpToSquare endireita, amplia e reproduz o símbolo original', () => {
  const dimension = 25;
  const angle = Math.PI / 9;
  const matrix = buildSymbol(dimension, { fill: true });
  const { binary, luma, side } = prepare(matrix, { scale: 4, angle });

  const ordered = selectFinderTriple(findFinderPatterns(binary, side, side));
  const quad = estimateSymbolQuad(ordered, {
    measuredModuleSize: measureModuleSize(binary, side, side, ordered),
  });

  assert.equal(quad.modules, dimension, 'a dimensão do símbolo deve ser exata');

  const pixelsPerModule = 8;
  const size = quad.sampledModules * pixelsPerModule;
  const crop = warpToSquare(luma, quad, size);

  assert.equal(crop.width, size);
  assert.ok(size > dimension * 4, 'o recorte deve ampliar em relação à origem');

  // Amostra o centro de cada módulo do recorte e compara com o desenho.
  const sampleModule = (row, column) => {
    const x = Math.floor(((column + 0.5) / quad.sampledModules) * size);
    const y = Math.floor(((row + 0.5) / quad.sampledModules) * size);
    return crop.data[y * size + x] < 128 ? BLACK : WHITE;
  };

  let matches = 0;
  let total = 0;
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < dimension; column += 1) {
      total += 1;
      if (sampleModule(row + QUIET_MODULES, column + QUIET_MODULES) === matrix[row][column]) {
        matches += 1;
      }
    }
  }

  const accuracy = matches / total;
  assert.ok(accuracy > 0.97, `apenas ${(accuracy * 100).toFixed(1)}% dos módulos coincidem`);

  // A zona de silêncio recortada tem que sair branca dos quatro lados.
  const last = quad.sampledModules - 1;
  for (const [row, column] of [[0, 0], [0, last], [last, 0], [last, last]]) {
    assert.equal(sampleModule(row, column), WHITE, 'zona de silêncio contaminada');
  }
});

test('selectFinderTriple recusa candidatos que não formam um QR', () => {
  assert.equal(selectFinderTriple([]), null);
  assert.equal(
    selectFinderTriple([
      { x: 10, y: 10, moduleSize: 2, count: 2 },
      { x: 20, y: 10, moduleSize: 2, count: 2 },
    ]),
    null,
    'menos de três candidatos',
  );
  assert.equal(
    selectFinderTriple([
      { x: 10, y: 10, moduleSize: 2, count: 2 },
      { x: 300, y: 12, moduleSize: 2, count: 2 },
      { x: 12, y: 40, moduleSize: 2, count: 2 },
    ]),
    null,
    'pernas de tamanhos incompatíveis',
  );
});
