/**
 * Adapter para a biblioteca `qrcode-generator`, carregada via CDN e exposta
 * como o global `window.qrcode`.
 *
 * Isolar o acesso ao global neste módulo mantém o restante da aplicação
 * desacoplado da dependência externa (padrão Adapter / anticorrupção): se um
 * dia trocarmos a lib, só este arquivo muda.
 */

// Parâmetros de geração (mantidos idênticos ao comportamento original).
const AUTO_VERSION = 0; // 0 = a lib escolhe a menor versão que couber
const ERROR_CORRECTION = 'M'; // nível médio de correção de erros
const CELL_SIZE = 6; // pixels por módulo no data URL
const MARGIN = 8; // pixels de "quiet zone" ao redor do QR
const RENDER_SIZE = 210; // tamanho de exibição (px)

/** Lançado quando o global da biblioteca de QR não está disponível. */
export class QrLibraryUnavailableError extends Error {
  constructor() {
    super('Biblioteca de QR não carregou. Verifique a conexão e recarregue.');
    this.name = 'QrLibraryUnavailableError';
  }
}

/**
 * Gera um `<img>` contendo o QR Code (GIF em data URL) para o texto informado.
 *
 * @param {string} text Conteúdo a ser codificado (o BR Code).
 * @returns {HTMLImageElement} Imagem pronta para ser inserida no DOM.
 * @throws {QrLibraryUnavailableError} Se a biblioteca não estiver carregada.
 */
export function createQrImage(text) {
  if (typeof window.qrcode !== 'function') {
    throw new QrLibraryUnavailableError();
  }

  const qr = window.qrcode(AUTO_VERSION, ERROR_CORRECTION);
  qr.addData(text);
  qr.make();

  const image = document.createElement('img');
  image.src = qr.createDataURL(CELL_SIZE, MARGIN);
  image.width = RENDER_SIZE;
  image.height = RENDER_SIZE;
  image.alt = 'QR Code PIX';
  return image;
}
