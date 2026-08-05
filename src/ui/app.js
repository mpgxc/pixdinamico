/**
 * Controlador da aplicação: liga os eventos do DOM e orquestra o fluxo de
 * geração do QR Code, delegando cada responsabilidade às camadas de domínio,
 * de QR e de formulário.
 */

import { buildPixPayload } from '../domain/pix.js';
import { formatBRL } from '../domain/money.js';
import { createQrImage, QrLibraryUnavailableError } from '../qr/qr-renderer.js';
import { readForm, validate } from './form.js';
import { initScanner } from './scanner.js';

const COPY_FEEDBACK_MS = 1500;
const LABEL_COPY = 'Copiar';
const LABEL_COPIED = 'Copiado!';
const FREE_VALUE_TEXT = 'Valor a definir pelo pagador';
const DISABLED_OPACITY = '0.4';
const ENABLED_OPACITY = '1';

/**
 * Localiza e agrupa todos os elementos do DOM usados pela aplicação.
 *
 * @returns {Object} Referências de DOM organizadas.
 */
function queryElements() {
  const byId = (id) => document.getElementById(id);

  return {
    form: byId('pix-form'),
    frame: byId('frame'),
    placeholder: byId('placeholder'),
    error: byId('err'),
    payout: byId('payout'),
    download: byId('download'),
    copyBox: byId('copyBox'),
    copyButton: byId('copyBtn'),
    brcode: byId('brcode'),
    fields: {
      chave: byId('chave'),
      nome: byId('nome'),
      cidade: byId('cidade'),
      valor: byId('valor'),
      txid: byId('txid'),
      livre: byId('livre'),
    },
  };
}

/** Habilita/desabilita o campo de valor conforme o checkbox "valor livre". */
function bindFreeValueToggle({ fields }) {
  fields.livre.addEventListener('change', () => {
    const isFree = fields.livre.checked;
    fields.valor.disabled = isFree;
    fields.valor.style.opacity = isFree ? DISABLED_OPACITY : ENABLED_OPACITY;
    if (isFree) fields.valor.value = '';
  });
}

/** Liga o submit do formulário à geração do QR. */
function bindFormSubmit(elements) {
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    handleGenerate(elements);
  });
}

/** Copia o BR Code para a área de transferência, com feedback no botão. */
function bindCopyButton({ copyButton, brcode }) {
  copyButton.addEventListener('click', () => {
    brcode.select();
    navigator.clipboard?.writeText(brcode.value).then(() => {
      copyButton.textContent = LABEL_COPIED;
      setTimeout(() => {
        copyButton.textContent = LABEL_COPY;
      }, COPY_FEEDBACK_MS);
    });
  });
}

/** Fluxo principal: lê, valida, gera o payload e renderiza (ou mostra erro). */
function handleGenerate(elements) {
  showError(elements, '');

  const form = readForm(elements.fields);
  const errorMessage = validate(form);
  if (errorMessage) {
    showError(elements, errorMessage);
    return;
  }

  const brcode = buildPixPayload({
    chave: form.chave,
    valor: form.valor,
    nome: form.nome,
    cidade: form.cidade,
    txid: form.txid,
  });

  let qrImage;
  try {
    qrImage = createQrImage(brcode);
  } catch (error) {
    if (error instanceof QrLibraryUnavailableError) {
      showError(elements, error.message);
      return;
    }
    throw error;
  }

  renderResult(elements, { brcode, qrImage, valor: form.valor });
}

/** Atualiza o painel de resultado com o QR, o valor e o copia-e-cola. */
function renderResult(elements, { brcode, qrImage, valor }) {
  elements.frame
    .querySelectorAll('canvas, img')
    .forEach((node) => node.remove());
  elements.placeholder.style.display = 'none';
  elements.frame.appendChild(qrImage);

  elements.payout.textContent = valor != null ? formatBRL(valor) : FREE_VALUE_TEXT;

  elements.brcode.value = brcode;
  elements.copyBox.classList.add('show');

  elements.download.href = qrImage.src;
  elements.download.classList.add('show');
}

/** Define (ou limpa, com string vazia) a mensagem de erro. */
function showError(elements, message) {
  elements.error.textContent = message;
}

/**
 * Ponto de entrada da aplicação: localiza os elementos e registra os eventos.
 */
export function init() {
  const elements = queryElements();
  bindFreeValueToggle(elements);
  bindFormSubmit(elements);
  bindCopyButton(elements);
  initScanner();
}
