/**
 * CRC-16/CCITT-FALSE — checksum exigido no campo `63` do BR Code.
 *
 * Parâmetros do algoritmo: polinômio `0x1021`, valor inicial `0xFFFF`,
 * sem reflexão de entrada/saída e sem XOR final.
 */

const POLYNOMIAL = 0x1021;
const INITIAL_VALUE = 0xffff;
const WIDTH_MASK = 0xffff;
const HIGH_BIT = 0x8000;

/**
 * Calcula o CRC-16/CCITT-FALSE de um payload.
 *
 * @param {string} payload Payload já concatenado, incluindo o sufixo `'6304'`.
 * @returns {string} CRC em hexadecimal maiúsculo, com exatamente 4 caracteres.
 *
 * @example
 * crc16('HELLO'); // => '49D6'
 */
export function crc16(payload) {
  let crc = INITIAL_VALUE;

  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;

    for (let bit = 0; bit < 8; bit++) {
      const willOverflow = crc & HIGH_BIT;
      crc = willOverflow ? (crc << 1) ^ POLYNOMIAL : crc << 1;
      crc &= WIDTH_MASK;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}
