/**
 * Adapter dos decodificadores de QR Code.
 *
 * A estratégia é a mesma do `qr-renderer`: isolar a dependência externa num
 * único arquivo. Aqui existem dois caminhos:
 *
 * 1. `BarcodeDetector`, a API nativa do navegador. É a melhor opção quando
 *    existe — decodifica fora da thread principal, com implementação nativa
 *    (ZXing no Chrome/Android, Vision no Safari). Disponível no Chrome/Edge,
 *    no Safari 17+ e no WebView do Android.
 * 2. `jsQR`, carregado sob demanda por `import()` dinâmico. Cobre o Firefox e
 *    versões antigas do Safari, e serve de rede de segurança para os casos em
 *    que a API nativa existe mas devolve resultado vazio (acontece em algumas
 *    builds de Linux/Chromium, onde o formato é anunciado mas não implementado).
 *
 * O import dinâmico mantém a promessa do projeto de não ter build: o módulo só
 * é buscado se e quando o caminho de fallback for realmente necessário.
 */

const QR_FORMAT = 'qr_code';

// Duas CDNs: se a primeira estiver bloqueada (rede corporativa, extensão), a
// segunda ainda entrega o fallback.
const JSQR_SOURCES = [
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm',
  'https://esm.sh/jsqr@1.4.0',
];

/**
 * @typedef {Object} DecodedQr
 * @property {string} text                    Conteúdo lido.
 * @property {import('./geometry.js').Point[]|null} corners
 *   Os quatro cantos do símbolo em coordenadas da imagem analisada, quando o
 *   decodificador os informa (serve só para desenhar o destaque na tela).
 */

let nativeDetectorPromise = null;
let jsQrPromise = null;

/**
 * Tenta decodificar um QR Code numa imagem já rasterizada.
 *
 * @param {ImageData} imageData
 * @param {{ tryInverted?: boolean }} [options]
 *   `tryInverted` também testa a imagem com as cores invertidas (QR claro sobre
 *   fundo escuro). Custa uma segunda passagem, então fica desligado no caminho
 *   rápido e ligado no recorte.
 * @returns {Promise<DecodedQr|null>} `null` quando nada foi lido.
 */
export async function decodeImageData(imageData, { tryInverted = false } = {}) {
  const native = await decodeWithNative(imageData);
  if (native) return native;

  return decodeWithJsQr(imageData, tryInverted);
}

/** Instancia (uma única vez) o detector nativo, se o formato for suportado. */
function getNativeDetector() {
  if (nativeDetectorPromise) return nativeDetectorPromise;

  nativeDetectorPromise = (async () => {
    const BarcodeDetector = globalThis.BarcodeDetector;
    if (typeof BarcodeDetector !== 'function') return null;

    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes(QR_FORMAT)) return null;
      return new BarcodeDetector({ formats: [QR_FORMAT] });
    } catch {
      return null;
    }
  })();

  return nativeDetectorPromise;
}

async function decodeWithNative(imageData) {
  const detector = await getNativeDetector();
  if (!detector) return null;

  try {
    const [barcode] = await detector.detect(imageData);
    if (!barcode?.rawValue) return null;
    return { text: barcode.rawValue, corners: normalizeCorners(barcode.cornerPoints) };
  } catch {
    // Detector nativo pode falhar em imagens muito pequenas ou por bug de
    // plataforma; nesses casos o fallback assume.
    return null;
  }
}

async function decodeWithJsQr(imageData, tryInverted) {
  const jsQR = await getJsQr();
  if (!jsQR) return null;

  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: tryInverted ? 'attemptBoth' : 'dontInvert',
  });
  if (!result?.data) return null;

  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } =
    result.location ?? {};

  return {
    text: result.data,
    corners: normalizeCorners([
      topLeftCorner,
      topRightCorner,
      bottomRightCorner,
      bottomLeftCorner,
    ]),
  };
}

/** Carrega o jsQR sob demanda, tentando as CDNs em ordem. */
function getJsQr() {
  if (jsQrPromise) return jsQrPromise;

  jsQrPromise = (async () => {
    for (const source of JSQR_SOURCES) {
      try {
        const module = await import(source);
        const jsQR = module.default ?? module.jsQR;
        if (typeof jsQR === 'function') return jsQR;
      } catch {
        // Tenta a próxima CDN.
      }
    }
    return null;
  })();

  return jsQrPromise;
}

function normalizeCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  if (corners.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return null;
  }
  return corners.map(({ x, y }) => ({ x, y }));
}
