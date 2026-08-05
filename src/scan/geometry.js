/**
 * Primitivas geométricas compartilhadas pelas etapas de leitura.
 *
 * Ficam num módulo próprio para que `finder` e `quad` possam usá-las sem
 * dependência circular entre eles.
 */

/** @typedef {{ x: number, y: number }} Point */

/**
 * Distância euclidiana entre dois pontos.
 *
 * @param {Point} a
 * @param {Point} b
 * @returns {number}
 */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Vetor unitário de `from` para `to`. Pontos coincidentes devolvem um vetor
 * nulo em vez de `NaN`, para não contaminar o restante do cálculo.
 *
 * @param {Point} from
 * @param {Point} to
 * @returns {Point}
 */
export function unitVector(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return length === 0 ? { x: 0, y: 0 } : { x: dx / length, y: dy / length };
}

/**
 * Centro geométrico de um conjunto de pontos.
 *
 * @param {Point[]} points
 * @returns {Point}
 */
export function centroid(points) {
  const sum = points.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}
