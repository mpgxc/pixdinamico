/**
 * Codificação EMV / TLV (Tag-Length-Value) usada no BR Code do PIX.
 *
 * Cada campo é serializado como: ID (2 dígitos) + tamanho (2 dígitos,
 * preenchido com zero à esquerda) + valor. O tamanho é medido em número de
 * caracteres do valor.
 *
 * @see https://www.bcb.gov.br/estabilidadefinanceira/pix — Manual do BR Code
 */

/**
 * Serializa um campo EMV no formato `ID + LEN + VALUE`.
 *
 * @param {string} id    Identificador de 2 dígitos do campo (ex.: `'00'`).
 * @param {string} value Conteúdo do campo.
 * @returns {string} Campo EMV serializado.
 *
 * @example
 * emv('00', '01'); // => '000201'
 */
export function emv(id, value) {
  const length = String(value.length).padStart(2, '0');
  return `${id}${length}${value}`;
}
