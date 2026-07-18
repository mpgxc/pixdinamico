# Gerador de QR Code PIX

Página estática, sem build, para gerar QR Code PIX (BR Code estático) com valor
customizado ou valor livre. Todo o processamento roda no navegador — nenhum dado
sai do cliente.

## Recursos

- Geração do payload EMV (BR Code) em JS puro, com CRC-16/CCITT.
- Valor fixo ou valor livre (pagador digita no app).
- Suporte a `txid`, nome do recebedor e cidade.
- Campo copia-e-cola e download da imagem do QR.

## Arquitetura

O código é organizado em módulos ES nativos (sem bundler), separados por
responsabilidade:

```
index.html              # markup semântico + <form>, sem lógica embutida
assets/
  styles.css            # estilos (extraídos do HTML)
src/
  domain/               # regras de negócio puras (sem DOM, testáveis)
    emv.js              #   codificação EMV/TLV
    crc16.js            #   checksum CRC-16/CCITT-FALSE
    sanitize.js         #   normalização de texto dos campos
    money.js            #   parsing e formatação de valores (BRL)
    pix.js              #   montagem do BR Code (compõe os módulos acima)
  qr/
    qr-renderer.js      # adapter isolando a lib de QR (global via CDN)
  ui/
    form.js             #   leitura e validação do formulário
    app.js              #   controlador: liga eventos e orquestra o fluxo
  main.js               # ponto de entrada
tests/
  domain.test.js        # testes de regressão do domínio (node --test)
```

Princípios aplicados: separação de responsabilidades (domínio puro isolado do
DOM), funções puras e testáveis, injeção da dependência externa por um adapter
(`qr-renderer`), constantes nomeadas no lugar de "números mágicos".

## Rodando local

Como o projeto usa módulos ES (`<script type="module">`), ele precisa ser
servido por **HTTP** — abrir o `index.html` direto pelo `file://` não funciona
(o navegador bloqueia o carregamento de módulos nessa origem). Suba qualquer
servidor estático na raiz do projeto:

```bash
# Node
npx serve .

# ou Python
python3 -m http.server 8080
```

Depois acesse `http://localhost:8080` (ajuste a porta conforme a ferramenta).

## Testes

O domínio (payload EMV, CRC-16, sanitização e parsing) é coberto por testes de
regressão que rodam com o test runner nativo do Node, sem dependências:

```bash
npm test
```

Os valores esperados foram capturados do algoritmo original antes da
refatoração, garantindo que o BR Code gerado permanece idêntico.

## Deploy (GitHub Pages)

O deploy é automatizado por GitHub Actions
(`.github/workflows/deploy-pages.yml`): a cada push na `main`, o workflow roda
os testes e, **só se eles passarem**, publica o site no GitHub Pages. Como o
Pages serve por HTTP, os módulos ES carregam normalmente.

Configuração única (uma vez): em **Settings → Pages**, defina
**Source = "GitHub Actions"** (no lugar de "Deploy from a branch"). A partir
daí, todo push na `main` publica automaticamente.

## Observação técnica

Este gerador produz um **BR Code estático** (chave e valor embutidos no payload,
`Point of Initiation Method = 11`). Para cobranças **dinâmicas** com `txid`
rastreável no DICT, expiração e confirmação via webhook, é necessária integração
com um PSP (ex.: Celcoin), que retorna a `location`/URL da cobrança.
