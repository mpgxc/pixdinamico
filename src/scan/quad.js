/**
 * Reconstrução do quadrilátero que delimita o símbolo a partir dos três finder
 * patterns.
 *
 * Cada finder pattern fica a 3,5 módulos das duas bordas do símbolo (ele tem
 * 7 módulos e o centro está no meio). Com isso, e sabendo o tamanho do módulo
 * em pixels, dá para "empurrar" cada centro para fora até o canto real do QR —
 * e mais um pouco, para incluir a zona de silêncio, que o decodificador exige.
 *
 * O quarto canto (inferior-direito) não tem finder pattern; ele é estimado como
 * o fecho do paralelogramo. Isso ignora a distorção de perspectiva residual,
 * mas o erro fica bem abaixo da margem que já adicionamos — e o alignment
 * pattern, que corrigiria isso, só existe a partir da versão 2.
 *
 * Módulo puro (sem DOM), testável no Node.
 */

import { FINDER_MODULES, rotationCorrectedModuleSize } from './finder.js';
import { centroid, distance, unitVector } from './geometry.js';

/** Distância, em módulos, do centro do finder pattern até a borda do símbolo. */
const FINDER_CENTER_INSET = FINDER_MODULES / 2; // 3,5

/** Zona de silêncio adicionada ao recorte (a norma pede 4 módulos). */
export const DEFAULT_QUIET_ZONE_MODULES = 4;

// Dimensões válidas de um QR Code: 21, 25, ..., 177 (17 + 4 x versão).
const BASE_DIMENSION = 17;
const DIMENSION_STEP = 4;
const MIN_DIMENSION = 21;
const MAX_DIMENSION = 177;

/**
 * @typedef {import('./geometry.js').Point} Point
 *
 * @typedef {Object} SymbolQuad
 * @property {Point}  topLeft
 * @property {Point}  topRight
 * @property {Point}  bottomRight
 * @property {Point}  bottomLeft
 * @property {number} moduleSize      Tamanho do módulo, em pixels da origem.
 * @property {number} modules         Dimensão estimada do símbolo, em módulos.
 * @property {number} sampledModules  `modules` + a zona de silêncio incluída.
 */

/**
 * Estima o quadrilátero do símbolo (já com zona de silêncio) a partir dos três
 * finder patterns ordenados.
 *
 * Os cantos podem cair fora dos limites da imagem quando o QR encosta na borda
 * do quadro; isso é intencional e tratado na amostragem (ver `warp`), que
 * devolve branco fora da imagem e assim sintetiza a zona de silêncio que falta.
 *
 * @param {import('./finder.js').OrderedFinderPatterns} patterns
 * @param {{ quietZoneModules?: number, measuredModuleSize?: number }} [options]
 *   `measuredModuleSize` é a medida ao longo do eixo do símbolo (ver
 *   `measureModuleSize`); sem ela cai-se na estimativa das varreduras, que é
 *   menos precisa em símbolos girados.
 * @returns {SymbolQuad}
 */
export function estimateSymbolQuad(
  patterns,
  { quietZoneModules = DEFAULT_QUIET_ZONE_MODULES, measuredModuleSize } = {},
) {
  const { topLeft, topRight, bottomLeft } = patterns;

  // Eixos do símbolo (unitários), medidos entre os centros dos finder patterns.
  const horizontal = unitVector(topLeft, topRight);
  const vertical = unitVector(topLeft, bottomLeft);

  const modules = estimateDimension(patterns, measuredModuleSize);

  // Com a dimensão conhecida, o tamanho do módulo passa a ser puramente
  // geométrico — uma distância entre centros dividida por uma contagem exata.
  // Isso é bem mais preciso do que a média das medidas de varredura, e é o que
  // mantém o recorte alinhado nas bordas do símbolo.
  const moduleSize = betweenCenters(patterns) / (modules - FINDER_MODULES);

  // Fecha o paralelogramo para achar o canto que não tem finder pattern.
  const bottomRight = {
    x: topRight.x + bottomLeft.x - topLeft.x,
    y: topRight.y + bottomLeft.y - topLeft.y,
  };

  const outset = (FINDER_CENTER_INSET + quietZoneModules) * moduleSize;

  return {
    topLeft: translate(topLeft, horizontal, -outset, vertical, -outset),
    topRight: translate(topRight, horizontal, outset, vertical, -outset),
    bottomRight: translate(bottomRight, horizontal, outset, vertical, outset),
    bottomLeft: translate(bottomLeft, horizontal, -outset, vertical, outset),
    moduleSize,
    modules,
    sampledModules: modules + 2 * quietZoneModules,
  };
}

/**
 * Reprojeta um quadrilátero para outra escala — usado para levar as
 * coordenadas achadas no quadro reduzido até o snapshot em resolução cheia.
 *
 * @param {SymbolQuad} quad
 * @param {number} scaleX
 * @param {number} scaleY
 * @returns {SymbolQuad}
 */
export function scaleQuad(quad, scaleX, scaleY) {
  const scalePoint = (point) => ({ x: point.x * scaleX, y: point.y * scaleY });

  return {
    ...quad,
    topLeft: scalePoint(quad.topLeft),
    topRight: scalePoint(quad.topRight),
    bottomRight: scalePoint(quad.bottomRight),
    bottomLeft: scalePoint(quad.bottomLeft),
    moduleSize: quad.moduleSize * (scaleX + scaleY) / 2,
  };
}

/**
 * Expande o quadrilátero em torno do próprio centro.
 *
 * Entre localizar o QR no quadro reduzido e tirar o snapshot passa-se um frame,
 * e a mão treme; a folga extra absorve esse deslocamento sem cortar o símbolo.
 *
 * @param {SymbolQuad} quad
 * @param {number} factor Fator de expansão (1 = sem alteração).
 * @returns {SymbolQuad}
 */
export function expandQuad(quad, factor) {
  const center = centroid([quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]);
  const push = (point) => ({
    x: center.x + (point.x - center.x) * factor,
    y: center.y + (point.y - center.y) * factor,
  });

  return {
    ...quad,
    topLeft: push(quad.topLeft),
    topRight: push(quad.topRight),
    bottomRight: push(quad.bottomRight),
    bottomLeft: push(quad.bottomLeft),
  };
}

/** Distância média entre os centros dos finder patterns adjacentes. */
function betweenCenters({ topLeft, topRight, bottomLeft }) {
  return (distance(topLeft, topRight) + distance(topLeft, bottomLeft)) / 2;
}

/**
 * Dimensão do símbolo, em módulos, ajustada para um valor que exista de fato.
 *
 * Nem todo número é uma dimensão possível: um QR Code tem `17 + 4 x versão`
 * módulos de lado. Encaixar a estimativa na dimensão válida mais próxima
 * absorve o erro de medida e devolve, quase sempre, o número exato — que é o
 * que torna o tamanho do módulo confiável.
 */
function estimateDimension(patterns, measuredModuleSize) {
  const moduleSize =
    measuredModuleSize > 0 ? measuredModuleSize : rotationCorrectedModuleSize(patterns);
  const rough = betweenCenters(patterns) / moduleSize + FINDER_MODULES;
  const version = Math.round((rough - BASE_DIMENSION) / DIMENSION_STEP);
  const dimension = BASE_DIMENSION + version * DIMENSION_STEP;

  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, dimension));
}

function translate(point, axisA, amountA, axisB, amountB) {
  return {
    x: point.x + axisA.x * amountA + axisB.x * amountB,
    y: point.y + axisA.y * amountA + axisB.y * amountB,
  };
}
