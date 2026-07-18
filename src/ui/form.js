/**
 * Leitura e validação do formulário, desacopladas do DOM concreto e da
 * lógica de geração do QR.
 */

import { parseAmount } from '../domain/money.js';

/**
 * @typedef {Object} PixFormElements
 * @property {HTMLInputElement} chave
 * @property {HTMLInputElement} nome
 * @property {HTMLInputElement} cidade
 * @property {HTMLInputElement} valor
 * @property {HTMLInputElement} txid
 * @property {HTMLInputElement} livre  Checkbox "valor livre".
 */

/**
 * @typedef {Object} PixFormValue
 * @property {string}      chave
 * @property {string}      nome
 * @property {string}      cidade
 * @property {string}      txid
 * @property {boolean}     valorLivre
 * @property {number|null} valor       `null` quando o valor é livre ou inválido.
 */

/**
 * Lê os valores atuais do formulário e devolve um objeto normalizado.
 *
 * @param {PixFormElements} elements
 * @returns {PixFormValue}
 */
export function readForm(elements) {
  const valorLivre = elements.livre.checked;

  return {
    chave: elements.chave.value.trim(),
    nome: elements.nome.value.trim(),
    cidade: elements.cidade.value.trim(),
    txid: elements.txid.value.trim(),
    valorLivre,
    valor: valorLivre ? null : parseAmount(elements.valor.value),
  };
}

/**
 * Valida os dados do formulário. Retorna a primeira mensagem de erro (ou
 * `null` se tudo estiver válido), preservando a ordem de checagem original.
 *
 * @param {PixFormValue} form
 * @returns {string|null}
 */
export function validate(form) {
  if (!form.chave) return 'Informe a chave PIX.';
  if (!form.nome) return 'Informe o nome do recebedor.';
  if (!form.cidade) return 'Informe a cidade.';
  if (!form.valorLivre && form.valor == null) {
    return 'Informe um valor válido ou marque "valor livre".';
  }
  return null;
}
