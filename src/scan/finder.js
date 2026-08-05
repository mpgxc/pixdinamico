/**
 * Localização dos três *finder patterns* de um QR Code — os quadrados-alvo dos
 * cantos superior-esquerdo, superior-direito e inferior-esquerdo.
 *
 * Por que localizar antes de decodificar: um decodificador só devolve alguma
 * coisa quando consegue ler o símbolo inteiro. Quando o QR está pequeno na cena
 * (longe, na tela de outra pessoa, num boleto impresso), a leitura falha mas os
 * finder patterns continuam visíveis — eles são a estrutura mais grossa e mais
 * redundante do símbolo. Achá-los permite recortar exatamente aquela região do
 * quadro em resolução cheia, ampliar e tentar de novo, que é o que faz o
 * scanner ler o que o caminho direto não lê.
 *
 * O algoritmo é o clássico do ZXing: varre linhas procurando a assinatura de
 * proporção 1:1:3:1:1 (preto-branco-preto-branco-preto) e confirma cada
 * candidato com verificações cruzadas na vertical, na horizontal e na diagonal,
 * o que elimina quase todo falso positivo vindo de texto e de listras.
 *
 * Módulo puro (sem DOM), testável no Node.
 */

import { BLACK } from './binarize.js';
import { distance, unitVector } from './geometry.js';

/** Módulos que compõem um finder pattern (7x7). */
export const FINDER_MODULES = 7;

const STATE_COUNT = 5; // preto, branco, preto(3x), branco, preto
const CENTER_MODULES = 3; // o quadrado central tem 3 módulos de lado
const MIN_TOTAL_MODULES = 7;

// Quantas linhas pular entre varreduras. Assumir um símbolo de no máximo ~97
// módulos garante que nenhum finder pattern (7 módulos) seja pulado inteiro.
const MIN_ROW_SKIP = 3;
const MAX_MODULES_PER_SIDE = 97;

// Tolerâncias das verificações de proporção.
const VARIANCE_DIVISOR = 2; // aceita ±½ módulo por faixa
const DIAGONAL_VARIANCE_DIVISOR = 1.333; // diagonal é mais ruidosa: mais folga
const CROSS_CHECK_TOTAL_TOLERANCE = 0.4; // 40% de diferença de espessura

// Seleção do trio final.
const REQUIRED_PATTERNS = 3;
const MAX_CANDIDATES = 6; // C(6,3) = 20 combinações no pior caso
const MIN_SYMBOL_MODULES = 21; // versão 1
const MAX_SYMBOL_MODULES = 177; // versão 40
const MAX_LEG_RATIO_ERROR = 0.35; // as duas pernas devem ter tamanho parecido
const MAX_HYPOTENUSE_ERROR = 0.3; // ...e formar um triângulo retângulo
const MAX_MODULE_SIZE_RATIO = 1.7; // módulos dos 3 cantos devem bater entre si

/**
 * @typedef {Object} FinderPattern
 * @property {number} x           Centro em pixels (coluna).
 * @property {number} y           Centro em pixels (linha).
 * @property {number} moduleSize  Tamanho estimado de 1 módulo, em pixels.
 * @property {number} count       Quantas linhas confirmaram este centro.
 */

/**
 * @typedef {Object} OrderedFinderPatterns
 * @property {FinderPattern} topLeft
 * @property {FinderPattern} topRight
 * @property {FinderPattern} bottomLeft
 */

/**
 * Varre a imagem binária e devolve todos os candidatos a finder pattern.
 *
 * @param {Uint8Array} binary Matriz binária (ver `binarize`).
 * @param {number} width
 * @param {number} height
 * @returns {FinderPattern[]} Candidatos, na ordem em que foram encontrados.
 */
export function findFinderPatterns(binary, width, height) {
  const centers = [];
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
        // Estados ímpares contam branco; ver preto encerra a faixa anterior.
        if ((state & 1) === 1) state += 1;
        stateCount[state] += 1;
        continue;
      }

      if ((state & 1) === 1) {
        // Já estávamos contando branco: só acumula.
        stateCount[state] += 1;
        continue;
      }

      if (state !== STATE_COUNT - 1) {
        state += 1;
        stateCount[state] += 1;
        continue;
      }

      // Fechou as cinco faixas: temos um candidato a 1:1:3:1:1.
      if (hasFinderRatio(stateCount) && handleCandidate(binary, width, height, stateCount, y, x, centers)) {
        stateCount.fill(0);
        state = 0;
      } else {
        // Reaproveita as três últimas faixas como início de um novo candidato.
        shiftStateCount(stateCount);
        state = 3;
      }
    }

    // A linha pode terminar exatamente no fim de um padrão.
    if (state === STATE_COUNT - 1 && hasFinderRatio(stateCount)) {
      handleCandidate(binary, width, height, stateCount, y, width, centers);
    }
  }

  return centers;
}

