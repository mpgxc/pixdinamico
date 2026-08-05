/**
 * Ciclo de vida da câmera: abertura do stream, laço de quadros e lanterna.
 *
 * Concentra aqui as armadilhas de `getUserMedia` que não aparecem no caminho
 * feliz — contexto inseguro, permissão negada, câmera ocupada por outro app,
 * restrição impossível de satisfazer — para que a interface possa dizer ao
 * usuário o que fazer em vez de exibir "erro inesperado".
 */

/** Códigos de erro estáveis, para a UI decidir a mensagem sem olhar strings. */
export const CameraErrorCode = {
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  UNSUPPORTED: 'UNSUPPORTED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  IN_USE: 'IN_USE',
  UNKNOWN: 'UNKNOWN',
};

const MESSAGES = {
  [CameraErrorCode.INSECURE_CONTEXT]:
    'A câmera só funciona em HTTPS (ou em localhost). Abra a página por um endereço seguro.',
  [CameraErrorCode.UNSUPPORTED]: 'Este navegador não expõe acesso à câmera.',
  [CameraErrorCode.PERMISSION_DENIED]:
    'Permissão negada. Libere o acesso à câmera nas configurações do site e tente de novo.',
  [CameraErrorCode.NOT_FOUND]: 'Nenhuma câmera foi encontrada neste dispositivo.',
  [CameraErrorCode.IN_USE]: 'A câmera está sendo usada por outro aplicativo.',
  [CameraErrorCode.UNKNOWN]: 'Não foi possível abrir a câmera.',
};

/** Resolução pedida: alta o bastante para o recorte ampliado valer a pena. */
const PREFERRED_WIDTH = 1920;
const PREFERRED_HEIGHT = 1080;

/** Erro de câmera com código estável em `code`. */
export class CameraError extends Error {
  /**
   * @param {string} code Um dos valores de `CameraErrorCode`.
   * @param {Error} [cause]
   */
  constructor(code, cause) {
    super(MESSAGES[code] ?? MESSAGES[CameraErrorCode.UNKNOWN], { cause });
    this.name = 'CameraError';
    this.code = code;
  }
}

/**
 * Abre a câmera traseira (com queda para qualquer câmera disponível) e liga o
 * stream ao elemento de vídeo, resolvendo quando os primeiros quadros já estão
 * chegando.
 *
 * @param {HTMLVideoElement} video
 * @returns {Promise<{ stream: MediaStream, track: MediaStreamTrack }>}
 * @throws {CameraError}
 */
export async function openCamera(video) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new CameraError(CameraErrorCode.INSECURE_CONTEXT);
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(CameraErrorCode.UNSUPPORTED);
  }

  const stream = await requestStream();
  const [track] = stream.getVideoTracks();

  // `playsInline` e `muted` são obrigatórios no iOS: sem eles o Safari abre o
  // vídeo em tela cheia (ou simplesmente não dá play).
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;

  try {
    await video.play();
    await waitForFirstFrame(video);
  } catch (error) {
    stopStream(stream);
    throw new CameraError(CameraErrorCode.UNKNOWN, error);
  }

  return { stream, track };
}

/** Encerra todas as trilhas do stream (a luzinha da câmera só apaga assim). */
export function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Chama `onFrame` a cada novo quadro do vídeo, no máximo a cada
 * `minIntervalMs`. Usa `requestVideoFrameCallback` quando existe — ele dispara
 * uma vez por quadro *do vídeo*, e não por quadro de renderização, evitando
 * analisar duas vezes a mesma imagem.
 *
 * O quadro seguinte só é agendado depois que `onFrame` termina, então uma
 * análise lenta reduz a taxa em vez de acumular fila.
 *
 * @param {HTMLVideoElement} video
 * @param {() => Promise<void>|void} onFrame
 * @param {{ minIntervalMs?: number, onError?: (error: Error) => void }} [options]
 * @returns {() => void} Função que interrompe o laço.
 */
export function startFrameLoop(video, onFrame, { minIntervalMs = 0, onError } = {}) {
  const schedule =
    typeof video.requestVideoFrameCallback === 'function'
      ? (callback) => video.requestVideoFrameCallback(callback)
      : (callback) => requestAnimationFrame(callback);

  let stopped = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;

  const tick = async (now) => {
    if (stopped) return;

    if (now - lastRunAt >= minIntervalMs) {
      lastRunAt = now;
      try {
        await onFrame();
      } catch (error) {
        onError?.(error);
      }
    }

    if (!stopped) schedule(tick);
  };

  schedule(tick);

  return () => {
    stopped = true;
  };
}

/**
 * Indica se a trilha aceita ligar a lanterna. Só existe em câmeras traseiras de
 * celular, e só depois que o stream está ativo.
 *
 * @param {MediaStreamTrack} track
 * @returns {boolean}
 */
export function supportsTorch(track) {
  return Boolean(track?.getCapabilities?.().torch);
}

/**
 * Liga ou desliga a lanterna.
 *
 * @param {MediaStreamTrack} track
 * @param {boolean} on
 * @returns {Promise<boolean>} `true` se a mudança foi aplicada.
 */
export async function setTorch(track, on) {
  if (!supportsTorch(track)) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pede o stream preferindo a câmera traseira em alta resolução e, se o
 * dispositivo não atender, relaxa as restrições em vez de falhar.
 */
async function requestStream() {
  const attempts = [
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: PREFERRED_WIDTH },
        height: { ideal: PREFERRED_HEIGHT },
      },
    },
    { video: { facingMode: { ideal: 'environment' } } },
    { video: true },
  ];

  let lastError;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      // Permissão negada não melhora afrouxando restrição: aborta na hora.
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') break;
    }
  }

  throw new CameraError(toErrorCode(lastError), lastError);
}

function toErrorCode(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return CameraErrorCode.PERMISSION_DENIED;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return CameraErrorCode.NOT_FOUND;
    case 'NotReadableError':
    case 'TrackStartError':
      return CameraErrorCode.IN_USE;
    default:
      return CameraErrorCode.UNKNOWN;
  }
}

/**
 * Espera o vídeo ter dimensões: antes disso `videoWidth` é 0 e qualquer
 * `drawImage` desenha nada.
 */
function waitForFirstFrame(video) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();

  return new Promise((resolve) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
  });
}
