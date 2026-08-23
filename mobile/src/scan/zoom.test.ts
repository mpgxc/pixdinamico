/**
 * Testes da política de aproximação automática.
 *
 * O redutor é puro, então a máquina inteira é exercitada aqui: espera entre
 * ajustes, reabertura do campo por tempo e teto de enquadramento — casos que
 * num aparelho real dependeriam de sorte para acontecer no momento certo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZOOM_TUNING,
  initialZoomState,
  reduceZoom,
  zoomToExplore,
  zoomToReach,
  zoomToWiden,
  type SymbolMetrics,
  type ZoomEvent,
  type ZoomRange,
  type ZoomState,
} from './zoom.ts';

const RANGE: ZoomRange = { min: 1, max: 8, step: 0 };
const ROOMY = 1000; // teto de enquadramento irrelevante para o caso

function symbol(moduleSize: number, maxModuleSize = ROOMY): SymbolMetrics {
  return { moduleSize, maxModuleSize };
}

/** Encadeia eventos num relógio explícito e devolve o estado final. */
function run(
  steps: Array<{ at: number; event: ZoomEvent }>,
  range: ZoomRange | null = RANGE,
): ZoomState {
  let state = initialZoomState(range);
  for (const step of steps) state = reduceZoom(state, step.event, range, step.at);
  return state;
}

const located = (moduleSize: number, max = ROOMY): ZoomEvent => ({
  type: 'located',
  symbol: symbol(moduleSize, max),
});
const missing: ZoomEvent = { type: 'missing' };
const partial: ZoomEvent = { type: 'partial' };

test('zoomToReach calcula o fator que leva o módulo ao tamanho alvo', () => {
  assert.equal(zoomToReach(1, symbol(4), RANGE), 2);
  assert.equal(zoomToReach(2, symbol(4), RANGE), 4);
});

test('zoomToReach não mexe no zoom quando não há o que ganhar', () => {
  assert.equal(zoomToReach(1, symbol(ZOOM_TUNING.TARGET_MODULE_PIXELS), RANGE), null);
  assert.equal(zoomToReach(1, symbol(12), RANGE), null, 'módulo acima do alvo');
  assert.equal(zoomToReach(1, symbol(0), RANGE), null, 'medida inválida');
  assert.equal(zoomToReach(1, symbol(4), null), null, 'câmera sem zoom');
});

test('zoomToReach ignora ajustes pequenos demais para valer a sacudida', () => {
  // 7,5px -> alvo 8px pede só 1,07x, abaixo do mínimo de 1,15x.
  assert.equal(zoomToReach(1, symbol(7.5), RANGE), null);
  assert.ok((zoomToReach(1, symbol(6), RANGE) ?? 0) > 1);
});

test('zoomToReach aproxima em degraus, sem saltar para o valor ideal', () => {
  // 1px por módulo pediria 8x de uma vez; o passo é limitado ao dobro.
  assert.equal(zoomToReach(1, symbol(1), RANGE), ZOOM_TUNING.MAX_STEP_RATIO);
});

test('zoomToReach respeita o limite do que a câmera aceita', () => {
  assert.equal(zoomToReach(6, symbol(1), RANGE), 8);
  assert.equal(zoomToReach(8, symbol(1), RANGE), null, 'já no máximo');
});

test('zoomToReach não aproxima além do que cabe no quadro', () => {
  assert.equal(zoomToReach(1, symbol(4), RANGE), 2, 'sem teto, mira os 8px do alvo');
  assert.equal(zoomToReach(1, symbol(4, 6), RANGE), 1.5, 'com teto, para nos 6px que cabem');
  assert.equal(zoomToReach(1, symbol(5.5, 6), RANGE), null, 'ganho de 1,09x não compensa');
  assert.equal(zoomToReach(1, symbol(7, 6), RANGE), null, 'já passou do que cabe');
});

test('zoomToReach encaixa o valor no passo da câmera', () => {
  const stepped: ZoomRange = { min: 1, max: 5, step: 0.5 };
  // 8/4,4 = 1,818... -> encaixa em 2,0.
  assert.equal(zoomToReach(1, symbol(4.4), stepped), 2);
  const value = zoomToReach(1, symbol(3), stepped) ?? 0;
  assert.equal((value - stepped.min) % stepped.step, 0, `${value} não é múltiplo do passo`);
});

test('zoomToWiden reabre o campo até o mínimo, sem ultrapassá-lo', () => {
  assert.equal(zoomToWiden(4, RANGE), 2.5);
  assert.equal(zoomToWiden(1.2, RANGE), 1, 'não passa do mínimo');
  assert.equal(zoomToWiden(1, RANGE), null, 'já totalmente aberto');
  assert.equal(zoomToWiden(4, null), null, 'câmera sem zoom');
});

test('o redutor aproxima quando o símbolo é localizado e não lido', () => {
  const state = run([{ at: 0, event: located(4) }]);
  assert.equal(state.level, 2);
});

