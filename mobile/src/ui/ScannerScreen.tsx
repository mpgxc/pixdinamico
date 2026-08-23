/**
 * Tela do leitor.
 *
 * Duas saídas da câmera trabalham no mesmo quadro:
 *
 * - `useObjectOutput` decodifica QR nativamente (Vision no iOS, ML Kit no
 *   Android). É o caminho principal, e o melhor que existe.
 * - `useFrameOutput` roda o localizador em JS na thread de worklets. Ele não
 *   decodifica nada — responde "há um QR aqui, e cada módulo dele ocupa N
 *   pixels do sensor", que é o número de que a aproximação automática precisa.
 *
 * A divisão é o ponto central do app: um decodificador só devolve algo quando
 * consegue ler o símbolo inteiro, então ele não sabe distinguir "não tem QR
 * nenhum" de "tem, mas está pequeno demais". Sem essa distinção, aproximar
 * seria chute — a câmera ficaria dando zoom apontada para o nada.
 */

import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { runOnJS, useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Camera,
  isScannedCode,
  useCameraDevice,
  useFrameOutput,
  useObjectOutput,
} from 'react-native-vision-camera';

import { steerZoom } from '../camera/steer.ts';
import { useAutoZoom } from '../camera/useAutoZoom.ts';
import { locateSymbol } from '../scan/locate.ts';
import type { ZoomEvent } from '../scan/zoom.ts';
import { theme } from './theme.ts';

/**
 * Intervalo mínimo entre análises.
 *
 * O localizador custa ~10ms por passagem; rodar em todo quadro esquentaria o
 * aparelho sem melhorar nada, porque a lente leva mais tempo que isso para
 * responder a um ajuste de zoom.
 */
const ANALYSIS_INTERVAL_MS = 250;

/** Como a análise do último quadro é espelhada para a interface. */
const SEEING = { none: 0, partial: 1, symbol: 2 } as const;

const MESSAGES = {
  [SEEING.none]: 'Aponte para o QR Code.',
  [SEEING.partial]: 'Vejo algo — aproximando…',
  [SEEING.symbol]: 'QR Code encontrado.',
} as const;

