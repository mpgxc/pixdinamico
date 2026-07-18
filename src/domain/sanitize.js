/**
 * Normalização de texto para os campos livres do BR Code (nome, cidade, txid).
 */

// Diacríticos combináveis (faixa Unicode "Combining Diacritical Marks").
const COMBINING_MARKS = /[̀-ͯ]/g;

// Tudo que não for letra ASCII, dígito ou espaço.
const NON_ALPHANUMERIC = /[^a-zA-Z0-9 ]/g;

/**
 * Sanitiza um texto para uso em campos do BR Code: remove acentos e
 * caracteres especiais, força maiúsculas e limita o comprimento.
 *
 * A ordem das operações é relevante: o texto é cortado em `maxLength` e só
 * depois sofre `trim()`, de modo que um corte no meio de um espaço não deixa
 * espaços nas bordas.
 *
 * @param {string} value     Texto de entrada.
 * @param {number} maxLength  Comprimento máximo permitido pelo campo.
 * @returns {string} Texto saneado.
 *
 * @example
 * sanitize('José da Conceição!!!', 25); // => 'JOSE DA CONCEICAO'
 */
export function sanitize(value, maxLength) {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(NON_ALPHANUMERIC, '')
    .toUpperCase()
    .slice(0, maxLength)
    .trim();
}
