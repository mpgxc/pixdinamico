/**
 * Montagem do BR Code estático (PIX "copia-e-cola").
 *
 * Combina os utilitários puros de codificação (`emv`, `crc16`, `sanitize`)
 * seguindo o layout de campos definido no Manual de Padrões para Iniciação
 * do PIX (Banco Central do Brasil).
 */

import { emv } from './emv.js';
import { crc16 } from './crc16.js';
import { sanitize } from './sanitize.js';

/** IDs dos campos EMV que compõem o BR Code. */
const FIELD = Object.freeze({
  PAYLOAD_FORMAT: '00',
  POI_METHOD: '01',
  MERCHANT_ACCOUNT: '26',
  GUI: '00', // subcampo de MERCHANT_ACCOUNT
  KEY: '01', // subcampo de MERCHANT_ACCOUNT
  MERCHANT_CATEGORY: '52',
  CURRENCY: '53',
  AMOUNT: '54',
  COUNTRY: '58',
  MERCHANT_NAME: '59',
  MERCHANT_CITY: '60',
  ADDITIONAL_DATA: '62',
  TXID: '05', // subcampo de ADDITIONAL_DATA
  CRC: '63',
});

/** Valores fixos e limites do BR Code estático. */
const PIX = Object.freeze({
  GUI: 'br.gov.bcb.pix',
  PAYLOAD_FORMAT_VERSION: '01',
  POI_STATIC: '11', // Point of Initiation Method: 11 = QR estático (reutilizável)
  MERCHANT_CATEGORY_CODE: '0000',
  CURRENCY_BRL: '986', // ISO 4217
  COUNTRY_BR: 'BR',
  DEFAULT_TXID: '***', // usado quando não há txid
  CRC_LENGTH: '04', // o CRC sempre ocupa 4 caracteres
});

/** Limites de comprimento de cada campo livre. */
const MAX_LENGTH = Object.freeze({
  NAME: 25,
  CITY: 15,
  TXID: 25,
});

/**
 * @typedef {Object} PixInput
 * @property {string}      chave  Chave PIX (CPF, CNPJ, e-mail, telefone ou aleatória).
 * @property {number|null} valor  Valor em reais, ou `null` para "valor livre".
 * @property {string}      nome   Nome do recebedor.
 * @property {string}      cidade Cidade do recebedor.
 * @property {string}      [txid] Identificador da transação (opcional).
 */

/**
 * Monta o payload do BR Code estático já com o CRC-16 no final.
 *
 * @param {PixInput} input Dados da cobrança.
 * @returns {string} BR Code pronto para ser exibido e/ou codificado em QR.
 */
export function buildPixPayload({ chave, valor, nome, cidade, txid = '' }) {
  const merchantAccount = emv(
    FIELD.MERCHANT_ACCOUNT,
    emv(FIELD.GUI, PIX.GUI) + emv(FIELD.KEY, chave.trim()),
  );

  const additionalData = emv(
    FIELD.ADDITIONAL_DATA,
    emv(FIELD.TXID, sanitize(txid, MAX_LENGTH.TXID) || PIX.DEFAULT_TXID),
  );

  const amount = valor != null ? emv(FIELD.AMOUNT, valor.toFixed(2)) : '';

  const unsignedPayload =
    emv(FIELD.PAYLOAD_FORMAT, PIX.PAYLOAD_FORMAT_VERSION) +
    emv(FIELD.POI_METHOD, PIX.POI_STATIC) +
    merchantAccount +
    emv(FIELD.MERCHANT_CATEGORY, PIX.MERCHANT_CATEGORY_CODE) +
    emv(FIELD.CURRENCY, PIX.CURRENCY_BRL) +
    amount +
    emv(FIELD.COUNTRY, PIX.COUNTRY_BR) +
    emv(FIELD.MERCHANT_NAME, sanitize(nome, MAX_LENGTH.NAME)) +
    emv(FIELD.MERCHANT_CITY, sanitize(cidade, MAX_LENGTH.CITY)) +
    additionalData +
    FIELD.CRC +
    PIX.CRC_LENGTH;

  return unsignedPayload + crc16(unsignedPayload);
}