export function ScannerScreen() {
  const device = useCameraDevice('back');
  const { zoom, policy, range, level, reset } = useAutoZoom(device);

  const [result, setResult] = useState<string | null>(null);
  const [seeing, setSeeing] = useState<number>(SEEING.none);

  const lastAnalysisAt = useSharedValue(0);
  const seeingShared = useSharedValue<number>(SEEING.none);

  // O decodificador dispara várias vezes com o mesmo código enquanto ele está
  // no quadro; só a primeira leitura interessa.
  const settled = useRef(false);

  const onScanned = useCallback((value: string) => {
    if (settled.current) return;
    settled.current = true;
    setResult(value);
  }, []);

  const objectOutput = useObjectOutput({
    types: ['qr'],
    onObjectsScanned(objects) {
      for (const object of objects) {
        if (isScannedCode(object) && object.value) {
          onScanned(object.value);
          return;
        }
      }
    },
  });

  const frameOutput = useFrameOutput({
    // YUV porque o plano Y *é* a luminância: nada a converter antes de analisar.
    pixelFormat: 'yuv',
    onFrame(frame) {
      'worklet';
      try {
        const now = Date.now();
        if (now - lastAnalysisAt.value < ANALYSIS_INTERVAL_MS) return;
        lastAnalysisAt.value = now;

        // Sem os planos separados não dá para isolar a luminância; melhor não
        // analisar do que analisar bytes que não são o que se espera.
        if (!frame.isPlanar) return;
        const planes = frame.getPlanes();
        if (planes.length === 0) return;

        const y = planes[0];
        const located = locateSymbol(
          new Uint8Array(y.getPixelBuffer()),
          y.width,
          y.height,
          y.bytesPerRow,
        );

        seeingShared.value = SEEING[located.kind];

        const event: ZoomEvent =
          located.kind === 'symbol'
            ? { type: 'located', symbol: located }
            : located.kind === 'partial'
              ? { type: 'partial' }
              : { type: 'missing' };

        steerZoom(policy, zoom, range, event, now);
      } finally {
        // A câmera reaproveita um número fixo de buffers: segurar um quadro
        // trava o pipeline inteiro.
        frame.dispose();
      }
    },
  });

  // O que a análise viu é escrito na thread de worklets; a interface vive na
  // thread de JS, então o valor precisa atravessar.
  useAnimatedReaction(
    () => seeingShared.value,
    (next, previous) => {
      if (next !== previous) runOnJS(setSeeing)(next);
    },
  );

  const scanAgain = useCallback(() => {
    settled.current = false;
    setResult(null);
    setSeeing(SEEING.none);
    reset();
  }, [reset]);

  if (!device) {
    return (
      <Screen>
        <Text style={styles.notice}>Nenhuma câmera disponível neste aparelho.</Text>
      </Screen>
    );
  }

  const scanning = result === null;

  return (
    <View style={styles.root}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={scanning}
        outputs={[objectOutput, frameOutput]}
        zoom={zoom}
        onError={(error) => console.error('Câmera:', error)}
      />

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Text style={styles.status}>
            {scanning ? MESSAGES[seeing as keyof typeof MESSAGES] : 'Lido!'}
          </Text>
          {range === null ? (
            <Text style={styles.hint}>sem zoom</Text>
          ) : (
            level > range.min && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{level.toFixed(1).replace('.', ',')}×</Text>
              </View>
            )
          )}
        </View>

        <Reticle active={seeing === SEEING.symbol} />

        <View style={styles.bottomBar}>
          {result === null ? (
            <Text style={styles.hint}>
              Nada sai do aparelho. A aproximação é automática.
            </Text>
          ) : (
            <>
              <Text style={styles.resultLabel}>Conteúdo lido</Text>
              <Text style={styles.result} numberOfLines={4} selectable>
                {result}
              </Text>
              <Pressable style={styles.button} onPress={scanAgain}>
                <Text style={styles.buttonText}>Ler outro</Text>
              </Pressable>
            </>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

/**
 * Mira central.
 *
 * De propósito não desenhamos o contorno exato do símbolo: converter as
 * coordenadas do quadro para as da tela envolve o recorte do preview e a
 * rotação do sensor, que variam por aparelho. Um contorno desalinhado informa
 * pior que nenhum.
 */
function Reticle({ active }: { active: boolean }) {
  return (
    <View style={styles.reticleArea} pointerEvents="none">
      <View style={[styles.reticle, active && styles.reticleActive]} />
    </View>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={styles.fallback}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.ink,
    padding: 24,
  },
  notice: { color: theme.paper, fontSize: 15, textAlign: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 12,
  },
  status: {
    flex: 1,
    color: theme.paper,
    fontSize: 14,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius,
    backgroundColor: theme.accent,
  },
  badgeText: { color: theme.ink, fontWeight: '800', fontSize: 13 },
  reticleArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  reticle: {
    width: 220,
    height: 220,
    borderWidth: 3,
    borderColor: 'rgba(240,235,224,0.5)',
    borderRadius: 18,
  },
  reticleActive: { borderColor: theme.accent },
  bottomBar: { padding: 20, gap: 10 },
  hint: {
    color: theme.paper,
    opacity: 0.8,
    fontSize: 12,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  resultLabel: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  result: {
    color: theme.paper,
    fontSize: 13,
    backgroundColor: 'rgba(10,31,28,0.75)',
    borderRadius: theme.radius,
    padding: 12,
  },
  button: {
    backgroundColor: theme.accent,
    borderRadius: theme.radius,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { color: theme.ink, fontWeight: '800', fontSize: 15 },
});
