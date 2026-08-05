/**
 * Controlador da página do leitor de QR Code.
 *
 * Cuida só de DOM e de estado de tela: ligar e desligar a câmera, empurrar cada
 * quadro para o pipeline e desenhar o retorno. Toda a visão computacional fica
 * em `src/scan/`, sem saber que existe uma interface.
 *
 * A câmera nunca liga sozinha ao abrir a página — exige um clique. Além de ser
 * o que o usuário espera, evita o diálogo de permissão surgindo do nada e
 * mantém o aparelho frio enquanto ninguém está lendo nada.
 */

import {
  applyZoom,
  CameraError,
  currentZoom,
  openCamera,
  setTorch,
  startFrameLoop,
  stopStream,
  supportsTorch,
  zoomCapability,
} from '../scan/camera.js';
import { createQrPipeline } from '../scan/pipeline.js';
import { createZoomController } from '../scan/zoom.js';

/** Intervalo mínimo entre análises: ~8 leituras por segundo. */
const SCAN_INTERVAL_MS = 120;

const COPY_FEEDBACK_MS = 1500;
const LABEL_COPY = 'Copiar';
const LABEL_COPIED = 'Copiado!';

const LABEL_START = 'Ligar câmera';
const LABEL_STOP = 'Parar';
const LABEL_AGAIN = 'Ler outro';

const PLACEHOLDER_IDLE = 'A câmera só liga quando você pedir';
const PLACEHOLDER_DONE = 'Câmera desligada';

const SUCCESS_VIBRATION_MS = 40;

const STATUS = {
  idle: 'Nada é enviado para fora do aparelho.',
  starting: 'Ligando a câmera…',
  searching: 'Aponte para o QR Code.',
  located: 'QR Code encontrado — ampliando para ler…',
  decodedFromFrame: 'Lido direto do quadro.',
  decodedFromCrop: 'Lido a partir do recorte ampliado.',
};

// Estilo do destaque desenhado sobre o vídeo.
const HIGHLIGHT_COLOR = '#32bcad';
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_FILL = 'rgba(50, 188, 173, 0.12)';
const CORNER_FRACTION = 0.22; // comprimento do "cantinho" em relação ao lado

/**
 * Registra o leitor de QR Code na página.
 *
 * @returns {void}
 */
export function initScanner() {
  const elements = queryElements();
  if (!elements) return; // página sem o leitor

  const pipeline = createQrPipeline();
  const session = { stream: null, track: null, stopLoop: null, zoom: null };

  bindEvents(elements, pipeline, session);
}

/** Localiza os elementos do leitor; devolve `null` se a página não os tiver. */
function queryElements() {
  const byId = (id) => document.getElementById(id);

  const toggleButton = byId('scanToggle');
  const stage = byId('scanStage');
  if (!toggleButton || !stage) return null;

  return {
    toggleButton,
    stage,
    video: byId('scanVideo'),
    overlay: byId('scanOverlay'),
    placeholderText: byId('scanPlaceholderText'),
    status: byId('scanStatus'),
    torchButton: byId('scanTorch'),
    zoomBadge: byId('scanZoom'),
    result: byId('scanResult'),
    text: byId('scanText'),
    copyButton: byId('scanCopy'),
    cropBox: byId('scanCropBox'),
    crop: byId('scanCrop'),
  };
}

function bindEvents(elements, pipeline, session) {
  elements.toggleButton.addEventListener('click', () => {
    if (session.stream) stop(elements, session);
    else start(elements, pipeline, session);
  });

  elements.copyButton.addEventListener('click', () => copyResult(elements));

  elements.torchButton.addEventListener('click', async () => {
    const on = elements.torchButton.getAttribute('aria-pressed') !== 'true';
    if (await setTorch(session.track, on)) {
      elements.torchButton.setAttribute('aria-pressed', String(on));
    }
  });

  // Sair da página (ou trocar de aba por muito tempo) sem soltar a câmera
  // deixaria a luzinha acesa e o aparelho esquentando.
  window.addEventListener('pagehide', () => stop(elements, session));
}

/** Liga a câmera e começa a analisar os quadros. */
async function start(elements, pipeline, session) {
  hideResult(elements);
  pipeline.reset();
  setStatus(elements, STATUS.starting);
  elements.toggleButton.disabled = true;

  try {
    const { stream, track } = await openCamera(elements.video);
    session.stream = stream;
    session.track = track;
  } catch (error) {
    setStatus(elements, error instanceof CameraError ? error.message : String(error));
    elements.toggleButton.disabled = false;
    return;
  }

  // Faz a moldura ter a mesma proporção do vídeo: assim o canvas de destaque
  // cobre exatamente a área da imagem, e as coordenadas do pipeline batem 1:1.
  elements.stage.style.aspectRatio = `${elements.video.videoWidth} / ${elements.video.videoHeight}`;
  elements.stage.classList.add('is-live');

  elements.torchButton.hidden = !supportsTorch(session.track);
  elements.torchButton.setAttribute('aria-pressed', 'false');

  session.zoom = createZoomController({
    range: zoomCapability(session.track),
    initial: currentZoom(session.track),
    apply: (value) => applyZoom(session.track, value),
  });
  showZoom(elements, session.zoom);
  elements.toggleButton.disabled = false;
  elements.toggleButton.textContent = LABEL_STOP;
  setStatus(elements, STATUS.searching);

  session.stopLoop = startFrameLoop(
    elements.video,
    async () => {
      const result = await pipeline.scan(elements.video);
      render(elements, result);

      if (result.status === 'decoded') {
        finish(elements, session, result);
        return;
      }
      await steerZoom(elements, pipeline, session, result);
    },
    {
      minIntervalMs: SCAN_INTERVAL_MS,
      onError: (error) => setStatus(elements, `Falha ao analisar o quadro: ${error.message}`),
    },
  );
}