/**
 * Escolhe entre os candidatos o trio que melhor forma um QR Code e o devolve
 * já rotulado por posição.
 *
 * @param {FinderPattern[]} centers
 * @returns {OrderedFinderPatterns|null} `null` quando nenhum trio é plausível.
 */
export function selectFinderTriple(centers) {
  if (centers.length < REQUIRED_PATTERNS) return null;

  const candidates = [...centers]
    .sort((a, b) => b.count - a.count || b.moduleSize - a.moduleSize)
    .slice(0, MAX_CANDIDATES);

  let best = null;

  for (let i = 0; i < candidates.length - 2; i += 1) {
    for (let j = i + 1; j < candidates.length - 1; j += 1) {
      for (let k = j + 1; k < candidates.length; k += 1) {
        const evaluated = evaluateTriple([candidates[i], candidates[j], candidates[k]]);
        if (evaluated && (best === null || evaluated.error < best.error)) {
          best = evaluated;
        }
      }
    }
  }

  return best ? best.ordered : null;
}

/**
 * Rotula três centros por posição no símbolo. O lado mais longo do triângulo é
 * a hipotenusa (liga superior-direito e inferior-esquerdo), então o vértice
 * oposto a ela é o superior-esquerdo. O sinal do produto vetorial diz qual dos
 * outros dois é a direita (lembrando que o eixo Y da imagem cresce para baixo).
 *
 * @param {FinderPattern[]} trio
 * @returns {OrderedFinderPatterns|null} `null` se os pontos forem colineares.
 */
