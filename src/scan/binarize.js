/**
 * Binarização adaptativa por blocos (variação do "hybrid binarizer" do ZXing).
 *
 * Um limiar global falha na prática: a câmera quase sempre produz gradiente de
 * iluminação (sombra da mão, reflexo, papel dobrado), e qualquer corte único
 * apaga metade do símbolo. Aqui a imagem é dividida em blocos de 8x8, calcula-se
 * a média de cada bloco e o limiar de um pixel é a média da vizinhança 5x5 de
 * blocos — o que acompanha o gradiente sem custo relevante.
 *
 * Blocos de contraste muito baixo (área totalmente branca, por exemplo) não têm
 * um limiar próprio confiável: usá-lo transformaria ruído em módulos pretos.
 * Nesse caso herdamos o limiar dos vizinhos já calculados.
 *
 * Módulo puro (sem DOM), testável no Node.
 */

/** Valor de um pixel preto na matriz binária. */
export const BLACK = 1;
/** Valor de um pixel branco na matriz binária. */
export const WHITE = 0;

const BLOCK_SIZE_POWER = 3;
const BLOCK_SIZE = 1 << BLOCK_SIZE_POWER; // 8
const BLOCK_AREA_POWER = BLOCK_SIZE_POWER * 2; // média = soma >> 6
const NEIGHBOR_RADIUS = 2; // janela de 5x5 blocos
const MIN_DYNAMIC_RANGE = 24; // (max - min) abaixo disso = bloco "chapado"
const MAX_LUMA = 255;

/**
 * Converte luminância em matriz binária (`BLACK`/`WHITE`), um byte por pixel.
 *
 * @param {import('./luma.js').Luma} luma
 * @returns {Uint8Array} Matriz binária row-major de `width * height`.
 */
export function binarize(luma) {
  if (luma.width < BLOCK_SIZE || luma.height < BLOCK_SIZE) {
    return binarizeGlobal(luma);
  }

  const columns = blockCount(luma.width);
  const rows = blockCount(luma.height);
  const blackPoints = computeBlackPoints(luma, columns, rows);

  return applyBlackPoints(luma, blackPoints, columns, rows);
}

/**
 * Converte uma matriz binária de volta em luminância (0 ou 255), útil para
 * reenviar ao decodificador uma imagem já "limpa".
 *
 * @param {Uint8Array} binary
 * @param {number} width
 * @param {number} height
 * @returns {import('./luma.js').Luma}
 */
export function binaryToLuma(binary, width, height) {
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    data[i] = binary[i] === BLACK ? 0 : MAX_LUMA;
  }
  return { data, width, height };
}

/** Quantidade de blocos necessária para cobrir `size` pixels. */
function blockCount(size) {
  const whole = size >> BLOCK_SIZE_POWER;
  return (whole << BLOCK_SIZE_POWER) < size ? whole + 1 : whole;
}

/**
 * Deslocamento inicial de um bloco, recuado quando o último bloco extrapolaria
 * a imagem (assim todo bloco tem exatamente 8x8 pixels).
 */
function blockOffset(blockIndex, size) {
  const offset = blockIndex << BLOCK_SIZE_POWER;
  const maxOffset = size - BLOCK_SIZE;
  return offset > maxOffset ? maxOffset : offset;
}

/** Limiar de cada bloco, com herança dos vizinhos em blocos sem contraste. */
function computeBlackPoints({ data, width, height }, columns, rows) {
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
        // Bloco uniforme: assume fundo claro (limiar bem abaixo do mínimo) e,
        // se houver vizinhos já calculados, herda o limiar deles — o que evita
        // "inventar" preto no meio de uma região lisa.
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

/** Aplica, pixel a pixel, o limiar suavizado na vizinhança 5x5 de blocos. */
function applyBlackPoints({ data, width, height }, blackPoints, columns, rows) {
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

/** Caminho de fallback para imagens menores que um bloco: limiar pela média. */
function binarizeGlobal({ data, width, height }) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const threshold = sum / data.length;

  const binary = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    binary[i] = data[i] <= threshold ? BLACK : WHITE;
  }
  return binary;
}

function clamp(value, min, max) {
  if (max < min) return min;
  if (value < min) return min;
  return value > max ? max : value;
}
