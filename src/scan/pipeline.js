/**
 * Orquestra a leitura de um QR Code a partir do vídeo da câmera.
 *
 * O fluxo, por quadro:
 *
 *   1. **Quadro reduzido** — o vídeo é desenhado num canvas de trabalho
 *      estreito. Varrer 640px em vez de 1920px corta o custo em ~9x e é o que
 *      permite analisar todo quadro sem derrubar o FPS.
 *   2. **Tentativa direta** — decodifica o quadro inteiro. QR grande e bem
 *      enquadrado resolve aqui, em milissegundos, e o resto nem roda.
 *   3. **Localização** — falhando a leitura, binariza e procura os três finder
 *      patterns. Isso responde "tem um QR aí?" sem precisar decodificar nada.
 *   4. **Snapshot** — achado o símbolo, o quadro é capturado de novo, agora em
 *      resolução cheia: é dele que sai o detalhe que o quadro reduzido perdeu.
 *   5. **Recorte + upscale** — o quadrilátero do símbolo é projetado sobre um
 *      quadrado grande o bastante para dar ~6px por módulo, corrigindo a
 *      perspectiva no mesmo passo.
 *   6. **Decodificação do recorte** — agora sobre uma imagem pequena, reta e
 *      com resolução de sobra. Se ainda falhar, repete uma vez com o recorte
 *      binarizado.
 *
 * O passo 3 é o que separa "não tem QR na cena" de "tem, mas não deu para ler",
 * e é essa distinção que faz valer o recorte: sem ela, ampliar seria chute.
 *
 * O passo 3 também é o que alimenta a aproximação automática (ver `zoom`): ao
 * localizar sem conseguir ler, o pipeline devolve o tamanho do módulo em pixels
 * do sensor, e é com esse número que se calcula de quanto aproximar. O recorte
 * espalha os pixels que já existem; o zoom é o único passo que traz pixels
 * novos, e por isso é a saída quando nem o recorte resolve.
 */

import { binarize, binaryToLuma } from './binarize.js';
import { decodeImageData } from './decoder.js';
import { findFinderPatterns, measureModuleSize, selectFinderTriple } from './finder.js';
import { lumaToRgba, toLuma } from './luma.js';
import { estimateSymbolQuad, expandQuad, scaleQuad } from './quad.js';
import { cropSizeFor, warpToSquare } from './warp.js';

/** Largura do quadro de trabalho usado na varredura. */
const SCAN_FRAME_WIDTH = 640;

/**
 * Largura da segunda tentativa de localização.
 *
 * A assinatura 1:1:3:1:1 precisa de uns 3 pixels por módulo para sobreviver à
 * redução; abaixo disso o *aliasing* come as faixas finas e o símbolo some do
 * quadro de trabalho mesmo estando nítido na imagem original. Repetir a busca
 * num quadro maior custa ~6ms e só acontece quando a primeira passagem não
 * achou nada.
 *
 * Não vamos além disso de propósito: buscar em resolução cheia acharia
 * símbolos ainda menores (abaixo de ~3px por módulo na imagem original), mas
 * custaria ~35ms a cada passagem *enquanto não há nada na cena* — caro demais
 * para o caso comum, que é a câmera apontada para lugar nenhum. Nesse regime a
 * saída certa é o usuário aproximar o aparelho, e a interface já pede isso.
 */
const LOCATE_ESCALATED_WIDTH = 960;

/** Teto da resolução do snapshot (acima disso o ganho não paga o custo). */
const SNAPSHOT_MAX_WIDTH = 1600;

/** Resolução alvo do recorte: pixels por módulo do QR. */
const PIXELS_PER_MODULE = 6;
const MIN_CROP_SIZE = 256;
const MAX_CROP_SIZE = 1024;

/**
 * Folga aplicada ao recorte. Entre localizar (passo 3) e capturar (passo 4)
 * passa-se um quadro, e a mão treme: sem margem, o símbolo sai cortado.
 */
