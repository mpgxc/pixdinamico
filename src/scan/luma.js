/**
 * Conversão entre quadros RGBA (o que sai de `getImageData`) e mapas de
 * luminância de 8 bits — o formato usado por todas as etapas de visão
 * computacional deste diretório.
 *
 * Trabalhar em 1 byte por pixel (em vez de 4) reduz em 4x a memória percorrida
 * nos laços de binarização e busca de padrões, que é onde o tempo do scanner
 * realmente vai. O módulo é puro (sem DOM), logo testável no Node.
 */

// Pesos ITU-R BT.601 em ponto fixo: 77 + 150 + 29 = 256, então a divisão vira
// um deslocamento de 8 bits.
const RED_WEIGHT = 77;
const GREEN_WEIGHT = 150;
const BLUE_WEIGHT = 29;
const WEIGHT_SHIFT = 8;

const CHANNELS_PER_PIXEL = 4;
const ALPHA_OPAQUE = 255;

/**
 * @typedef {Object} Luma
 * @property {Uint8Array} data   Um byte por pixel, em ordem row-major.
 * @property {number}     width
 * @property {number}     height
 */

/**
 * Aloca um mapa de luminância vazio (todos os pixels em 0 = preto).
 *
 * @param {number} width
 * @param {number} height
 * @returns {Luma}
 */
export function createLuma(width, height) {
  return { data: new Uint8Array(width * height), width, height };
}

/**
 * Converte um buffer RGBA em luminância.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba Buffer com 4 bytes por pixel.
 * @param {number} width
 * @param {number} height
 * @returns {Luma}
 */
export function toLuma(rgba, width, height) {
  const luma = createLuma(width, height);
  const out = luma.data;

  for (let i = 0, p = 0; i < out.length; i += 1, p += CHANNELS_PER_PIXEL) {
    out[i] =
      (rgba[p] * RED_WEIGHT +
        rgba[p + 1] * GREEN_WEIGHT +
        rgba[p + 2] * BLUE_WEIGHT) >>
      WEIGHT_SHIFT;
  }

  return luma;
}

/**
 * Expande um mapa de luminância de volta para RGBA (cinza opaco), no formato
 * que `ImageData` e os decodificadores esperam.
 *
 * @param {Luma} luma
 * @returns {Uint8ClampedArray} Buffer RGBA de `width * height * 4` bytes.
 */
export function lumaToRgba({ data, width, height }) {
  const rgba = new Uint8ClampedArray(width * height * CHANNELS_PER_PIXEL);

  for (let i = 0, p = 0; i < data.length; i += 1, p += CHANNELS_PER_PIXEL) {
    const value = data[i];
    rgba[p] = value;
    rgba[p + 1] = value;
    rgba[p + 2] = value;
    rgba[p + 3] = ALPHA_OPAQUE;
  }

  return rgba;
}