test('o redutor espera entre dois ajustes', () => {
  const tooSoon = run([
    { at: 0, event: located(4) },
    { at: ZOOM_TUNING.ADJUST_COOLDOWN_MS - 1, event: located(4) },
  ]);
  assert.equal(tooSoon.level, 2, 'o segundo ajuste é recusado');

  const allowed = run([
    { at: 0, event: located(4) },
    { at: ZOOM_TUNING.ADJUST_COOLDOWN_MS, event: located(4) },
  ]);
  assert.equal(allowed.level, 4);
});

test('o redutor só reabre o campo depois de um tempo sem localizar nada', () => {
  const base = [
    { at: 0, event: located(2) },
    { at: ZOOM_TUNING.ADJUST_COOLDOWN_MS, event: missing },
  ];

  const early = run([
    ...base,
    { at: ZOOM_TUNING.ADJUST_COOLDOWN_MS + ZOOM_TUNING.WIDEN_AFTER_MS - 1, event: missing },
  ]);
  assert.equal(early.level, 2, 'ainda dentro da janela de tolerância');

  const late = run([
    ...base,
    { at: ZOOM_TUNING.ADJUST_COOLDOWN_MS + ZOOM_TUNING.WIDEN_AFTER_MS + 1, event: missing },
  ]);
  assert.ok(late.level < 2, `esperava recuo, ficou em ${late.level}`);
});

test('localizar de novo cancela a contagem para reabrir o campo', () => {
  const state = run([
    { at: 0, event: located(2) },
    { at: 600, event: missing },
    // O símbolo reaparece já no tamanho bom: nada a ajustar, mas a contagem zera.
    { at: 1800, event: located(10) },
    { at: 3000, event: missing },
  ]);
  assert.equal(state.level, 2, 'o campo não deveria ter reaberto');
});

test('nada acontece quando a câmera não tem zoom', () => {
  const state = run(
    [
      { at: 0, event: located(1) },
      { at: 5000, event: missing },
    ],
    null,
  );
  assert.equal(state.level, 1);
});

test('o campo reabre em degraus sucessivos, não de uma vez', () => {
  let state = initialZoomState(RANGE);
  state = reduceZoom(state, located(1), RANGE, 0); // 1 -> 2
  state = reduceZoom(state, located(1), RANGE, 600); // 2 -> 4
  assert.equal(state.level, 4);

  const levels: number[] = [];
  for (let i = 1; i <= 6; i += 1) {
    state = reduceZoom(state, missing, RANGE, 600 + i * (ZOOM_TUNING.WIDEN_AFTER_MS + 100));
    levels.push(state.level);
  }

  // O primeiro quadro vazio só arma o relógio: recuar já nele ignoraria a
  // janela de tolerância e reabriria o campo a cada piscada da detecção.
  assert.equal(levels[0], 4, 'o primeiro quadro vazio não mexe no zoom');
  assert.ok(levels[1] < 4 && levels[1] > RANGE.min, `recuo parcial: ${levels[1]}`);
  assert.ok(
    levels.every((level, i) => i === 0 || level <= levels[i - 1]),
    `os níveis deveriam só cair: ${levels.join(' -> ')}`,
  );
  assert.equal(levels[levels.length - 1], RANGE.min, 'termina com o campo aberto');
});

test('zoomToExplore sobe em degraus fixos até o teto de exploração', () => {
  assert.equal(zoomToExplore(1, RANGE), 1.6);
  assert.equal(zoomToExplore(1.6, RANGE), 2.56);

  // Teto = mínimo x EXPLORE_MAX_FACTOR. Sem medida do símbolo não há como saber
  // quanto falta, e além disso enquadrar num campo estreito vira sorte.
  const ceiling = RANGE.min * ZOOM_TUNING.EXPLORE_MAX_FACTOR;
  assert.equal(zoomToExplore(3, RANGE), ceiling, 'o último degrau para no teto');
  assert.equal(zoomToExplore(ceiling, RANGE), null, 'no teto, para de explorar');
  assert.equal(zoomToExplore(1, null), null, 'câmera sem zoom');
});

test('zoomToExplore nunca passa do máximo da câmera', () => {
  const shallow: ZoomRange = { min: 1, max: 1.5, step: 0 };
  assert.equal(zoomToExplore(1, shallow), 1.5);
  assert.equal(zoomToExplore(1.5, shallow), null);
});

test('detecção parcial aproxima sem medida, e a medida assume quando chega', () => {
  // Há um QR na cena pequeno demais para medir: explora em degraus.
  let state = initialZoomState(RANGE);
  state = reduceZoom(state, partial, RANGE, 0);
  assert.equal(state.level, 1.6, 'o degrau exploratório tira o laço do lugar');

  state = reduceZoom(state, partial, RANGE, 600);
  assert.equal(state.level, 2.56);

  // Agora o símbolo foi confirmado: o cálculo exato substitui a exploração.
  state = reduceZoom(state, located(4), RANGE, 1200);
  assert.equal(state.level, 5.12, 'passa a usar a medida (2,56 x 8/4)');
});

test('detecção parcial cancela a contagem para reabrir o campo', () => {
  const state = run([
    { at: 0, event: located(2) },
    { at: 600, event: missing },
    { at: 1800, event: partial },
    { at: 2000, event: missing },
  ]);
  assert.equal(state.missingSince, 2000, 'a contagem recomeça do zero');
});