/** Desliga a câmera e volta a moldura ao estado inicial. */
function stop(elements, session) {
  releaseCamera(elements, session);
  elements.toggleButton.textContent = LABEL_START;
  elements.placeholderText.textContent = PLACEHOLDER_IDLE;
  setStatus(elements, STATUS.idle);
}

/** Encerra a leitura mantendo o resultado na tela. */
function finish(elements, session, result) {
  releaseCamera(elements, session);

  setStatus(
    elements,
    result.via === 'crop' ? STATUS.decodedFromCrop : STATUS.decodedFromFrame,
  );

  elements.text.value = result.text;
  elements.result.hidden = false;
  elements.copyButton.textContent = LABEL_COPY;
  elements.toggleButton.textContent = LABEL_AGAIN;
  elements.placeholderText.textContent = PLACEHOLDER_DONE;

  navigator.vibrate?.(SUCCESS_VIBRATION_MS);
}

/** Para o laço, solta o stream e devolve a moldura ao estado sem vídeo. */
function releaseCamera(elements, session) {
  session.stopLoop?.();
  session.stopLoop = null;

  stopStream(session.stream);
  session.stream = null;
  session.track = null;

  elements.video.srcObject = null;
  elements.stage.classList.remove('is-live');
  elements.torchButton.hidden = true;
  elements.zoomBadge.hidden = true;
  session.zoom = null;

  // Sem vídeo por baixo, o destaque da última detecção viraria um contorno
  // solto no vazio — e ainda por cima do texto da moldura.
  clearHighlight(elements.overlay);
}

/**
 * Decide a aproximação automática a partir do que o pipeline viu no quadro.
 *
 * Localizou e não leu -> aproxima na medida exata. Não achou nada -> começa a
 * reabrir o campo, para não deixar o usuário preso num enquadramento estreito.
 *
 * Depois de mexer no zoom, a localização anterior deixa de valer: o destaque na
 * tela apontaria para onde o símbolo estava antes de a lente se mover. Por isso
 * o pipeline é reiniciado, forçando uma medição nova no próximo quadro.
 */
async function steerZoom(elements, pipeline, session, result) {
  const zoom = session.zoom;
  if (!zoom?.supported) return;

  const changed = result.symbol
    ? await zoom.onLocated(result.symbol)
    : result.status === 'searching' && (await zoom.onMissed());

  if (!changed) return;

  pipeline.reset();
  showZoom(elements, zoom);
}

/** Mostra o nível de zoom só quando ele saiu do mínimo. */
function showZoom(elements, zoom) {
  const zoomed = zoom.supported && zoom.level > zoom.min;
  elements.zoomBadge.hidden = !zoomed;
  if (zoomed) elements.zoomBadge.textContent = `${zoom.level.toFixed(1).replace('.', ',')}×`;
}

/** Reflete o resultado de um quadro na tela (status, destaque e recorte). */
function render(elements, result) {
  if (result.status === 'no-frame') return;

  if (result.status === 'searching') setStatus(elements, STATUS.searching);
  if (result.status === 'located') setStatus(elements, STATUS.located);

  drawHighlight(elements.overlay, result.frame, result.corners);
  if (result.crop) drawCrop(elements, result.crop);
}

/** Desenha o contorno e os cantos do símbolo localizado sobre o vídeo. */
function drawHighlight(canvas, frame, corners) {
  if (!frame) return;

  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }

  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!corners) return;

  context.beginPath();
  corners.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();

  context.fillStyle = HIGHLIGHT_FILL;
  context.fill();

  context.strokeStyle = HIGHLIGHT_COLOR;
  context.lineWidth = HIGHLIGHT_WIDTH;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.stroke();

  drawCornerMarks(context, corners);
}

/** Reforça cada vértice com um "cantinho" em L, como mira de leitor. */
function drawCornerMarks(context, corners) {
  context.lineWidth = HIGHLIGHT_WIDTH * 2;

  corners.forEach((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length];
    const next = corners[(index + 1) % corners.length];

    context.beginPath();
    context.moveTo(...towards(corner, previous, CORNER_FRACTION));
    context.lineTo(corner.x, corner.y);
    context.lineTo(...towards(corner, next, CORNER_FRACTION));
    context.stroke();
  });
}

/** Ponto a `fraction` do caminho de `from` até `to`, como par `[x, y]`. */
function towards(from, to, fraction) {
  return [from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction];
}

/** Mostra o recorte ampliado que foi (ou seria) enviado ao decodificador. */
function drawCrop(elements, crop) {
  const canvas = elements.crop;
  if (canvas.width !== crop.width || canvas.height !== crop.height) {
    canvas.width = crop.width;
    canvas.height = crop.height;
  }
  canvas.getContext('2d').putImageData(crop, 0, 0);
  elements.cropBox.hidden = false;
}

function copyResult(elements) {
  elements.text.select();
  navigator.clipboard?.writeText(elements.text.value).then(() => {
    elements.copyButton.textContent = LABEL_COPIED;
    setTimeout(() => {
      elements.copyButton.textContent = LABEL_COPY;
    }, COPY_FEEDBACK_MS);
  });
}

/** Apaga o destaque desenhado sobre o vídeo. */
function clearHighlight(canvas) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function hideResult(elements) {
  elements.result.hidden = true;
  elements.cropBox.hidden = true;
  elements.text.value = '';
  clearHighlight(elements.overlay);
}

function setStatus(elements, message) {
  elements.status.textContent = message;
}
