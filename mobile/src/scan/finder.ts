/**
 * Localização dos três *finder patterns* de um QR Code.
 *
 * Um decodificador só devolve algo quando lê o símbolo inteiro. Quando o QR
 * está pequeno na cena, a leitura falha mas os finder patterns continuam
 * visíveis — são a estrutura mais grossa e mais redundante do símbolo. Achá-los
 * responde "tem um QR aí, e de que tamanho?" sem decodificar nada, e é
 * exatamente essa resposta que diz de quanto aproximar a lente.
 *
 * Algoritmo clássico do ZXing: varre linhas atrás da proporção 1:1:3:1:1 e
 * confirma cada candidato na vertical, na horizontal e na diagonal, o que
 * elimina quase todo falso positivo de texto e de listras.
 */

import { BLACK } from './binarize.ts';
import { distance, unitVector, type Point } from './geometry.ts';

export const FINDER_MODULES = 7;

const STATE_COUNT = 5;
const CENTER_MODULES = 3;
const MIN_TOTAL_MODULES = 7;

const MIN_ROW_SKIP = 3;
const MAX_MODULES_PER_SIDE = 97;

const VARIANCE_DIVISOR = 2;
const DIAGONAL_VARIANCE_DIVISOR = 1.333;
const CROSS_CHECK_TOTAL_TOLERANCE = 0.4;

const REQUIRED_PATTERNS = 3;
const MAX_CANDIDATES = 6;
const MIN_SYMBOL_MODULES = 21;
const MAX_SYMBOL_MODULES = 177;
const MAX_LEG_RATIO_ERROR = 0.35;
const MAX_HYPOTENUSE_ERROR = 0.3;
const MAX_MODULE_SIZE_RATIO = 1.7;

export type FinderPattern = Point & { moduleSize: number; count: number };

export type OrderedFinderPatterns = {
  topLeft: FinderPattern;
  topRight: FinderPattern;
  bottomLeft: FinderPattern;
};

/** Varre a imagem binária e devolve todos os candidatos a finder pattern. */
export function findFinderPatterns(
  binary: Uint8Array,
  width: number,
  height: number,
): FinderPattern[] {
  'worklet';
  const centers: FinderPattern[] = [];
  const rowSkip = Math.max(
    MIN_ROW_SKIP,
    Math.floor((CENTER_MODULES * height) / (4 * MAX_MODULES_PER_SIDE)),
  );
  const stateCount = new Int32Array(STATE_COUNT);

  for (let y = rowSkip - 1; y < height; y += rowSkip) {
    stateCount.fill(0);
    let state = 0;
    const rowStart = y * width;

    for (let x = 0; x < width; x += 1) {
      const isBlack = binary[rowStart + x] === BLACK;

      if (isBlack) {
        if ((state & 1) === 1) state += 1;
        stateCount[state] += 1;
        continue;
      }
      if ((state & 1) === 1) {
        stateCount[state] += 1;
        continue;
      }
      if (state !== STATE_COUNT - 1) {
        state += 1;
        stateCount[state] += 1;
        continue;
      }

      if (
        hasFinderRatio(stateCount) &&
        handleCandidate(binary, width, height, stateCount, y, x, centers)
      ) {
        stateCount.fill(0);
        state = 0;
      } else {
        shiftStateCount(stateCount);
        state = 3;
      }
    }

    if (state === STATE_COUNT - 1 && hasFinderRatio(stateCount)) {
      handleCandidate(binary, width, height, stateCount, y, width, centers);
    }
  }

  return centers;
}

/** Escolhe o trio que melhor forma um QR e o devolve rotulado por posição. */
export function selectFinderTriple(centers: FinderPattern[]): OrderedFinderPatterns | null {
  'worklet';
  if (centers.length < REQUIRED_PATTERNS) return null;

  const candidates = centers
    .slice()
    .sort((a, b) => b.count - a.count || b.moduleSize - a.moduleSize)
    .slice(0, MAX_CANDIDATES);

  let best: { ordered: OrderedFinderPatterns; error: number } | null = null;

  for (let i = 0; i < candidates.length - 2; i += 1) {
    for (let j = i + 1; j < candidates.length - 1; j += 1) {
      for (let k = j + 1; k < candidates.length; k += 1) {
        const evaluated = evaluateTriple(candidates[i], candidates[j], candidates[k]);
        if (evaluated && (best === null || evaluated.error < best.error)) best = evaluated;
      }
    }
  }

  return best ? best.ordered : null;
}

