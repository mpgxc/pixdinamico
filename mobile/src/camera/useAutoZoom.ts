/**
 * Estado da aproximação automática para uma sessão de câmera.
 *
 * Guarda o nível de zoom e o estado da política em `SharedValue`s — acessíveis
 * tanto pela thread de worklets (onde os quadros são analisados) quanto pela de
 * JS (onde a interface vive) — e espelha o nível para o React, para a interface
 * conseguir mostrá-lo.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAnimatedReaction, useSharedValue, runOnJS } from 'react-native-reanimated';
import type { CameraDevice } from 'react-native-vision-camera';

import { initialZoomState, type ZoomRange, type ZoomState } from '../scan/zoom.ts';

export type AutoZoom = {
  /** Nível de zoom, para a prop `zoom` da `<Camera />`. */
  zoom: ReturnType<typeof useSharedValue<number>>;
  /** Estado da política, lido e escrito dentro do frame processor. */
  policy: ReturnType<typeof useSharedValue<ZoomState>>;
  /** Faixa aceita pelo aparelho; `null` quando não há zoom controlável. */
  range: ZoomRange | null;
  /** Nível atual espelhado para o React, para a interface exibir. */
  level: number;
  /** Volta ao campo aberto — usado ao recomeçar uma leitura. */
  reset: () => void;
};

/**
 * @param device A câmera escolhida, ou `undefined` enquanto ela é resolvida.
 */
export function useAutoZoom(device: CameraDevice | undefined): AutoZoom {
  // Um aparelho sem zoom controlável (ou uma faixa degenerada) simplesmente não
  // tem aproximação automática: tudo o mais continua funcionando.
  const range: ZoomRange | null =
    device && device.maxZoom > device.minZoom
      ? { min: device.minZoom, max: device.maxZoom, step: 0 }
      : null;

  const minimum = range ? range.min : 1;

  const zoom = useSharedValue(minimum);
  const policy = useSharedValue<ZoomState>(initialZoomState(range));
  const [level, setLevel] = useState(minimum);

  // A câmera só é conhecida depois do primeiro render; quando ela chega (ou
  // troca), o estado precisa nascer de novo com a faixa certa.
  useEffect(() => {
    zoom.value = minimum;
    policy.value = initialZoomState(range);
    setLevel(minimum);
    // `range` é recriado a cada render; os limites é que importam.
  }, [minimum, range?.max]); // eslint-disable-line react-hooks/exhaustive-deps

  // O nível muda dentro do worklet; a interface vive na thread de JS.
  useAnimatedReaction(
    () => policy.value.level,
    (next, previous) => {
      if (next !== previous) runOnJS(setLevel)(next);
    },
  );

  const reset = useCallback(() => {
    zoom.value = minimum;
    policy.value = initialZoomState(range);
    setLevel(minimum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimum, range?.max]);

  return { zoom, policy, range, level, reset };
}
