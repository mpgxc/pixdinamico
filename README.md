# QR Code PIX

Site estático, sem build, para **gerar** QR Code PIX (BR Code estático) e
**ler** um código já existente com a câmera. Todo o processamento roda no
navegador — nenhum dado sai do cliente.

São três páginas:

| Página       | O que faz                                                       |
|--------------|-----------------------------------------------------------------|
| `index.html` | escolha entre gerar e ler                                       |
| `gerar.html` | formulário, BR Code, copia-e-cola e download da imagem          |
| `ler.html`   | leitor com câmera ao vivo                                       |

Cada uma carrega só o seu ponto de entrada: o gerador não baixa o pipeline de
visão computacional, e o leitor não baixa a montagem do BR Code.

## Recursos

- Geração do payload EMV (BR Code) em JS puro, com CRC-16/CCITT.
- Valor fixo ou valor livre (pagador digita no app).
- Suporte a `txid`, nome do recebedor e cidade.
- Campo copia-e-cola e download da imagem do QR.
- **Leitor com câmera ao vivo**: localiza o QR no quadro, recorta, amplia e
  decodifica (ver [Leitura por câmera](#leitura-por-câmera)).

## Arquitetura

O código é organizado em módulos ES nativos (sem bundler), separados por
responsabilidade:

```
index.html              # página de escolha (só markup e CSS)
gerar.html              # markup semântico + <form>, sem lógica embutida
ler.html                # markup do leitor
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
  scan/                 # leitura por câmera (visão computacional pura + adapters)
    luma.js             #   RGBA <-> luminância de 8 bits
    binarize.js         #   limiar adaptativo por blocos
    geometry.js         #   distância, vetor unitário, centroide
    finder.js           #   busca dos finder patterns (proporção 1:1:3:1:1)
    quad.js             #   finder patterns -> quadrilátero do símbolo
    warp.js             #   recorte com correção de perspectiva + upscale
    decoder.js          #   adapter: BarcodeDetector nativo -> jsQR (fallback)
    camera.js           #   getUserMedia, laço de quadros, lanterna
    pipeline.js         #   orquestra localizar -> recortar -> ampliar -> decodificar
  ui/
    form.js             #   leitura e validação do formulário
    app.js              #   controlador: liga eventos e orquestra o fluxo
    scanner.js          #   controlador da página do leitor
  main.js               # ponto de entrada do gerador
  main-scanner.js       # ponto de entrada do leitor
tests/
  domain.test.js        # testes de regressão do domínio (node --test)
  scan.test.js          # testes do pipeline de leitura (símbolos sintéticos)
```

Princípios aplicados: separação de responsabilidades (domínio puro isolado do
DOM), funções puras e testáveis, injeção da dependência externa por um adapter
(`qr-renderer`), constantes nomeadas no lugar de "números mágicos".

## Leitura por câmera

O leitor não fica só chamando um decodificador a cada quadro. O caminho direto
funciona quando o QR está grande e bem enquadrado; quando não está — código
pequeno, impresso, na tela de outra pessoa, de lado — decodificar o quadro
inteiro falha, e insistir não adianta. O pipeline então muda de estratégia:

1. **Quadro reduzido** — o vídeo é desenhado num canvas de 640px. Varrer aí em
   vez da resolução nativa corta o custo em ~9x.
2. **Tentativa direta** — decodifica o quadro inteiro. Se ler, acabou.
3. **Localização** — falhando, binariza (limiar adaptativo por blocos, que
   aguenta sombra e gradiente) e procura os três *finder patterns* pela
   assinatura 1:1:3:1:1, com verificação cruzada na vertical, na horizontal e na
   diagonal. Isso responde *"tem um QR aí?"* sem decodificar nada.
4. **Snapshot** — achado o símbolo, o quadro é capturado de novo em resolução
   cheia: é dele que sai o detalhe que o quadro reduzido jogou fora.
5. **Recorte + upscale** — o quadrilátero do símbolo é projetado sobre um
   quadrado com ~6px por módulo, o que endireita a perspectiva e amplia numa
   única reamostragem bilinear.
6. **Decodificação do recorte** — agora sobre uma imagem pequena, reta e com
   resolução de sobra. Se ainda falhar, repete uma vez com o recorte binarizado.

O passo 3 é o que separa *"não tem QR na cena"* de *"tem, mas não deu para
ler"* — sem essa distinção, ampliar seria chute.

Se a busca no quadro reduzido não achar nada, ela é repetida uma vez num quadro
de 960px: a assinatura 1:1:3:1:1 precisa de uns 3 pixels por módulo para
sobreviver à redução, e abaixo disso o *aliasing* apaga as faixas finas de um
símbolo que continua nítido no original. A busca não escala além disso de
propósito — varrer em resolução cheia acharia símbolos ainda menores, mas
custaria ~35ms por passagem *enquanto não há nada na cena*.

Medido de ponta a ponta (Chromium com câmera falsa, QR de 49 módulos girado
num quadro 1280x720): acima de ~8px por módulo a leitura sai direta do quadro;
entre ~3 e ~6px por módulo ela só acontece pelo recorte ampliado; abaixo de
~2,5px por módulo na imagem original o símbolo não é mais localizável e a saída
correta é aproximar a câmera.

Dois detalhes que valem menção, porque são erros silenciosos fáceis de cometer:

- **Rotação infla a medida do módulo.** As faixas 1:1:3:1:1 são medidas em
  varreduras horizontais; com o símbolo girado θ, cada faixa é atravessada na
  diagonal e mede `módulo / cos θ` — até 41% a mais. O tamanho do módulo é então
  remedido *ao longo do eixo do símbolo* (`measureModuleSize`), que é invariante
  à rotação, e a dimensão resultante é encaixada numa dimensão que exista de
  fato (`17 + 4 x versão`).
- **A zona de silêncio pode não estar no quadro.** Se o QR encosta na borda,
  amostrar fora da imagem devolve branco em vez de replicar a borda — o recorte
  sai com a zona de silêncio sintetizada, em vez de com módulos falsos.

A decodificação em si usa `BarcodeDetector` (API nativa) quando disponível e cai
para o `jsQR`, carregado sob demanda por `import()` dinâmico, no Firefox e em
Safari antigos. Nenhuma imagem sai do dispositivo.

A câmera nunca liga sozinha ao abrir a página — exige um clique, e é solta
assim que a leitura termina ou a página é abandonada.

> A câmera exige **contexto seguro**: HTTPS ou `localhost`. Em `http://` de rede
> local o navegador nem oferece a permissão.

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
O leitor precisa de `localhost` ou HTTPS para a câmera funcionar — servir por IP
de rede local (`http://192.168.x.x`) não basta.

## Testes

O domínio (payload EMV, CRC-16, sanitização e parsing) é coberto por testes de
regressão que rodam com o test runner nativo do Node, sem dependências:

```bash
npm test
```

Os valores esperados foram capturados do algoritmo original antes da
refatoração, garantindo que o BR Code gerado permanece idêntico.

O pipeline de leitura também é coberto sem navegador nem câmera: as etapas de
visão computacional são funções puras sobre buffers, então os testes sintetizam
um símbolo com finder patterns em posições conhecidas, rasterizam com a rotação
desejada e conferem se a localização, a dimensão estimada e o recorte ampliado
reproduzem exatamente o que foi desenhado.

## Deploy (GitHub Pages)

O deploy é automatizado por GitHub Actions
(`.github/workflows/deploy-pages.yml`): a cada push na `main`, o workflow roda
os testes e, **só se eles passarem**, publica as três páginas no GitHub Pages. Como o
Pages serve por HTTP, os módulos ES carregam normalmente.

Configuração única (uma vez): em **Settings → Pages**, defina
**Source = "GitHub Actions"** (no lugar de "Deploy from a branch"). A partir
daí, todo push na `main` publica automaticamente.

## Observação técnica

Este gerador produz um **BR Code estático** (chave e valor embutidos no payload,
`Point of Initiation Method = 11`). Para cobranças **dinâmicas** com `txid`
rastreável no DICT, expiração e confirmação via webhook, é necessária integração
com um PSP (ex.: Celcoin), que retorna a `location`/URL da cobrança.