/**
 * Rotula três centros por posição. O lado mais longo do triângulo é a
 * hipotenusa (liga superior-direito e inferior-esquerdo), então o vértice
 * oposto a ela é o superior-esquerdo. O sinal do produto vetorial diz qual dos
 * outros dois é a direita — lembrando que o Y da imagem cresce para baixo.
 */
export function orderFinderPatterns(
  a: FinderPattern,
  b: FinderPattern,
  c: FinderPattern,
): OrderedFinderPatterns | null {
  'worklet';
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ca = distance(c, a);

  let topLeft: FinderPattern;
  let first: FinderPattern;
  let second: FinderPattern;

  if (ab >= bc && ab >= ca) {
    topLeft = c;
    first = a;
    second = b;
  } else if (bc >= ab && bc >= ca) {
    topLeft = a;
    first = b;
    second = c;
  } else {
    topLeft = b;
    first = c;
    second = a;
  }

  const cross =
    (first.x - topLeft.x) * (second.y - topLeft.y) -
    (first.y - topLeft.y) * (second.x - topLeft.x);
  if (cross === 0) return null;

  return cross > 0
    ? { topLeft, topRight: first, bottomLeft: second }
    : { topLeft, topRight: second, bottomLeft: first };
}

/**
 * Mede o módulo caminhando ao longo do eixo do símbolo.
 *
 * É a medida boa: a linha percorrida é paralela às faixas, então as distâncias
 * saem em módulos reais, sem o alongamento de 1/cos(θ) que a varredura
 * horizontal sofre quando o QR está girado (até 41% a 45 graus). Do centro até
 * sair do finder pattern há 3,5 módulos; somando os dois sentidos e as duas
 * direções chega-se a 14 — daí o divisor.
 */
export function measureModuleSize(
  binary: Uint8Array,
  width: number,
  height: number,
  patterns: OrderedFinderPatterns,
): number {
  'worklet';
  const { topLeft, topRight, bottomLeft } = patterns;

  const horizontal = alongAxis(binary, width, height, topLeft, topRight);
  const vertical = alongAxis(binary, width, height, topLeft, bottomLeft);

  if (Number.isNaN(horizontal) && Number.isNaN(vertical)) {
    return rotationCorrectedModuleSize(patterns);
  }
  if (Number.isNaN(horizontal)) return vertical;
  if (Number.isNaN(vertical)) return horizontal;
  return (horizontal + vertical) / 2;
}

function alongAxis(
  binary: Uint8Array,
  width: number,
  height: number,
  a: Point,
  b: Point,
): number {
  'worklet';
  const forward = runBothWays(binary, width, height, a, b);
  const backward = runBothWays(binary, width, height, b, a);
  return Number.isNaN(forward) || Number.isNaN(backward)
    ? Number.NaN
    : (forward + backward) / (2 * FINDER_MODULES);
}

/**
 * Tamanho do módulo medido nas varreduras horizontais, corrigido pela rotação.
 * Só entra como plano B quando o percurso pelo eixo não pôde ser completado.
 * Como o finder pattern é um quadrado, a varredura cruza sempre o eixo de
 * normal mais horizontal — daí o `max`, que garante fator nunca menor que √2/2.
 */
export function rotationCorrectedModuleSize(patterns: OrderedFinderPatterns): number {
  'worklet';
  const { topLeft, topRight, bottomLeft } = patterns;
  const measured = (topLeft.moduleSize + topRight.moduleSize + bottomLeft.moduleSize) / 3;
  const horizontal = unitVector(topLeft, topRight);
  const vertical = unitVector(topLeft, bottomLeft);

  return measured * Math.max(Math.abs(horizontal.x), Math.abs(vertical.x));
}

function runBothWays(
  binary: Uint8Array,
  width: number,
  height: number,
  from: Point,
  to: Point,
): number {
  'worklet';
  const forward = blackWhiteBlackRun(binary, width, height, from, to);
  const mirrored = { x: 2 * from.x - to.x, y: 2 * from.y - to.y };
  const backward = blackWhiteBlackRun(binary, width, height, from, mirrored);
  return Number.isNaN(forward) || Number.isNaN(backward) ? Number.NaN : forward + backward - 1;
}

