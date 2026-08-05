/**
 * Testes da aproximação automática.
 *
 * A política é pura e a câmera entra por injeção, então dá para exercitar sem
 * navegador: um relógio controlado e um `apply` falso cobrem a espera entre
 * ajustes, a reabertura do campo e a recusa da câmera — casos que num aparelho
 * real dependeriam de sorte para acontecer no momento certo.
 *
 * Executar com: `npm test` (ou `node --test`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ZOOM_TUNING, createZoomController, zoomToReach, zoomToWiden } from '../src/scan/zoom.js';

const RANGE = { min: 1, max: 8, step: 0 };
const ROOMY = 1000; // teto de enquadramento irrelevante para o caso

/** Símbolo com o módulo informado e espaço de sobra no quadro. */
function symbol(moduleSize, maxModuleSize = ROOMY) {
  return { moduleSize, maxModuleSize };
}

/** Controlador com relógio manual e câmera falsa. */
function fakeController(overrides = {}) {
  const applied = [];
  let clock = 0;

  const controller = createZoomController({
    range: RANGE,
    now: () => clock,
    apply: async (value) => {
      applied.push(value);
      return overrides.accept ?? true;
    },
    ...overrides.options,
  });

  return {
    controller,
    applied,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('zoomToReach calcula o fator que leva o módulo ao tamanho alvo', () => {
  // Alvo 8px por módulo: de 4px, o dobro.
  assert.equal(zoomToReach(1, symbol(4), RANGE), 2);
  // Já aproximado 2x, um módulo de 4px pede o dobro de novo — limitado ao teto.
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
  // 6px -> 1,33x já passa do mínimo.
  assert.ok(zoomToReach(1, symbol(6), RANGE) > 1);
});

test('zoomToReach aproxima em degraus, sem saltar para o valor ideal', () => {
  // 1px por módulo pediria 8x de uma vez; o passo é limitado ao dobro.
  assert.equal(zoomToReach(1, symbol(1), RANGE), ZOOM_TUNING.MAX_STEP_RATIO);
});

test('zoomToReach respeita o limite do que a câmera aceita', () => {
  assert.equal(zoomToReach(6, symbol(1), { min: 1, max: 8, step: 0 }), 8);
  assert.equal(zoomToReach(8, symbol(1), { min: 1, max: 8, step: 0 }), null, 'já no máximo');
});

test('zoomToReach não aproxima além do que cabe no quadro', () => {
  // Símbolo grande (muitos módulos): a 6px por módulo ele já ocupa o quadro
  // inteiro, então o teto de enquadramento manda mais que o alvo de nitidez.
  assert.equal(zoomToReach(1, symbol(4), RANGE), 2, 'sem teto, mira os 8px do alvo');
  assert.equal(zoomToReach(1, symbol(4, 6), RANGE), 1.5, 'com teto, para nos 6px que cabem');

  assert.equal(zoomToReach(1, symbol(5.5, 6), RANGE), null, 'ganho de 1,09x não compensa');
  assert.equal(zoomToReach(1, symbol(7, 6), RANGE), null, 'já passou do que cabe');
});

test('zoomToReach encaixa o valor no passo da câmera', () => {
  const stepped = { min: 1, max: 5, step: 0.5 };
  // 8/4,4 = 1,818... -> encaixa em 2,0 (múltiplo de 0,5 mais próximo).
  assert.equal(zoomToReach(1, symbol(4.4), stepped), 2);
  const value = zoomToReach(1, symbol(3), stepped);
  assert.equal((value - stepped.min) % stepped.step, 0, `${value} não é múltiplo do passo`);
});

test('zoomToWiden reabre o campo até o mínimo, sem ultrapassá-lo', () => {
  assert.equal(zoomToWiden(4, RANGE), 2.5);
  assert.equal(zoomToWiden(1.2, RANGE), 1, 'não passa do mínimo');
  assert.equal(zoomToWiden(1, RANGE), null, 'já totalmente aberto');
  assert.equal(zoomToWiden(4, null), null, 'câmera sem zoom');
});

test('o controlador aproxima quando o símbolo é localizado e não lido', async () => {
  const { controller, applied } = fakeController();

  assert.equal(await controller.onLocated(symbol(4)), true);
  assert.deepEqual(applied, [2]);
  assert.equal(controller.level, 2);
});

test('o controlador espera entre dois ajustes', async () => {
  const { controller, applied, advance } = fakeController();

  await controller.onLocated(symbol(4));
  assert.equal(await controller.onLocated(symbol(4)), false, 'ajuste imediato é recusado');
  assert.deepEqual(applied, [2]);

  advance(ZOOM_TUNING.ADJUST_COOLDOWN_MS);
  assert.equal(await controller.onLocated(symbol(4)), true);
  assert.deepEqual(applied, [2, 4]);
});

test('o controlador só reabre o campo depois de um tempo sem localizar nada', async () => {
  const { controller, applied, advance } = fakeController();

  await controller.onLocated(symbol(2)); // vai a 2x
  advance(ZOOM_TUNING.ADJUST_COOLDOWN_MS);

  assert.equal(await controller.onMissed(), false, 'um quadro vazio não reabre nada');
  advance(ZOOM_TUNING.WIDEN_AFTER_MS - 1);
  assert.equal(await controller.onMissed(), false, 'ainda dentro da janela de tolerância');

  advance(2);
  assert.equal(await controller.onMissed(), true);
  assert.ok(controller.level < 2, `esperava recuo, ficou em ${controller.level}`);
  assert.equal(applied.length, 2);
});

test('localizar de novo cancela a contagem para reabrir o campo', async () => {
  const { controller, advance } = fakeController();

  await controller.onLocated(symbol(2));
  advance(ZOOM_TUNING.WIDEN_AFTER_MS);

  // O símbolo reaparece já no tamanho bom: nada a ajustar, mas a contagem zera.
  await controller.onLocated(symbol(10));
  advance(ZOOM_TUNING.WIDEN_AFTER_MS - 1);
  assert.equal(await controller.onMissed(), false);
  assert.equal(controller.level, 2, 'o campo não deveria ter reaberto');
});

test('nada acontece quando a câmera não tem zoom', async () => {
  const applied = [];
  const controller = createZoomController({
    range: null,
    apply: async (value) => {
      applied.push(value);
      return true;
    },
  });

  assert.equal(controller.supported, false);
  assert.equal(await controller.onLocated(symbol(1)), false);
  assert.equal(await controller.onMissed(), false);
  assert.deepEqual(applied, [], 'a câmera não deveria ser tocada');
});

test('o nível não avança quando a câmera recusa a mudança', async () => {
  const { controller, applied } = fakeController({ accept: false });

  assert.equal(await controller.onLocated(symbol(4)), false);
  assert.deepEqual(applied, [2], 'tentou aplicar');
  assert.equal(controller.level, 1, 'mas o nível continua o mesmo');
});

test('o controlador parte do zoom em que a câmera já estava', async () => {
  const { controller } = fakeController({ options: { initial: 3 } });
  assert.equal(controller.level, 3);

  const outOfRange = createZoomController({ range: RANGE, initial: 99, apply: async () => true });
  assert.equal(outOfRange.level, RANGE.max, 'valor fora da faixa é encaixado');
});