const CROP_SAFETY_MARGIN = 1.06;

/** Intervalo mínimo entre execuções do caminho pesado (passos 3 a 6). */
const LOCATE_INTERVAL_MS = 220;

/**
 * Fração da largura do quadro que o símbolo pode ocupar. Serve de teto para a
 * aproximação automática: passar disso é perder o símbolo pelas bordas assim
 * que a mão tremer.
 */
const MAX_FRAME_FILL = 0.8;

/**
 * @typedef {Object} ScanResult
 * @property {'no-frame'|'searching'|'located'|'decoded'} status
 *   `searching`: nenhum QR na cena. `located`: símbolo encontrado, mas ainda
 *   não decodificado. `decoded`: leitura concluída.
 * @property {string}      [text]     Conteúdo lido (só em `decoded`).
 * @property {'frame'|'crop'} [via]   Etapa que conseguiu decodificar.
 * @property {import('./geometry.js').Point[]} [corners]
 *   Cantos do símbolo em coordenadas do quadro reduzido, para destaque na tela.
 * @property {ImageData}   [crop]     Recorte ampliado que foi decodificado.
 * @property {{width: number, height: number}} [frame] Dimensões do quadro reduzido.
 * @property {import('./zoom.js').SymbolMetrics} [symbol]
 *   Tamanho do módulo e teto de ampliação, em pixels do vídeo original. Só vem
 *   quando o símbolo foi localizado — é o que a aproximação automática usa para
 *   calcular de quanto precisa aproximar, em vez de tatear.
 */

/**
 * Cria o pipeline de leitura. Os canvases são reaproveitados entre quadros —
 * alocar um canvas por frame é o caminho mais curto para o coletor de lixo
 * engasgar no meio da leitura.
 *
 * @returns {{ scan: (video: HTMLVideoElement) => Promise<ScanResult>, reset: () => void }}
 */