/** Bresenham de `from` na direção de `to` até completar preto/branco/preto. */
function blackWhiteBlackRun(
  binary: Uint8Array,
  width: number,
  height: number,
  from: Point,
  to: Point,
): number {
  'worklet';
  let fromX = Math.round(from.x);
  let fromY = Math.round(from.y);
  let toX = Math.round(to.x);
  let toY = Math.round(to.y);

  // Bresenham só anda bem no eixo dominante; em retas íngremes trocamos os
  // eixos, andamos, e desfazemos a troca na hora de ler o pixel.
  const steep = Math.abs(toY - fromY) > Math.abs(toX - fromX);
  if (steep) {
    let swap = fromX;
    fromX = fromY;
    fromY = swap;
    swap = toX;
    toX = toY;
    toY = swap;
  }

  const deltaX = Math.abs(toX - fromX);
  const deltaY = Math.abs(toY - fromY);
  const stepX = fromX < toX ? 1 : -1;
  const stepY = fromY < toY ? 1 : -1;
  const limitX = toX + stepX;

  let error = -deltaX / 2;
  let state = 0;
  let y = fromY;

  for (let x = fromX; x !== limitX; x += stepX) {
    const pixelX = steep ? y : x;
    const pixelY = steep ? x : y;

    const isBlack =
      pixelX >= 0 &&
      pixelY >= 0 &&
      pixelX < width &&
      pixelY < height &&
      binary[pixelY * width + pixelX] === BLACK;

    if ((state === 1) === isBlack) {
      if (state === 2) return Math.hypot(x - fromX, y - fromY);
      state += 1;
    }

    error += deltaY;
    if (error > 0) {
      if (y === toY) break;
      y += stepY;
      error -= deltaX;
    }
  }

  return state === 2 ? Math.hypot(limitX - fromX, toY - fromY) : Number.NaN;
}

function hasFinderRatio(stateCount: Int32Array): boolean {
  'worklet';
  let total = 0;
  for (let i = 0; i < STATE_COUNT; i += 1) {
    if (stateCount[i] === 0) return false;
    total += stateCount[i];
  }
  if (total < MIN_TOTAL_MODULES) return false;
  return matchesRatio(stateCount, total, VARIANCE_DIVISOR);
}

function matchesRatio(stateCount: Int32Array, total: number, varianceDivisor: number): boolean {
  'worklet';
  const moduleSize = total / FINDER_MODULES;
  const maxVariance = moduleSize / varianceDivisor;

  return (
    Math.abs(moduleSize - stateCount[0]) < maxVariance &&
    Math.abs(moduleSize - stateCount[1]) < maxVariance &&
    Math.abs(CENTER_MODULES * moduleSize - stateCount[2]) < CENTER_MODULES * maxVariance &&
    Math.abs(moduleSize - stateCount[3]) < maxVariance &&
    Math.abs(moduleSize - stateCount[4]) < maxVariance
  );
}

/** Reaproveita as três últimas faixas como início de um novo candidato. */
function shiftStateCount(stateCount: Int32Array): void {
  'worklet';
  stateCount[0] = stateCount[2];
  stateCount[1] = stateCount[3];
  stateCount[2] = stateCount[4];
  stateCount[3] = 1;
  stateCount[4] = 0;
}

function centerFromEnd(stateCount: Int32Array, end: number): number {
  'worklet';
  return end - stateCount[4] - stateCount[3] - stateCount[2] / 2;
}

function handleCandidate(
  binary: Uint8Array,
  width: number,
  height: number,
  stateCount: Int32Array,
  row: number,
  end: number,
  centers: FinderPattern[],
): boolean {
  'worklet';
  const total =
    stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  const maxCount = stateCount[2] * 2;

  let centerX = centerFromEnd(stateCount, end);
  const centerY = crossCheckVertical(
    binary, width, height, row, Math.round(centerX), maxCount, total,
  );
  if (Number.isNaN(centerY)) return false;

  centerX = crossCheckHorizontal(
    binary, width, height, Math.round(centerX), Math.round(centerY), maxCount, total,
  );
  if (Number.isNaN(centerX)) return false;

  if (!crossCheckDiagonal(binary, width, height, Math.round(centerX), Math.round(centerY))) {
    return false;
  }

  registerCenter(centers, centerX, centerY, total / FINDER_MODULES);
  return true;
}

