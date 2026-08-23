/**
 * Reconstrução do quadrilátero do símbolo a partir dos três finder patterns.
 *
 * Cada finder pattern fica a 3,5 módulos das duas bordas do símbolo. Sabendo o
 * tamanho do módulo em pixels, dá para empurrar cada centro para fora até o
 * canto real do QR. O quarto canto não tem finder pattern: é o fecho do
 * paralelogramo, o que ignora a perspectiva residual mas erra bem menos do que
 * a margem que já existe.
 */

import { FINDER_MODULES, rotationCorrectedModuleSize, type OrderedFinderPatterns } from './finder.ts';
import { distance, unitVector, type Point } from './geometry.ts';

const FINDER_CENTER_INSET = FINDER_MODULES / 2;

// Dimensões válidas de um QR Code: 21, 25, ..., 177 (17 + 4 x versão).
const BASE_DIMENSION = 17;
const DIMENSION_STEP = 4;
const MIN_DIMENSION = 21;
const MAX_DIMENSION = 177;

export type SymbolQuad = {
  corners: Point[];
  /** Tamanho do módulo, em pixels da imagem analisada. */
  moduleSize: number;
  /** Dimensão do símbolo em módulos. */
  modules: number;
};

/**
 * Estima o quadrilátero do símbolo, na ordem
 * superior-esquerdo, superior-direito, inferior-direito, inferior-esquerdo.
 *
 * @param patterns Os três finder patterns já rotulados.
 * @param measuredModuleSize Medida ao longo do eixo do símbolo, invariante à
 *   rotação. Sem ela cai-se na estimativa das varreduras, menos precisa.
 */
export function estimateSymbolQuad(
  patterns: OrderedFinderPatterns,
  measuredModuleSize?: number,
): SymbolQuad {
  'worklet';
  const { topLeft, topRight, bottomLeft } = patterns;

  const horizontal = unitVector(topLeft, topRight);
  const vertical = unitVector(topLeft, bottomLeft);

  const modules = estimateDimension(patterns, measuredModuleSize);

  // Com a dimensão conhecida, o módulo passa a ser puramente geométrico: uma
  // distância entre centros dividida por uma contagem exata. Bem mais preciso
  // que a média das medidas de varredura.
  const moduleSize = betweenCenters(patterns) / (modules - FINDER_MODULES);
  const outset = FINDER_CENTER_INSET * moduleSize;

  const bottomRight = {
    x: topRight.x + bottomLeft.x - topLeft.x,
    y: topRight.y + bottomLeft.y - topLeft.y,
  };

  return {
    corners: [
      translate(topLeft, horizontal, -outset, vertical, -outset),
      translate(topRight, horizontal, outset, vertical, -outset),
      translate(bottomRight, horizontal, outset, vertical, outset),
      translate(bottomLeft, horizontal, -outset, vertical, outset),
    ],
    moduleSize,
    modules,
  };
}

/** Distância média entre os centros dos finder patterns adjacentes. */
function betweenCenters({ topLeft, topRight, bottomLeft }: OrderedFinderPatterns): number {
  'worklet';
  return (distance(topLeft, topRight) + distance(topLeft, bottomLeft)) / 2;
}

/**
 * Dimensão do símbolo ajustada para um valor que exista de fato: um QR tem
 * `17 + 4 x versão` módulos de lado. Encaixar na dimensão válida mais próxima
 * absorve o erro de medida e devolve, quase sempre, o número exato — que é o
 * que torna o tamanho do módulo confiável.
 */
function estimateDimension(
  patterns: OrderedFinderPatterns,
  measuredModuleSize?: number,
): number {
  'worklet';
  const moduleSize =
    measuredModuleSize !== undefined && measuredModuleSize > 0
      ? measuredModuleSize
      : rotationCorrectedModuleSize(patterns);

  const rough = betweenCenters(patterns) / moduleSize + FINDER_MODULES;
  const version = Math.round((rough - BASE_DIMENSION) / DIMENSION_STEP);
  const dimension = BASE_DIMENSION + version * DIMENSION_STEP;

  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, dimension));
}

function translate(
  point: Point,
  axisA: Point,
  amountA: number,
  axisB: Point,
  amountB: number,
): Point {
  'worklet';
  return {
    x: point.x + axisA.x * amountA + axisB.x * amountB,
    y: point.y + axisA.y * amountA + axisB.y * amountB,
  };
}
