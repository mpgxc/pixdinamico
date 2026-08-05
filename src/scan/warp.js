/**
 * Recorte com correção de perspectiva e ampliação ("upscale").
 *
 * Em vez de recortar um retângulo e depois esticar — o que preserva a distorção
 * de quem fotografa o QR de lado —, projetamos o quadrilátero do símbolo
 * diretamente sobre um quadrado. Uma única passagem faz o recorte, o
 * endireitamento e a ampliação, com interpolação bilinear: nada de degrau nem
 * de dupla reamostragem.
 *
 * A transformação é a forma fechada de Heckbert para quadrado -> quadrilátero.
 * Como percorremos o *destino* e perguntamos "de onde veio este pixel?", é
 * exatamente essa direção que precisamos — sem inverter matriz nenhuma.
 *
 * Módulo puro (sem DOM), testável no Node.
 */

import { createLuma } from './luma.js';

/** Valor devolvido para amostras fora da imagem (zona de silêncio sintética). */
const OUTSIDE_LUMA = 255;

/**
 * Coeficientes da projeção do quadrado unitário sobre o quadrilátero.
 *
 * @typedef {Object} PerspectiveTransform
 * @property {number} a11 @property {number} a12 @property {number} a13
 * @property {number} a21 @property {number} a22 @property {number} a23
 * @property {number} a31 @property {number} a32 @property {number} a33
 */

/**
 * Calcula a projeção que leva o quadrado unitário — (0,0), (1,0), (1,1), (0,1)
 * — sobre os quatro cantos informados, nessa ordem.
 *
 * @param {import('./quad.js').SymbolQuad} quad
 * @returns {PerspectiveTransform}
 */
export function squareToQuad({ topLeft, topRight, bottomRight, bottomLeft }) {
  const x0 = topLeft.x;
  const y0 = topLeft.y;
  const x1 = topRight.x;
  const y1 = topRight.y;
  const x2 = bottomRight.x;
  const y2 = bottomRight.y;
  const x3 = bottomLeft.x;
  const y3 = bottomLeft.y;

  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;

  // Lados opostos paralelos: a projeção degenera para uma afim.
  if (dx3 === 0 && dy3 === 0) {
    return {
      a11: x1 - x0, a12: y1 - y0, a13: 0,
      a21: x2 - x1, a22: y2 - y1, a23: 0,
      a31: x0, a32: y0, a33: 1,
    };
  }

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const denominator = dx1 * dy2 - dx2 * dy1;

  const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
  const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;

  return {
    a11: x1 - x0 + a13 * x1, a12: y1 - y0 + a13 * y1, a13,
    a21: x3 - x0 + a23 * x3, a22: y3 - y0 + a23 * y3, a23,
    a31: x0, a32: y0, a33: 1,
  };
}

/**
 * Aplica a projeção a um ponto do quadrado unitário.
 *
 * @param {PerspectiveTransform} transform
 * @param {number} u Coordenada em [0, 1].
 * @param {number} v Coordenada em [0, 1].
 * @returns {import('./geometry.js').Point} Ponto correspondente na imagem de origem.
 */
export function projectPoint(transform, u, v) {
  const denominator = transform.a13 * u + transform.a23 * v + transform.a33;
  return {
    x: (transform.a11 * u + transform.a21 * v + transform.a31) / denominator,
    y: (transform.a12 * u + transform.a22 * v + transform.a32) / denominator,
  };
}

/**
 * Recorta o quadrilátero da imagem, endireita e amplia para `size` x `size`.
 *
 * @param {import('./luma.js').Luma} luma Imagem de origem (resolução cheia).
 * @param {import('./quad.js').SymbolQuad} quad Região do símbolo.
 * @param {number} size Lado da imagem de saída, em pixels.
 * @returns {import('./luma.js').Luma} Recorte quadrado e ampliado.
 */
export function warpToSquare(luma, quad, size) {
  const transform = squareToQuad(quad);
  const output = createLuma(size, size);
  const { data, width, height } = luma;

  for (let y = 0; y < size; y += 1) {
    // Amostra no centro do pixel de destino, não no canto.
    const v = (y + 0.5) / size;
    const rowStart = y * size;

    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const source = projectPoint(transform, u, v);
      output.data[rowStart + x] = sampleBilinear(data, width, height, source.x, source.y);
    }
  }

  return output;
}

/**
 * Escolhe o lado do recorte de forma que cada módulo do QR ocupe pelo menos
 * `pixelsPerModule` pixels — é isso que dá ao decodificador a resolução que o
 * quadro original não tinha.
 *
 * @param {number} modules Módulos que serão amostrados (símbolo + zona de silêncio).
 * @param {{ pixelsPerModule: number, min: number, max: number }} limits
 * @returns {number} Lado do recorte, em pixels.
 */
export function cropSizeFor(modules, { pixelsPerModule, min, max }) {
  const ideal = Math.round(modules * pixelsPerModule);
  return Math.min(max, Math.max(min, ideal));
}

/**
 * Amostragem bilinear. Fora da imagem devolve branco: o QR pode encostar na
 * borda do quadro, e nesse caso é melhor sintetizar a zona de silêncio que
 * falta do que replicar a borda (o que criaria módulos falsos).
 */
function sampleBilinear(data, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return OUTSIDE_LUMA;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  const topRow = y0 * width;
  const bottomRow = y1 * width;

  const top = data[topRow + x0] * (1 - fx) + data[topRow + x1] * fx;
  const bottom = data[bottomRow + x0] * (1 - fx) + data[bottomRow + x1] * fx;

  return Math.round(top * (1 - fy) + bottom * fy);
}