function registerCenter(
  centers: FinderPattern[],
  x: number,
  y: number,
  moduleSize: number,
): void {
  'worklet';
  for (let i = 0; i < centers.length; i += 1) {
    const center = centers[i];
    if (Math.abs(center.x - x) > moduleSize || Math.abs(center.y - y) > moduleSize) continue;

    const sizeDiff = Math.abs(center.moduleSize - moduleSize);
    if (sizeDiff > 1 && sizeDiff > moduleSize) continue;

    const count = center.count + 1;
    center.x = (center.count * center.x + x) / count;
    center.y = (center.count * center.y + y) / count;
    center.moduleSize = (center.count * center.moduleSize + moduleSize) / count;
    center.count = count;
    return;
  }

  centers.push({ x, y, moduleSize, count: 1 });
}

function crossCheckVertical(
  binary: Uint8Array,
  width: number,
  height: number,
  startY: number,
  x: number,
  maxCount: number,
  originalTotal: number,
): number {
  'worklet';
  if (x < 0 || x >= width) return Number.NaN;

  const stateCount = new Int32Array(STATE_COUNT);
  let y = startY;
  while (y >= 0 && binary[y * width + x] === BLACK) {
    stateCount[2] += 1;
    y -= 1;
  }
  if (y < 0) return Number.NaN;
  while (y >= 0 && binary[y * width + x] !== BLACK && stateCount[1] <= maxCount) {
    stateCount[1] += 1;
    y -= 1;
  }
  if (y < 0 || stateCount[1] > maxCount) return Number.NaN;
  while (y >= 0 && binary[y * width + x] === BLACK && stateCount[0] <= maxCount) {
    stateCount[0] += 1;
    y -= 1;
  }
  if (stateCount[0] > maxCount) return Number.NaN;

  y = startY + 1;
  while (y < height && binary[y * width + x] === BLACK) {
    stateCount[2] += 1;
    y += 1;
  }
  if (y === height) return Number.NaN;
  while (y < height && binary[y * width + x] !== BLACK && stateCount[3] < maxCount) {
    stateCount[3] += 1;
    y += 1;
  }
  if (y === height || stateCount[3] >= maxCount) return Number.NaN;
  while (y < height && binary[y * width + x] === BLACK && stateCount[4] < maxCount) {
    stateCount[4] += 1;
    y += 1;
  }
  if (stateCount[4] >= maxCount) return Number.NaN;

  const total =
    stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  if (Math.abs(total - originalTotal) > CROSS_CHECK_TOTAL_TOLERANCE * originalTotal) {
    return Number.NaN;
  }

  return matchesRatio(stateCount, total, VARIANCE_DIVISOR)
    ? centerFromEnd(stateCount, y)
    : Number.NaN;
}

function crossCheckHorizontal(
  binary: Uint8Array,
  width: number,
  height: number,
  startX: number,
  y: number,
  maxCount: number,
  originalTotal: number,
): number {
  'worklet';
  if (y < 0 || y >= height) return Number.NaN;

  const stateCount = new Int32Array(STATE_COUNT);
  const rowStart = y * width;

  let x = startX;
  while (x >= 0 && binary[rowStart + x] === BLACK) {
    stateCount[2] += 1;
    x -= 1;
  }
  if (x < 0) return Number.NaN;
  while (x >= 0 && binary[rowStart + x] !== BLACK && stateCount[1] <= maxCount) {
    stateCount[1] += 1;
    x -= 1;
  }
  if (x < 0 || stateCount[1] > maxCount) return Number.NaN;
  while (x >= 0 && binary[rowStart + x] === BLACK && stateCount[0] <= maxCount) {
    stateCount[0] += 1;
    x -= 1;
  }
  if (stateCount[0] > maxCount) return Number.NaN;

  x = startX + 1;
  while (x < width && binary[rowStart + x] === BLACK) {
    stateCount[2] += 1;
    x += 1;
  }
  if (x === width) return Number.NaN;
  while (x < width && binary[rowStart + x] !== BLACK && stateCount[3] < maxCount) {
    stateCount[3] += 1;
    x += 1;
  }
  if (x === width || stateCount[3] >= maxCount) return Number.NaN;
  while (x < width && binary[rowStart + x] === BLACK && stateCount[4] < maxCount) {
    stateCount[4] += 1;
    x += 1;
  }
  if (stateCount[4] >= maxCount) return Number.NaN;

  const total =
    stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  if (Math.abs(total - originalTotal) > CROSS_CHECK_TOTAL_TOLERANCE * originalTotal) {
    return Number.NaN;
  }

  return matchesRatio(stateCount, total, VARIANCE_DIVISOR)
    ? centerFromEnd(stateCount, x)
    : Number.NaN;
}

