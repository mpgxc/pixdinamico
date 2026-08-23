/**
 * Gerador de símbolos sintéticos para os testes.
 *
 * Não faz parte do app: nada em `src/` importa este arquivo fora dos testes,
 * então ele nunca entra no bundle. Fica aqui, e não numa pasta separada, para
 * ficar ao lado do código que exercita.
 */

const FINDER = 7;
export const QUIET = 4;
const BLACK_LUMA = 25;
const WHITE_LUMA = 235;

/**
 * Símbolo com finder patterns nos três cantos, separadores e miolo em xadrez.
 * Não é um QR válido — é o que o *localizador* enxerga de um QR, que é
 * justamente o que estamos testando.
 */
export function buildSymbol(dimension: number): Uint8Array[] {
  const matrix = Array.from({ length: dimension }, () => new Uint8Array(dimension));

  for (let r = 0; r < dimension; r += 1) {
    for (let c = 0; c < dimension; c += 1) matrix[r][c] = (r + c) % 2 === 0 ? 1 : 0;
  }

  const drawFinder = (r0: number, c0: number) => {
    for (let r = 0; r < FINDER; r += 1) {
      for (let c = 0; c < FINDER; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[r0 + r][c0 + c] = border || center ? 1 : 0;
      }
    }
    for (let k = -1; k <= FINDER; k += 1) {
      const cells: Array<[number, number]> = [
        [r0 - 1, c0 + k], [r0 + FINDER, c0 + k], [r0 + k, c0 - 1], [r0 + k, c0 + FINDER],
      ];
      for (const [r, c] of cells) {
        if (r >= 0 && r < dimension && c >= 0 && c < dimension) matrix[r][c] = 0;
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, dimension - FINDER);
  drawFinder(dimension - FINDER, 0);
  return matrix;
}

export type RenderedPlane = {
  plane: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
};

export type RenderOptions = {
  scale: number;
  angle: number;
  width: number;
  height: number;
  /** Bytes extras por linha, reproduzindo o alinhamento que a câmera aplica. */
  padding: number;
};

/** Rasteriza o símbolo num plano Y, com rotação e alinhamento de linha. */
export function renderPlane(matrix: Uint8Array[], options: RenderOptions): RenderedPlane {
  const { scale, angle, width, height, padding } = options;
  const dimension = matrix.length;
  const bytesPerRow = width + padding;
  const plane = new Uint8Array(bytesPerRow * height).fill(WHITE_LUMA);

  // O padding recebe lixo de propósito: se o código o tratar como pixel, o
  // teste falha em vez de passar por sorte.
  for (let y = 0; y < height; y += 1) {
    for (let x = width; x < bytesPerRow; x += 1) plane[y * bytesPerRow + x] = 0;
  }

  const content = (dimension + 2 * QUIET) * scale;
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sx = dx * cos + dy * sin + content / 2;
      const sy = -dx * sin + dy * cos + content / 2;
      if (sx < 0 || sy < 0 || sx >= content || sy >= content) continue;

      const column = Math.floor(sx / scale) - QUIET;
      const row = Math.floor(sy / scale) - QUIET;
      const dark =
        row >= 0 && row < dimension && column >= 0 && column < dimension &&
        matrix[row][column] === 1;
      plane[y * bytesPerRow + x] = dark ? BLACK_LUMA : WHITE_LUMA;
    }
  }

  return { plane, width, height, bytesPerRow };
}
