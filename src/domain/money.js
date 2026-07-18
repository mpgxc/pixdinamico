/**
 * Utilidades monetárias em Real (BRL): parsing tolerante e formatação.
 */

/**
 * Converte o texto digitado pelo usuário em número, aceitando tanto o formato
 * brasileiro (`1.234,56`) quanto o internacional (`1234.56`).
 *
 * O separador decimal é detectado da seguinte forma:
 * - se `.` e `,` aparecem juntos, o decimal é o que vier por último
 *   (`1.234,56` e `1,234.56` resultam ambos em `1234.56`);
 * - se houver apenas vírgula, ela é o decimal (padrão brasileiro: `10,00` -> 10);
 * - se houver apenas ponto, ele é decimal somente quando for único e com 1–2
 *   casas (`1234.56` -> 1234.56); caso contrário é separador de milhar
 *   (`1.234` -> 1234, `1.234.567` -> 1234567).
 *
 * Retorna `null` para entradas vazias, inválidas ou não positivas — o que
 * sinaliza "valor ausente" para as camadas superiores.
 *
 * @param {string} raw Texto digitado (ex.: `'1.234,56'`, `'1234.56'`).
 * @returns {number|null} Valor positivo em reais, ou `null`.
 *
 * @example
 * parseAmount('1.234,56'); // => 1234.56
 * parseAmount('1234.56');  // => 1234.56
 * parseAmount('10,00');    // => 10
 * parseAmount('');         // => null
 */
export function parseAmount(raw) {
  if (!raw) return null;

  // Mantém apenas dígitos e separadores (descarta "R$", espaços, sinais...).
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  // Posição do separador decimal (-1 quando o valor é inteiro).
  let decimalPos = -1;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalPos = Math.max(lastDot, lastComma); // o último separador é o decimal
  } else if (lastComma !== -1) {
    decimalPos = lastComma; // só vírgula -> decimal (padrão brasileiro)
  } else if (lastDot !== -1) {
    const isSingleDot = cleaned.indexOf('.') === lastDot;
    const decimals = cleaned.length - lastDot - 1;
    if (isSingleDot && decimals >= 1 && decimals <= 2) decimalPos = lastDot;
  }

  const digitsOnly = (text) => text.replace(/[.,]/g, '');
  const normalized =
    decimalPos === -1
      ? digitsOnly(cleaned)
      : `${digitsOnly(cleaned.slice(0, decimalPos))}.${digitsOnly(cleaned.slice(decimalPos + 1))}`;

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