/**
 * Verificação na diagonal principal. É o que derruba os falsos positivos que
 * passam nas duas anteriores — cruzamentos de linhas em tabelas e trechos de
 * texto, que têm a proporção certa nos dois eixos mas não formam um quadrado.
 */
function crossCheckDiagonal(
  binary: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
): boolean {
  'worklet';
  if (centerX < 0 || centerX >= width || centerY < 0 || centerY >= height) return false;

  const stateCount = new Int32Array(STATE_COUNT);
  let step = 0;

  while (
    centerX - step >= 0 && centerY - step >= 0 &&
    binary[(centerY - step) * width + (centerX - step)] === BLACK
  ) {
    stateCount[2] += 1;
    step += 1;
  }
  if (stateCount[2] === 0) return false;
  while (
    centerX - step >= 0 && centerY - step >= 0 &&
    binary[(centerY - step) * width + (centerX - step)] !== BLACK
  ) {
    stateCount[1] += 1;
    step += 1;
  }
  if (stateCount[1] === 0) return false;
  while (
    centerX - step >= 0 && centerY - step >= 0 &&
    binary[(centerY - step) * width + (centerX - step)] === BLACK
  ) {
    stateCount[0] += 1;
    step += 1;
  }
  if (stateCount[0] === 0) return false;

  step = 1;
  while (
    centerX + step < width && centerY + step < height &&
    binary[(centerY + step) * width + (centerX + step)] === BLACK
  ) {
    stateCount[2] += 1;
    step += 1;
  }
  while (
    centerX + step < width && centerY + step < height &&
    binary[(centerY + step) * width + (centerX + step)] !== BLACK
  ) {
    stateCount[3] += 1;
    step += 1;
  }
  if (stateCount[3] === 0) return false;
  while (
    centerX + step < width && centerY + step < height &&
    binary[(centerY + step) * width + (centerX + step)] === BLACK
  ) {
    stateCount[4] += 1;
    step += 1;
  }
  if (stateCount[4] === 0) return false;

  const total =
    stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  return matchesRatio(stateCount, total, DIAGONAL_VARIANCE_DIVISOR);
}

/**
 * Mede o quanto um trio se parece com os cantos de um QR: pernas de tamanho
 * semelhante, ângulo reto entre elas e módulos consistentes.
 */
function evaluateTriple(
  a: FinderPattern,
  b: FinderPattern,
  c: FinderPattern,
): { ordered: OrderedFinderPatterns; error: number } | null {
  'worklet';
  const ordered = orderFinderPatterns(a, b, c);
  if (!ordered) return null;

  const { topLeft, topRight, bottomLeft } = ordered;
  const topLeg = distance(topLeft, topRight);
  const leftLeg = distance(topLeft, bottomLeft);
  if (topLeg === 0 || leftLeg === 0) return null;

  const legError = Math.abs(topLeg - leftLeg) / Math.max(topLeg, leftLeg);
  if (legError > MAX_LEG_RATIO_ERROR) return null;

  const expectedHypotenuse = Math.hypot(topLeg, leftLeg);
  const hypotenuseError =
    Math.abs(distance(topRight, bottomLeft) - expectedHypotenuse) / expectedHypotenuse;
  if (hypotenuseError > MAX_HYPOTENUSE_ERROR) return null;

  const largest = Math.max(a.moduleSize, b.moduleSize, c.moduleSize);
  const smallest = Math.min(a.moduleSize, b.moduleSize, c.moduleSize);
  const sizeRatio = largest / smallest;
  if (sizeRatio > MAX_MODULE_SIZE_RATIO) return null;

  // A correção de rotação é indispensável aqui: sem ela um símbolo pequeno e
  // girado parece ter menos módulos que o mínimo e seria descartado.
  const moduleSize = rotationCorrectedModuleSize(ordered);
  const modules = Math.round((topLeg + leftLeg) / 2 / moduleSize) + FINDER_MODULES;
  if (modules < MIN_SYMBOL_MODULES || modules > MAX_SYMBOL_MODULES) return null;

  return { ordered, error: legError + hypotenuseError + (sizeRatio - 1) };
}
