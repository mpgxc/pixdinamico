/**
 * Controlador da interface do leitor de QR Code.
 *
 * Cuida só de DOM e de estado de tela: abrir/fechar o painel, ligar a câmera,
 * empurrar cada quadro para o pipeline e desenhar o retorno. Toda a visão
 * computacional fica em `src/scan/`, sem saber que existe uma interface.
 */

import {
  CameraError,
  CameraErrorCode,
  openCamera,
  setTorch,
  startFrameLoop,
  stopStream,
  supportsTorch,
} from '../scan/camera.js';
import { createQrPipeline } from '../scan/pipeline.js';

/** Intervalo mínimo entre análises: ~8 leituras por segundo. */
const SCAN_INTERVAL_MS = 120;

const COPY_FEEDBACK_MS = 1500;
const LABEL_COPY = 'Copiar';
const LABEL_COPIED = 'Copiado!';

const SUCCESS_VIBRATION_MS = 40;

const STATUS = {
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
  if (!elements) return; // página sem a seção do leitor

  const pipeline = createQrPipeline();
  const session = { stream: null, track: null, stopLoop: null };

  bindEvents(elements, pipeline, session);
}

/** Localiza os elementos do leitor; devolve `null` se a seção não existir. */
function queryElements() {
  const byId = (id) => document.getElementById(id);

  const panel = byId('scanner');
  const openButton = byId('scanOpen');
  if (!panel || !openButton) return null;

  return {
    panel,
    openButton,
    closeButton: byId('scanClose'),
    stage: byId('scanStage'),
    video: byId('scanVideo'),
    overlay: byId('scanOverlay'),
    status: byId('scanStatus'),
    torchButton: byId('scanTorch'),
    result: byId('scanResult'),
    text: byId('scanText'),
    copyButton: byId('scanCopy'),
    againButton: byId('scanAgain'),
    cropBox: byId('scanCropBox'),
    crop: byId('scanCrop'),
  };
}

function bindEvents(elements, pipeline, session) {
  const open = () => start(elements, pipeline, session);
  const close = () => stop(elements, session);

  elements.openButton.addEventListener('click', open);
  elements.closeButton.addEventListener('click', close);
  elements.againButton.addEventListener('click', open);

  elements.panel.addEventListener('click', (event) => {
    if (event.target === elements.panel) close(); // clique no fundo escuro
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.panel.hidden) close();
  });

  elements.copyButton.addEventListener('click', () => copyResult(elements));

  elements.torchButton.addEventListener('click', async () => {
    const on = elements.torchButton.getAttribute('aria-pressed') !== 'true';
    if (await setTorch(session.track, on)) {
      elements.torchButton.setAttribute('aria-pressed', String(on));
    }
  });
}

/** Abre o painel, liga a câmera e começa a analisar os quadros. */
async function start(elements, pipeline, session) {
  showPanel(elements);
  hideResult(elements);
  pipeline.reset();
  setStatus(elements, STATUS.starting);

  try {
    const { stream, track } = await openCamera(elements.video);
    session.stream = stream;
    session.track = track;
  } catch (error) {
    setStatus(elements, error instanceof CameraError ? error.message : String(error));
    if (error?.code === CameraErrorCode.PERMISSION_DENIED) {
      elements.openButton.focus();
    }
    return;
  }

  // Faz a moldura ter a mesma proporção do vídeo: assim o canvas de destaque
  // cobre exatamente a área da imagem, e as coordenadas do pipeline batem 1:1.
  elements.stage.style.aspectRatio = `${elements.video.videoWidth} / ${elements.video.videoHeight}`;

  elements.torchButton.hidden = !supportsTorch(session.track);
  elements.torchButton.setAttribute('aria-pressed', 'false');
  setStatus(elements, STATUS.searching);

  session.stopLoop = startFrameLoop(
    elements.video,
    async () => {
      const result = await pipeline.scan(elements.video);
      render(elements, result);
      if (result.status === 'decoded') finish(elements, session, result);
    },
    {
      minIntervalMs: SCAN_INTERVAL_MS,
      onError: (error) => setStatus(elements, `Falha ao analisar o quadro: ${error.message}`),
    },
  );
}

/** Fecha o painel e libera a câmera. */
function stop(elements, session) {
  session.stopLoop?.();
  session.stopLoop = null;

  stopStream(session.stream);
  session.stream = null;
  session.track = null;

  elements.video.srcObject = null;
  hidePanel(elements);
  elements.openButton.focus();
}

/** Interrompe a análise mantendo o painel aberto com o resultado. */
function finish(elements, session, result) {
  session.stopLoop?.();
  session.stopLoop = null;

  setStatus(
    elements,
    result.via === 'crop' ? STATUS.decodedFromCrop : STATUS.decodedFromFrame,
  );

  elements.text.value = result.text;
  elements.result.hidden = false;
  elements.copyButton.textContent = LABEL_COPY;

  navigator.vibrate?.(SUCCESS_VIBRATION_MS);
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

function showPanel(elements) {
  elements.panel.hidden = false;
  elements.panel.setAttribute('aria-hidden', 'false');
  elements.closeButton.focus();
}

function hidePanel(elements) {
  elements.panel.hidden = true;
  elements.panel.setAttribute('aria-hidden', 'true');
}

function hideResult(elements) {
  elements.result.hidden = true;
  elements.cropBox.hidden = true;
  elements.text.value = '';
  drawHighlight(elements.overlay, { width: 1, height: 1 }, null);
}

function setStatus(elements, message) {
  elements.status.textContent = message;
}