export function orderFinderPatterns([a, b, c]) {
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ca = distance(c, a);

  let topLeft;
  let first;
  let second;

  if (ab >= bc && ab >= ca) {
    [topLeft, first, second] = [c, a, b];
  } else if (bc >= ab && bc >= ca) {
    [topLeft, first, second] = [a, b, c];
  } else {
    [topLeft, first, second] = [b, c, a];
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
 * Mede o tamanho do módulo percorrendo a imagem ao longo do eixo do símbolo.
 *
 * É a medida boa: caminhando do centro de um finder pattern na direção de
 * outro, a linha percorrida é paralela às faixas do símbolo — então as
 * distâncias saem em módulos reais, sem o alongamento que a varredura
 * horizontal sofre quando o QR está girado.
 *
 * Do centro até sair do finder pattern há 3,5 módulos (meio quadrado central +
 * anel branco + anel preto); somando os dois sentidos e as duas direções,
 * chega-se a 14 módulos — daí o divisor.
 *
 * @param {Uint8Array} binary
 * @param {number} width
 * @param {number} height
 * @param {OrderedFinderPatterns} patterns
 * @returns {number} Tamanho do módulo em pixels; cai para a estimativa das
 *   varreduras quando a imagem não permite completar o percurso.
 */
export function measureModuleSize(binary, width, height, patterns) {
  const { topLeft, topRight, bottomLeft } = patterns;

  const along = (a, b) => {
    const forward = runBothWays(binary, width, height, a, b);
    const backward = runBothWays(binary, width, height, b, a);
    return Number.isNaN(forward) || Number.isNaN(backward)
      ? Number.NaN
      : (forward + backward) / (2 * FINDER_MODULES);
  };

  const horizontal = along(topLeft, topRight);
  const vertical = along(topLeft, bottomLeft);

  if (Number.isNaN(horizontal) && Number.isNaN(vertical)) {
    return rotationCorrectedModuleSize(patterns);
  }
  if (Number.isNaN(horizontal)) return vertical;
  if (Number.isNaN(vertical)) return horizontal;

  return (horizontal + vertical) / 2;
}

/**
 * Extensão preto-branco-preto em torno de `from`, na direção de `to`, somando
 * os dois sentidos (o pixel central, contado duas vezes, é descontado).
 */
function runBothWays(binary, width, height, from, to) {
  const forward = blackWhiteBlackRun(binary, width, height, from, to);
  // Mesma reta, sentido oposto: reflete o destino em torno da origem.
  const mirrored = { x: 2 * from.x - to.x, y: 2 * from.y - to.y };
  const backward = blackWhiteBlackRun(binary, width, height, from, mirrored);

  return Number.isNaN(forward) || Number.isNaN(backward) ? Number.NaN : forward + backward - 1;
}

/**
 * Caminha de `from` na direção de `to` (Bresenham) e devolve a distância
 * percorrida até completar preto -> branco -> preto -> branco.
 */
function blackWhiteBlackRun(binary, width, height, from, to) {
  let fromX = Math.round(from.x);
  let fromY = Math.round(from.y);
  let toX = Math.round(to.x);
  let toY = Math.round(to.y);

  // Bresenham só anda bem no eixo dominante; em retas íngremes trocamos os
  // eixos, andamos, e desfazemos a troca na hora de ler o pixel.
  const steep = Math.abs(toY - fromY) > Math.abs(toX - fromX);
  if (steep) {
    [fromX, fromY] = [fromY, fromX];
    [toX, toY] = [toY, toX];
  }

  const deltaX = Math.abs(toX - fromX);
  const deltaY = Math.abs(toY - fromY);
  const stepX = fromX < toX ? 1 : -1;
  const stepY = fromY < toY ? 1 : -1;
  const limitX = toX + stepX;

  let error = -deltaX / 2;
  let state = 0; // 0: preto inicial, 1: branco, 2: preto final
  let y = fromY;

  for (let x = fromX; x !== limitX; x += stepX) {
    const pixelX = steep ? y : x;
    const pixelY = steep ? x : y;

    const isBlack =
      pixelX >= 0 && pixelY >= 0 && pixelX < width && pixelY < height &&
      binary[pixelY * width + pixelX] === BLACK;

    // Em estado ímpar procuramos preto; em estado par, branco.
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

  // Chegou ao fim ainda no preto final: aceita a distância total percorrida.
  return state === 2 ? Math.hypot(limitX - fromX, toY - fromY) : Number.NaN;
}

/**
 * Tamanho do módulo medido nos finder patterns, corrigido pela rotação.
 *
 * As faixas 1:1:3:1:1 são medidas em varreduras **horizontais**. Se o símbolo
 * estiver girado θ, a linha de varredura cruza cada faixa na diagonal e mede
 * `módulo / cos θ` — um erro de até 41% que, propagado, erra a versão do
 * símbolo e desalinha o recorte.
 *
 * A correção é o cosseno do ângulo entre a horizontal e o eixo do símbolo cujas
 * faixas a varredura cruzou. Como o finder pattern é um quadrado, os dois eixos
 * são perpendiculares e a varredura cruza sempre o de normal mais horizontal —
 * daí o `max`, que também garante um fator nunca menor que √2/2.
 *
 * @param {OrderedFinderPatterns} patterns
 * @returns {number} Tamanho do módulo em pixels.
 */
export function rotationCorrectedModuleSize({ topLeft, topRight, bottomLeft }) {
  const measured = (topLeft.moduleSize + topRight.moduleSize + bottomLeft.moduleSize) / 3;
  const horizontal = unitVector(topLeft, topRight);
  const vertical = unitVector(topLeft, bottomLeft);

  return measured * Math.max(Math.abs(horizontal.x), Math.abs(vertical.x));
}

/** Verifica se as cinco faixas seguem a proporção 1:1:3:1:1. */
function hasFinderRatio(stateCount) {
  let total = 0;
  for (let i = 0; i < STATE_COUNT; i += 1) {
    if (stateCount[i] === 0) return false;
    total += stateCount[i];
  }
  if (total < MIN_TOTAL_MODULES) return false;

  return matchesRatio(stateCount, total, VARIANCE_DIVISOR);
}

function matchesRatio(stateCount, total, varianceDivisor) {
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

/**
 * Descarta a primeira faixa preto/branco e reaproveita as três últimas como
 * começo de um novo padrão (o preto central pode ser o preto inicial do
 * próximo candidato).
 */
function shiftStateCount(stateCount) {
  stateCount[0] = stateCount[2];
  stateCount[1] = stateCount[3];
  stateCount[2] = stateCount[4];
  stateCount[3] = 1; // o pixel branco atual já inicia a quarta faixa
  stateCount[4] = 0;
}

/** Centro do padrão, medido a partir do fim da última faixa. */
function centerFromEnd(stateCount, end) {
  return end - stateCount[4] - stateCount[3] - stateCount[2] / 2;
}

/**
 * Confirma um candidato com as três verificações cruzadas e, se passar,
 * registra (ou reforça) o centro correspondente.
 *
 * @returns {boolean} `true` quando o candidato foi confirmado.
 */
function handleCandidate(binary, width, height, stateCount, row, end, centers) {
  const total = stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  const maxCount = stateCount[2] * 2;

  let centerX = centerFromEnd(stateCount, end);
  const centerY = crossCheckVertical(binary, width, height, row, Math.round(centerX), maxCount, total);
  if (Number.isNaN(centerY)) return false;

  centerX = crossCheckHorizontal(binary, width, height, Math.round(centerX), Math.round(centerY), maxCount, total);
  if (Number.isNaN(centerX)) return false;

  if (!crossCheckDiagonal(binary, width, height, Math.round(centerX), Math.round(centerY))) {
    return false;
  }

  registerCenter(centers, centerX, centerY, total / FINDER_MODULES);
  return true;
}

/** Acumula o candidato num centro existente, ou cria um novo. */
function registerCenter(centers, x, y, moduleSize) {
  for (const center of centers) {
    if (Math.abs(center.x - x) > moduleSize || Math.abs(center.y - y) > moduleSize) {
      continue;
    }
    const sizeDiff = Math.abs(center.moduleSize - moduleSize);
    if (sizeDiff > 1 && sizeDiff > moduleSize) continue;

    // Média ponderada pelo número de confirmações já acumuladas.
    const count = center.count + 1;
    center.x = (center.count * center.x + x) / count;
    center.y = (center.count * center.y + y) / count;
    center.moduleSize = (center.count * center.moduleSize + moduleSize) / count;
    center.count = count;
    return;
  }

  centers.push({ x, y, moduleSize, count: 1 });
}

/**
 * Percorre a coluna `x` a partir de `startY` para os dois lados, remontando as
 * cinco faixas na vertical. Devolve o centro em Y, ou `NaN` se não bater.
 */
function crossCheckVertical(binary, width, height, startY, x, maxCount, originalTotal) {
  if (x < 0 || x >= width) return NaN;

  const stateCount = new Int32Array(STATE_COUNT);
  const isBlack = (y) => binary[y * width + x] === BLACK;

  let y = startY;
  while (y >= 0 && isBlack(y)) {
    stateCount[2] += 1;
    y -= 1;
  }
  if (y < 0) return NaN;
  while (y >= 0 && !isBlack(y) && stateCount[1] <= maxCount) {
    stateCount[1] += 1;
    y -= 1;
  }
  if (y < 0 || stateCount[1] > maxCount) return NaN;
  while (y >= 0 && isBlack(y) && stateCount[0] <= maxCount) {
    stateCount[0] += 1;
    y -= 1;
  }
  if (stateCount[0] > maxCount) return NaN;

  y = startY + 1;
  while (y < height && isBlack(y)) {
    stateCount[2] += 1;
    y += 1;
  }
  if (y === height) return NaN;
  while (y < height && !isBlack(y) && stateCount[3] < maxCount) {
    stateCount[3] += 1;
    y += 1;
  }
  if (y === height || stateCount[3] >= maxCount) return NaN;
  while (y < height && isBlack(y) && stateCount[4] < maxCount) {
    stateCount[4] += 1;
    y += 1;
  }
  if (stateCount[4] >= maxCount) return NaN;

  const total = stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  if (Math.abs(total - originalTotal) > CROSS_CHECK_TOTAL_TOLERANCE * originalTotal) {
    return NaN;
  }

  return matchesRatio(stateCount, total, VARIANCE_DIVISOR) ? centerFromEnd(stateCount, y) : NaN;
}

/** Espelho horizontal de `crossCheckVertical`; devolve o centro em X. */
function crossCheckHorizontal(binary, width, height, startX, y, maxCount, originalTotal) {
  if (y < 0 || y >= height) return NaN;

  const stateCount = new Int32Array(STATE_COUNT);
  const rowStart = y * width;
  const isBlack = (x) => binary[rowStart + x] === BLACK;

  let x = startX;
  while (x >= 0 && isBlack(x)) {
    stateCount[2] += 1;
    x -= 1;
  }
  if (x < 0) return NaN;
  while (x >= 0 && !isBlack(x) && stateCount[1] <= maxCount) {
    stateCount[1] += 1;
    x -= 1;
  }
  if (x < 0 || stateCount[1] > maxCount) return NaN;
  while (x >= 0 && isBlack(x) && stateCount[0] <= maxCount) {
    stateCount[0] += 1;
    x -= 1;
  }
  if (stateCount[0] > maxCount) return NaN;

  x = startX + 1;
  while (x < width && isBlack(x)) {
    stateCount[2] += 1;
    x += 1;
  }
  if (x === width) return NaN;
  while (x < width && !isBlack(x) && stateCount[3] < maxCount) {
    stateCount[3] += 1;
    x += 1;
  }
  if (x === width || stateCount[3] >= maxCount) return NaN;
  while (x < width && isBlack(x) && stateCount[4] < maxCount) {
    stateCount[4] += 1;
    x += 1;
  }
  if (stateCount[4] >= maxCount) return NaN;

  const total = stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  if (Math.abs(total - originalTotal) > CROSS_CHECK_TOTAL_TOLERANCE * originalTotal) {
    return NaN;
  }

  return matchesRatio(stateCount, total, VARIANCE_DIVISOR) ? centerFromEnd(stateCount, x) : NaN;
}

/**
 * Verificação na diagonal principal. É o que derruba os falsos positivos que
 * passam nas duas anteriores — tipicamente cruzamentos de linhas em tabelas e
 * trechos de texto, que têm a proporção certa na horizontal e na vertical mas
 * não formam um quadrado.
 */
function crossCheckDiagonal(binary, width, height, centerX, centerY) {
  if (centerX < 0 || centerX >= width || centerY < 0 || centerY >= height) return false;

  const stateCount = new Int32Array(STATE_COUNT);
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  const isBlack = (x, y) => binary[y * width + x] === BLACK;

  // Sobe pela diagonal (para cima e para a esquerda).
  let step = 0;
  while (inside(centerX - step, centerY - step) && isBlack(centerX - step, centerY - step)) {
    stateCount[2] += 1;
    step += 1;
  }
  if (stateCount[2] === 0) return false;
  while (inside(centerX - step, centerY - step) && !isBlack(centerX - step, centerY - step)) {
    stateCount[1] += 1;
    step += 1;
  }
  if (stateCount[1] === 0) return false;
  while (inside(centerX - step, centerY - step) && isBlack(centerX - step, centerY - step)) {
    stateCount[0] += 1;
    step += 1;
  }
  if (stateCount[0] === 0) return false;

  // Desce pela diagonal (para baixo e para a direita).
  step = 1;
  while (inside(centerX + step, centerY + step) && isBlack(centerX + step, centerY + step)) {
    stateCount[2] += 1;
    step += 1;
  }
  while (inside(centerX + step, centerY + step) && !isBlack(centerX + step, centerY + step)) {
    stateCount[3] += 1;
    step += 1;
  }
  if (stateCount[3] === 0) return false;
  while (inside(centerX + step, centerY + step) && isBlack(centerX + step, centerY + step)) {
    stateCount[4] += 1;
    step += 1;
  }
  if (stateCount[4] === 0) return false;

  const total = stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
  return matchesRatio(stateCount, total, DIAGONAL_VARIANCE_DIVISOR);
}

/**
 * Mede o quanto um trio se parece com os cantos de um QR: pernas de tamanho
 * semelhante, ângulo reto entre elas e módulos consistentes. Devolve `null`
 * quando o trio é implausível, ou um erro (quanto menor, melhor) quando passa.
 */
function evaluateTriple(trio) {
  const ordered = orderFinderPatterns(trio);
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

  const sizes = trio.map((pattern) => pattern.moduleSize);
  const sizeRatio = Math.max(...sizes) / Math.min(...sizes);
  if (sizeRatio > MAX_MODULE_SIZE_RATIO) return null;

  // Entre os centros dos finder patterns cabem (dimensão - 7) módulos. A
  // correção de rotação é indispensável aqui: sem ela um símbolo pequeno e
  // girado parece ter menos módulos do que o mínimo e seria descartado.
  const moduleSize = rotationCorrectedModuleSize(ordered);
  const modules = Math.round((topLeg + leftLeg) / 2 / moduleSize) + FINDER_MODULES;
  if (modules < MIN_SYMBOL_MODULES || modules > MAX_SYMBOL_MODULES) return null;

  return { ordered, error: legError + hypotenuseError + (sizeRatio - 1) };
}
