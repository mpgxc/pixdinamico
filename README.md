# Gerador de QR Code PIX

Página estática, sem build, para gerar QR Code PIX (BR Code estático) com valor customizado ou valor livre. Todo o processamento roda no navegador — nenhum dado sai do cliente.

## Recursos

- Geração do payload EMV (BR Code) em JS puro, com CRC-16/CCITT.
- Valor fixo ou valor livre (pagador digita no app).
- Suporte a `txid`, nome do recebedor e cidade.
- Campo copia-e-cola e download da imagem do QR.

## Rodando local

Basta abrir o `index.html` no navegador. Não há dependências de build; a biblioteca de QR é carregada via CDN.

## Deploy (GitHub Pages)

O site é servido a partir da raiz (`index.html`). Em **Settings → Pages**, selecione a branch `main` e a pasta `/ (root)`.

## Observação técnica

Este gerador produz um **BR Code estático** (chave e valor embutidos no payload, `Point of Initiation Method = 11`). Para cobranças **dinâmicas** com `txid` rastreável no DICT, expiração e confirmação via webhook, é necessária integração com um PSP (ex.: Celcoin), que retorna a `location`/URL da cobrança.
