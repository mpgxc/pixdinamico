/**
 * Ponte entre a política de zoom e a câmera.
 *
 * Roda na thread de worklets, dentro do frame processor. O estado da política
 * vive em `SharedValue`s porque closures de worklet são capturadas por valor a
 * cada quadro — qualquer estado guardado dentro delas se perderia entre um
 * quadro e o seguinte.
 */

import { withTiming, type SharedValue } from 'react-native-reanimated';

import { reduceZoom, type ZoomEvent, type ZoomRange, type ZoomState } from '../scan/zoom.ts';

/**
 * Duração da transição de zoom.
 *
 * Um salto seco embaralha a imagem no exato momento em que o decodificador
 * mais precisa de estabilidade, e a lente física leva tempo para acompanhar de
 * qualquer forma. Animar aproxima o que a tela mostra do que o sensor entrega.
 */
export const ZOOM_ANIMATION_MS = 220;

/**
 * Aplica um evento de análise à política e, se o nível mudar, move a câmera.
 *
 * @param policy Estado da política (persistido entre quadros).
 * @param zoom   Nível entregue à `<Camera zoom={...} />`.
 * @param range  Faixa aceita pelo aparelho, ou `null` se não houver zoom.
 * @param event  O que a análise deste quadro concluiu.
 * @param now    Relógio, em milissegundos.
 * @returns `true` quando o zoom mudou.
 */
export function steerZoom(
  policy: SharedValue<ZoomState>,
  zoom: SharedValue<number>,
  range: ZoomRange | null,
  event: ZoomEvent,
  now: number,
): boolean {
  'worklet';
  const current = policy.value;
  const next = reduceZoom(current, event, range, now);
  policy.value = next;

  if (next.level === current.level) return false;

  zoom.value = withTiming(next.level, { duration: ZOOM_ANIMATION_MS });
  return true;
}
