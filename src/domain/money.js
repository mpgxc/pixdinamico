/**
 * Utilidades monetárias em Real (BRL): parsing tolerante e formatação.
 */

/**
 * Converte o texto digitado pelo usuário em número, no formato brasileiro
 * (`1.234,56`, `0,00`): o ponto é tratado como separador de milhar e a
 * vírgula como separador decimal.
 *
 * Retorna `null` para entradas vazias, inválidas ou não positivas — o que
 * sinaliza "valor ausente" para as camadas superiores.
 *
 * @param {string} raw Texto digitado (ex.: `'1.234,56'`).
 * @returns {number|null} Valor positivo em reais, ou `null`.
 *
 * @example
 * parseAmount('1.234,56'); // => 1234.56
 * parseAmount('10,00');    // => 10
 * parseAmount('');         // => null
 */
export function parseAmount(raw) {
  if (!raw) return null;

  const normalized = raw
    .replace(/\./g, '') // remove separadores de milhar
    .replace(',', '.') // vírgula decimal -> ponto decimal
    .replace(/[^\d.]/g, ''); // descarta qualquer outro caractere

  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Formata um valor numérico como moeda brasileira no padrão do app.
 *
 * @param {number} value Valor em reais.
 * @returns {string} Texto formatado (ex.: `'R$ 1234,56'`).
 *
 * @example
 * formatBRL(10); // => 'R$ 10,00'
 */
export function formatBRL(value) {
  return `R$ ${value.toFixed(2).replace('.', ',')}`;
}
