/**
 * Binarização adaptativa por blocos (variação do "hybrid binarizer" do ZXing).
 *
 * Um limiar global falha na prática: a câmera quase sempre produz gradiente de
 * iluminação (sombra da mão, reflexo, papel dobrado), e qualquer corte único
 * apaga metade do símbolo. Aqui a imagem é dividida em blocos de 8x8 e o limiar
 * de um pixel é a média da vizinhança 5x5 de blocos, o que acompanha o
 * gradiente sem custo relevante.
 *
 * Blocos de contraste muito baixo não têm limiar próprio confiável — usá-lo
 * transformaria ruído em módulos pretos —, então herdam o dos vizinhos.
 */

import type { Luma } from './luma.ts';

export const BLACK = 1;
export const WHITE = 0;

const BLOCK_SIZE_POWER = 3;
const BLOCK_SIZE = 1 << BLOCK_SIZE_POWER;
const BLOCK_AREA_POWER = BLOCK_SIZE_POWER * 2;
const NEIGHBOR_RADIUS = 2;
const MIN_DYNAMIC_RANGE = 24;
const MAX_LUMA = 255;

/** Converte luminância em matriz binária (`BLACK`/`WHITE`), 1 byte por pixel. */
export function binarize(luma: Luma): Uint8Array {
  'worklet';
  if (luma.width < BLOCK_SIZE || luma.height < BLOCK_SIZE) return binarizeGlobal(luma);

  const columns = blockCount(luma.width);
  const rows = blockCount(luma.height);
  return applyBlackPoints(luma, computeBlackPoints(luma, columns, rows), columns, rows);
}

function blockCount(size: number): number {
  'worklet';
  const whole = size >> BLOCK_SIZE_POWER;
  return (whole << BLOCK_SIZE_POWER) < size ? whole + 1 : whole;
}

/** Recua o último bloco para que todos tenham exatamente 8x8 pixels. */
function blockOffset(blockIndex: number, size: number): number {
  'worklet';
  const offset = blockIndex << BLOCK_SIZE_POWER;
  const maxOffset = size - BLOCK_SIZE;
  return offset > maxOffset ? maxOffset : offset;
}

function computeBlackPoints(luma: Luma, columns: number, rows: number): Int32Array {
  'worklet';
  const { data, width, height } = luma;
  const blackPoints = new Int32Array(columns * rows);

  for (let blockY = 0; blockY < rows; blockY += 1) {
    const yOffset = blockOffset(blockY, height);

    for (let blockX = 0; blockX < columns; blockX += 1) {
      const xOffset = blockOffset(blockX, width);

      let sum = 0;
      let min = MAX_LUMA;
      let max = 0;

      for (let y = 0; y < BLOCK_SIZE; y += 1) {
        let index = (yOffset + y) * width + xOffset;
        for (let x = 0; x < BLOCK_SIZE; x += 1, index += 1) {
          const pixel = data[index];
          sum += pixel;
          if (pixel < min) min = pixel;
          if (pixel > max) max = pixel;
        }
      }

      let average = sum >> BLOCK_AREA_POWER;

      if (max - min <= MIN_DYNAMIC_RANGE) {
        // Bloco uniforme: assume fundo claro e, havendo vizinhos já calculados,
        // herda o limiar deles — evita "inventar" preto numa região lisa.
        average = min >> 1;

        if (blockY > 0 && blockX > 0) {
          const neighborAverage =
            (blackPoints[(blockY - 1) * columns + blockX] +
              2 * blackPoints[blockY * columns + blockX - 1] +
              blackPoints[(blockY - 1) * columns + blockX - 1]) >>
            2;
          if (min < neighborAverage) average = neighborAverage;
        }
      }

      blackPoints[blockY * columns + blockX] = average;
    }
  }

  return blackPoints;
}

function applyBlackPoints(
  luma: Luma,
  blackPoints: Int32Array,
  columns: number,
  rows: number,
): Uint8Array {
  'worklet';
  const { data, width, height } = luma;
  const binary = new Uint8Array(width * height);

  for (let blockY = 0; blockY < rows; blockY += 1) {
    const yOffset = blockOffset(blockY, height);
    const top = clamp(blockY, NEIGHBOR_RADIUS, rows - NEIGHBOR_RADIUS - 1);

    for (let blockX = 0; blockX < columns; blockX += 1) {
      const xOffset = blockOffset(blockX, width);
      const left = clamp(blockX, NEIGHBOR_RADIUS, columns - NEIGHBOR_RADIUS - 1);

      let sum = 0;
      let samples = 0;
      for (let dy = -NEIGHBOR_RADIUS; dy <= NEIGHBOR_RADIUS; dy += 1) {
        const y = top + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx += 1) {
          const x = left + dx;
          if (x < 0 || x >= columns) continue;
          sum += blackPoints[y * columns + x];
          samples += 1;
        }
      }
      const threshold = sum / samples;

      for (let y = 0; y < BLOCK_SIZE; y += 1) {
        let index = (yOffset + y) * width + xOffset;
        for (let x = 0; x < BLOCK_SIZE; x += 1, index += 1) {
          binary[index] = data[index] <= threshold ? BLACK : WHITE;
        }
      }
    }
  }

  return binary;
}

/** Fallback para imagens menores que um bloco: limiar pela média. */
function binarizeGlobal({ data, width, height }: Luma): Uint8Array {
  'worklet';
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const threshold = sum / data.length;

  const binary = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) binary[i] = data[i] <= threshold ? BLACK : WHITE;
  return binary;
}

function clamp(value: number, min: number, max: number): number {
  'worklet';
  if (max < min) return min;
  if (value < min) return min;
  return value > max ? max : value;
}
