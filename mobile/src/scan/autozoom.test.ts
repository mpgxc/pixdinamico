/**
 * Teste do laço fechado: localizar -> decidir o zoom -> aproximar -> repetir.
 *
 * Aproximar a lente multiplica o tamanho aparente do símbolo. Renderizar o
 * mesmo símbolo numa escala maior reproduz exatamente esse efeito sobre a
 * medida do módulo, que é a grandeza que fecha o laço. (Um zoom real também
 * estreita o campo de visão; para um símbolo centralizado, como aqui, isso não
 * muda a medida.)
 *
 * É o teste que responde à pergunta que importa: *a aproximação automática
 * converge, e em quantos passos?* — sem depender de um aparelho.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locateSymbol } from './locate.ts';
import { buildSymbol, renderPlane } from './symbol.fixture.ts';
import {
  ZOOM_TUNING,
  initialZoomState,
  reduceZoom,
  type ZoomEvent,
  type ZoomRange,
  type ZoomState,
} from './zoom.ts';

const FRAME = { width: 1920, height: 1080, padding: 64 };
const RANGE: ZoomRange = { min: 1, max: 10, step: 0 };

/** Um quadro passa pela análise e devolve o próximo estado de zoom. */
function stepLoop(
  matrix: Uint8Array[],
  state: ZoomState,
  baseScale: number,
  angle: number,
  now: number,
): { state: ZoomState; moduleSize: number | null; kind: string } {
  const rendered = renderPlane(matrix, {
    ...FRAME,
    angle,
    scale: baseScale * state.level, // a lente aproximou: o símbolo cresceu
  });

  const located = locateSymbol(
    rendered.plane, rendered.width, rendered.height, rendered.bytesPerRow,
  );

  const event: ZoomEvent =
    located.kind === 'symbol'
      ? { type: 'located', symbol: located }
      : located.kind === 'partial'
        ? { type: 'partial' }
        : { type: 'missing' };

  return {
    state: reduceZoom(state, event, RANGE, now),
    moduleSize: located.kind === 'symbol' ? located.moduleSize : null,
    kind: located.kind,
  };
}

test('o laço aproxima um símbolo pequeno até o tamanho alvo', () => {
  const matrix = buildSymbol(49);
  const baseScale = 3.5; // ~1,75px por módulo na imagem de trabalho: ilegível
  const angle = 0.15;

  let state = initialZoomState(RANGE);
  const trail: Array<{ level: number; moduleSize: number | null; kind: string }> = [];

  for (let i = 0; i < 10; i += 1) {
    const now = i * (ZOOM_TUNING.ADJUST_COOLDOWN_MS + 50);
    const result = stepLoop(matrix, state, baseScale, angle, now);
    trail.push({ level: state.level, moduleSize: result.moduleSize, kind: result.kind });

    // Estabilizou: a política não quer mais mexer.
    if (result.state.level === state.level && trail.length > 1) {
      state = result.state;
      break;
    }
    state = result.state;
  }

  const path = trail
    .map((t) => `${t.level.toFixed(2)}x/${t.kind}/${t.moduleSize?.toFixed(1) ?? '—'}px`)
    .join('  ');

  // O alvo prático não é o valor nominal: a política ignora ajustes menores que
  // MIN_CHANGE_RATIO, então ela para assim que chega perto o bastante. Derivar
  // o limiar dos próprios parâmetros evita um número mágico no teste.
  const settleAt = ZOOM_TUNING.TARGET_MODULE_PIXELS / ZOOM_TUNING.MIN_CHANGE_RATIO;
  const reached = trail.some((t) => t.moduleSize !== null && t.moduleSize >= settleAt);

  assert.ok(reached, `o laço não chegou perto do alvo: ${path}`);
  assert.ok(trail.length <= 4, `demorou ${trail.length} passos: ${path}`);
  assert.ok(state.level <= RANGE.max);
});

test('o laço não mexe no zoom quando o símbolo já está grande', () => {
  const matrix = buildSymbol(49);
  let state = initialZoomState(RANGE);

  for (let i = 0; i < 4; i += 1) {
    const result = stepLoop(matrix, state, 12, 0.15, i * 600);
    state = result.state;
    assert.equal(result.kind, 'symbol', 'o símbolo deveria continuar visível');
  }

  assert.equal(state.level, RANGE.min, 'não havia nada a ganhar aproximando');
});

test('o laço para de aproximar quando o símbolo enche o quadro', () => {
  // Símbolo grande em módulos: alcança o teto de enquadramento antes do alvo de
  // nitidez. Sem essa trava, o zoom passaria do ponto, perderia o símbolo pelas
  // bordas, reabriria o campo e oscilaria.
  const matrix = buildSymbol(177);
  let state = initialZoomState(RANGE);
  let lastModule: number | null = null;

  for (let i = 0; i < 10; i += 1) {
    const result = stepLoop(matrix, state, 6, 0, i * 600);
    state = result.state;
    if (result.moduleSize !== null) lastModule = result.moduleSize;
  }

  const ceiling = (0.8 * FRAME.width) / (177 + 2 * 4);
  assert.ok(lastModule !== null, 'o símbolo deveria continuar localizável');
  assert.ok(
    lastModule <= ceiling * 1.25,
    `módulo ${lastModule.toFixed(1)}px passou do teto de ${ceiling.toFixed(1)}px`,
  );
});
