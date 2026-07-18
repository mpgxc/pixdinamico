/**
 * Testes de regressão do domínio.
 *
 * Os valores esperados ("golden values") foram capturados a partir do
 * algoritmo original (index.html monolítico) antes da refatoração, garantindo
 * que a nova estrutura em módulos preserva exatamente o mesmo comportamento —
 * incluindo o BR Code e o CRC-16, que não podem mudar.
 *
 * Executar com: `npm test` (ou `node --test`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emv } from '../src/domain/emv.js';
import { crc16 } from '../src/domain/crc16.js';
import { sanitize } from '../src/domain/sanitize.js';
import { parseAmount, formatBRL } from '../src/domain/money.js';
import { buildPixPayload } from '../src/domain/pix.js';

test('emv serializa ID + tamanho + valor', () => {
  assert.equal(emv('00', '01'), '000201');
  assert.equal(emv('01', '11'), '010211'); // tamanho é do valor ('11' -> 2)
  assert.equal(emv('26', ''), '2600');
});

test('crc16 calcula CCITT-FALSE em HEX de 4 dígitos', () => {
  assert.equal(crc16('HELLO'), '49D6');
  assert.equal(crc16('').length, 4);
});

test('sanitize remove acentos/especiais, força maiúsculas e limita tamanho', () => {
  assert.equal(sanitize('José da Conceição!!!', 25), 'JOSE DA CONCEICAO');
  assert.equal(sanitize('São Paulo', 15), 'SAO PAULO');
  assert.equal(sanitize('abcdefghij', 5), 'ABCDE');
});

test('parseAmount interpreta o formato brasileiro e rejeita inválidos', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('10,00'), 10);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('0'), null);
});

test('formatBRL usa vírgula decimal e prefixo R$', () => {
  assert.equal(formatBRL(10), 'R$ 10,00');
  assert.equal(formatBRL(1234.56), 'R$ 1234,56');
});

test('buildPixPayload reproduz o BR Code com valor fixo (golden)', () => {
  const brcode = buildPixPayload({
    chave: 'fulano@email.com',
    valor: 10,
    nome: 'Fulano de Tal',
    cidade: 'Teresina',
    txid: 'PEDIDO12345',
  });

  assert.equal(
    brcode,
    '00020101021126380014br.gov.bcb.pix0116fulano@email.com520400005303986540510.005802BR5913FULANO DE TAL6008TERESINA62150511PEDIDO12345630491FF',
  );
});

test('buildPixPayload reproduz o BR Code com valor livre (golden)', () => {
  const brcode = buildPixPayload({
    chave: 'fulano@email.com',
    valor: null,
    nome: 'José da Conceição',
    cidade: 'São Paulo',
    txid: '',
  });

  assert.equal(
    brcode,
    '00020101021126380014br.gov.bcb.pix0116fulano@email.com5204000053039865802BR5917JOSE DA CONCEICAO6009SAO PAULO62070503***6304689A',
  );
});

test('o CRC final é consistente com o restante do payload', () => {
  const brcode = buildPixPayload({
    chave: 'chave-aleatoria',
    valor: 42.5,
    nome: 'Maria',
    cidade: 'Recife',
    txid: 'ABC',
  });

  const body = brcode.slice(0, -4); // tudo menos o CRC (termina em '6304')
  const crc = brcode.slice(-4);
  assert.equal(crc, crc16(body));
  assert.ok(body.endsWith('6304'));
});
