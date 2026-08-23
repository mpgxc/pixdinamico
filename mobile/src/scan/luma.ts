/**
 * Extração da luminância a partir do quadro da câmera.
 *
 * Aqui está a única vantagem real do nativo sobre o navegador nesta etapa: o
 * quadro já chega em YUV, e o plano Y **é** a luminância. Nada de converter RGBA
 * pixel a pixel — basta ler o primeiro plano, respeitando o alinhamento de
 * linha, e reduzir.
 */

export type Luma = {
  data: Uint8Array;
  width: number;
  height: number;
};

/**
 * Reduz o plano Y para uma imagem de trabalho de no máximo `targetWidth`.
 *
 * A redução é por média de bloco, e não por amostragem simples: pegar 1 pixel a
 * cada N faz as faixas finas do finder pattern (1:1:3:1:1) sumirem por
 * *aliasing* justamente nos símbolos pequenos, que são os que precisam de zoom.
 * A média é limitada a 2x2 amostras por bloco — o grosso do ganho contra
 * aliasing por um custo fixo, em vez de crescer com o quadrado do fator.
 *
 * @param plane      Bytes do plano Y, como vêm da câmera.
 * @param width      Largura do quadro em pixels.
 * @param height     Altura do quadro em pixels.
 * @param bytesPerRow Passo de linha do plano. Costuma ser maior que `width`:
 *   a câmera alinha cada linha, e ignorar isso inclina a imagem inteira.
 * @param targetWidth Largura desejada da imagem de trabalho.
 */
export function yPlaneToLuma(
  plane: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  targetWidth: number,
): Luma {
  'worklet';
  const step = Math.max(1, Math.floor(width / targetWidth));
  const outputWidth = Math.floor(width / step);
  const outputHeight = Math.floor(height / step);
  const data = new Uint8Array(outputWidth * outputHeight);

  if (step === 1) {
    for (let y = 0; y < outputHeight; y += 1) {
      const source = y * bytesPerRow;
      const target = y * outputWidth;
      for (let x = 0; x < outputWidth; x += 1) data[target + x] = plane[source + x];
    }
    return { data, width: outputWidth, height: outputHeight };
  }

  // Segunda amostra a meio bloco: com step 2 cobre o bloco inteiro, e com step
  // maior pega dois pontos bem separados em vez de dois vizinhos.
  const half = step >> 1;

  for (let y = 0; y < outputHeight; y += 1) {
    const topRow = y * step * bytesPerRow;
    const bottomRow = (y * step + half) * bytesPerRow;
    const target = y * outputWidth;

    for (let x = 0; x < outputWidth; x += 1) {
      const left = x * step;
      const right = left + half;
      data[target + x] =
        (plane[topRow + left] +
          plane[topRow + right] +
          plane[bottomRow + left] +
          plane[bottomRow + right]) >>
        2;
    }
  }

  return { data, width: outputWidth, height: outputHeight };
}
