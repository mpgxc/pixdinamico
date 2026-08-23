/**
 * Primitivas geométricas compartilhadas pelas etapas de leitura.
 *
 * Sobre a diretiva `'worklet'` espalhada por este diretório: o localizador roda
 * na thread de worklets do VisionCamera, junto do quadro da câmera, para não
 * copiar buffers nem travar a UI. O runtime de worklets só consegue chamar
 * funções marcadas assim. Em Node a diretiva é uma expressão-string inerte —
 * por isso os mesmos arquivos continuam rodando nos testes.
 */

export type Point = { x: number; y: number };

/** Distância euclidiana entre dois pontos. */
export function distance(a: Point, b: Point): number {
  'worklet';
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Vetor unitário de `from` para `to`. Pontos coincidentes devolvem um vetor
 * nulo em vez de `NaN`, para não contaminar o restante do cálculo.
 */
export function unitVector(from: Point, to: Point): Point {
  'worklet';
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return length === 0 ? { x: 0, y: 0 } : { x: dx / length, y: dy / length };
}