export function createQrPipeline() {
  const scanCanvas = createCanvas();
  const locateCanvas = createCanvas();
  const snapshotCanvas = createCanvas();

  let lastLocateAt = Number.NEGATIVE_INFINITY;
  let lastCorners = null;

  /**
   * Analisa o quadro atual do vídeo.
   *
   * @param {HTMLVideoElement} video
   * @returns {Promise<ScanResult>}
   */
  async function scan(video) {
    if (!video.videoWidth || !video.videoHeight) return { status: 'no-frame' };

    const frame = grabFrame(video, scanCanvas, SCAN_FRAME_WIDTH);
    const frameSize = { width: frame.width, height: frame.height };

    // Passo 2: tentativa direta sobre o quadro inteiro.
    const direct = await decodeImageData(frame.imageData);
    if (direct) {
      lastCorners = direct.corners;
      return {
        status: 'decoded',
        via: 'frame',
        text: direct.text,
        corners: direct.corners ?? undefined,
        frame: frameSize,
      };
    }

    // O caminho pesado é limitado por tempo: entre uma execução e outra
    // devolvemos o último destaque conhecido, o que mantém o overlay estável
    // sem gastar CPU.
    const now = timestamp();
    if (now - lastLocateAt < LOCATE_INTERVAL_MS) {
      return {
        status: lastCorners ? 'located' : 'searching',
        corners: lastCorners ?? undefined,
        frame: frameSize,
      };
    }
    lastLocateAt = now;

    // Passo 3: localizar os finder patterns.
    const located = locate(video, frame);
    if (!located) {
      lastCorners = null;
      return { status: 'searching', frame: frameSize };
    }

    const { quad, width: locatedWidth, height: locatedHeight } = located;

    // O destaque é sempre devolvido nas coordenadas do quadro reduzido, para
    // que a interface tenha um único sistema de referência.
    const corners = cornersOf(
      scaleQuad(quad, frame.width / locatedWidth, frame.height / locatedHeight),
    );
    lastCorners = corners;

    const symbol = symbolMetrics(video, quad, locatedWidth);

    // Passos 4 e 5: snapshot em resolução cheia, recorte, endireitamento e upscale.
    const snapshot = grabFrame(video, snapshotCanvas, Math.min(video.videoWidth, SNAPSHOT_MAX_WIDTH));
    const snapshotQuad = expandQuad(
      scaleQuad(quad, snapshot.width / locatedWidth, snapshot.height / locatedHeight),
      CROP_SAFETY_MARGIN,
    );
    const cropSize = cropSizeFor(quad.sampledModules, {
      pixelsPerModule: PIXELS_PER_MODULE,
      min: MIN_CROP_SIZE,
      max: MAX_CROP_SIZE,
    });
    const crop = warpToSquare(
      toLuma(snapshot.imageData.data, snapshot.width, snapshot.height),
      snapshotQuad,
      cropSize,
    );
    const cropImage = toImageData(crop);

    // Passo 6: decodificar o recorte; se falhar, insistir com ele binarizado.
    let decoded = await decodeImageData(cropImage, { tryInverted: true });
    if (!decoded) {
      const hardened = binaryToLuma(binarize(crop), cropSize, cropSize);
      decoded = await decodeImageData(toImageData(hardened), { tryInverted: true });
    }

    return decoded
      ? {
          status: 'decoded',
          via: 'crop',
          text: decoded.text,
          corners,
          crop: cropImage,
          frame: frameSize,
        }
      : { status: 'located', corners, crop: cropImage, frame: frameSize, symbol };
  }

  /**
   * Procura o símbolo no quadro reduzido e, se não achar, repete num quadro
   * maior. Devolve o quadrilátero junto das dimensões em que foi medido, já
   * que o passo seguinte precisa reprojetá-lo para o snapshot.
   */
  function locate(video, frame) {
    const inFrame = locateIn(frame);
    if (inFrame) return { quad: inFrame, width: frame.width, height: frame.height };

    if (video.videoWidth <= SCAN_FRAME_WIDTH) return null;

    const bigger = grabFrame(video, locateCanvas, LOCATE_ESCALATED_WIDTH);
    const inBigger = locateIn(bigger);
    return inBigger ? { quad: inBigger, width: bigger.width, height: bigger.height } : null;
  }

  /** Esquece o estado entre sessões de leitura. */
  function reset() {
    lastLocateAt = Number.NEGATIVE_INFINITY;
    lastCorners = null;
  }

  return { scan, reset };
}

/** Binariza, acha os três finder patterns e monta o quadrilátero do símbolo. */
function locateIn({ imageData, width, height }) {
  const binary = binarize(toLuma(imageData.data, width, height));
  const patterns = selectFinderTriple(findFinderPatterns(binary, width, height));
  if (!patterns) return null;

  return estimateSymbolQuad(patterns, {
    measuredModuleSize: measureModuleSize(binary, width, height, patterns),
  });
}

function cornersOf(quad) {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
}

/**
 * Traduz as medidas do símbolo para pixels do vídeo original — a unidade em que
 * o zoom opera, já que aproximar multiplica igualmente tudo o que o sensor vê.
 */
function symbolMetrics(video, quad, locatedWidth) {
  const toSource = video.videoWidth / locatedWidth;

  return {
    moduleSize: quad.moduleSize * toSource,
    maxModuleSize: (MAX_FRAME_FILL * video.videoWidth) / quad.sampledModules,
  };
}

/**
 * Desenha o quadro atual do vídeo num canvas, reduzindo para `maxWidth` e
 * preservando a proporção.
 */
function grabFrame(video, canvas, maxWidth) {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(video, 0, 0, width, height);

  return { imageData: context.getImageData(0, 0, width, height), width, height };
}

function toImageData(luma) {
  return new ImageData(lumaToRgba(luma), luma.width, luma.height);
}

function createCanvas() {
  return document.createElement('canvas');
}

function timestamp() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
