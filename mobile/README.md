# QR AutoZoom

App React Native (Expo) que lê QR Code e **aproxima a lente sozinho** quando o
código está pequeno demais para ser lido.

## O problema

Um decodificador só devolve alguma coisa quando consegue ler o símbolo inteiro.
Isso significa que ele não sabe distinguir dois casos muito diferentes:

- não há QR nenhum na cena;
- há um QR, mas está longe demais para ser lido.

Sem essa distinção, aproximar seria chute — a câmera ficaria dando zoom apontada
para o nada. É por isso que o app não usa só o decodificador.

## Como funciona

Duas saídas da câmera trabalham no mesmo quadro:

| Saída | Papel |
|---|---|
| `useObjectOutput` | decodifica QR nativamente (Vision no iOS, ML Kit no Android) |
| `useFrameOutput` | roda o **localizador** em JS, na thread de worklets |

O localizador não decodifica nada. Ele procura os três *finder patterns* — os
quadrados-alvo dos cantos, a estrutura mais grossa e mais redundante do símbolo
— pela assinatura de proporção 1:1:3:1:1, com verificação cruzada na vertical,
na horizontal e na diagonal. Com eles responde o que o decodificador não sabe
dizer: *há um QR aqui, e cada módulo dele ocupa N pixels do sensor.*

Sabendo N, o fator de zoom é **calculado**, não tateado:

> módulo de 4px, alvo de 8px → exatamente 2×

O ajuste vai em degraus (no máximo o dobro por vez), com espera entre eles, e o
laço se corrige a cada nova medição.

### Três estados, três respostas

O localizador não devolve só "achei" ou "não achei":

| Estado | O que significa | Resposta |
|---|---|---|
| `symbol` | três finder patterns confirmados | zoom calculado a partir da medida |
| `partial` | há candidatos, mas o trio não fecha | degrau exploratório de 1,6× |
| `none` | nada de QR na cena | reabre o campo aos poucos |

O estado `partial` é o que tira o laço do lugar. Confirmar os três finder
patterns exige uns 3 pixels por módulo; abaixo disso a confirmação falha, mas um
ou dois candidatos ainda aparecem. E como as verificações cruzadas praticamente
não produzem falso positivo — **uma cena sem QR devolve zero candidatos**, o que
é verificado por teste —, qualquer candidato é evidência de que há um símbolo
ali, pequeno demais para medir. Sem esse meio-termo restaria varrer o zoom às
cegas.

### Duas salvaguardas

- **Teto de enquadramento.** Um símbolo com muitos módulos só atingiria o alvo
  de nitidez depois de transbordar as bordas — aí o localizador o perde, o campo
  reabre, ele reaparece, e o zoom oscila. O teto sai do próprio tamanho do
  símbolo, não de um chute.
- **Reabertura sozinha.** Aproximado e sem achar nada por 1,5s, o campo volta a
  abrir. A contagem é por **tempo**, não por quadros, para não depender da taxa
  de análise, que varia com a carga do aparelho.

## Estrutura

```
src/
  scan/                 # visão computacional pura — sem React, sem câmera
    luma.ts             #   plano Y -> luminância reduzida (respeita bytesPerRow)
    binarize.ts         #   limiar adaptativo por blocos
    geometry.ts         #   distância e vetor unitário
    finder.ts           #   busca dos finder patterns (1:1:3:1:1)
    quad.ts             #   finder patterns -> quadrilátero e dimensão
    locate.ts           #   compõe as etapas acima num LocateResult
    zoom.ts             #   política de aproximação (redutor puro)
    symbol.fixture.ts   #   gerador de símbolos sintéticos (só testes)
  camera/
    steer.ts            # ponte política -> câmera, na thread de worklets
    useAutoZoom.ts      # estado da sessão em SharedValues
  ui/
    ScannerScreen.tsx   # tela, mira e resultado
```

Duas decisões de projeto que valem o comentário:

**A política é um redutor puro** (`reduceZoom(estado, evento) -> estado`), e não
um objeto com estado interno. No frame processor as closures são capturadas por
valor a cada quadro, então qualquer estado guardado dentro delas se perderia.
Estado explícito é o que funciona lá — e de quebra torna a máquina inteira
testável no Node.

**O plano Y é a luminância.** Pedindo `pixelFormat: 'yuv'`, o primeiro plano do
quadro já é exatamente o que o localizador precisa: nada de converter RGBA pixel
a pixel. O cuidado obrigatório é o `bytesPerRow` — a câmera alinha cada linha, e
tratar esse alinhamento como pixel inclina a imagem inteira progressivamente.

## Rodando

O app usa código nativo (VisionCamera), então **não roda no Expo Go**. Precisa de
um *development build*:

```bash
npm install
npx expo prebuild        # gera android/ e ios/
npm run android          # ou: npm run ios
```

Depois do primeiro build, `npm start` já basta.

## Build do APK

O projeto nativo (`android/`, `ios/`) **não é versionado** — quem o produz é o
`expo prebuild`, a partir de `app.json` e das dependências. Isso significa que o
que a esteira constrói é exatamente o que o repositório descreve, sem projeto
nativo ajustado à mão que ninguém consegue reproduzir.

O workflow `.github/workflows/apk.yml` (na raiz do repo) roda testes, gera o
projeto nativo, constrói o APK e o publica como artefato. Dispara de dois jeitos:

- **manualmente**, pela aba Actions, com escolha entre `release` e `debug`;
- **por tag** `v*`, que além do artefato cria a Release e anexa o APK.

Localmente:

```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
# saída: android/app/build/outputs/apk/release/app-release.apk
```

### Arquiteturas

O padrão são as duas arquiteturas ARM. Incluir `x86` e `x86_64` praticamente
dobra o APK — de 57MB para 109MB — e elas só servem a emuladores, que não são
onde se testa um app de câmera. Quem precisar delas escolhe na hora de disparar
o workflow.

O peso vem quase todo do código nativo: `libreactnative.so` e `libVisionCamera.so`
sozinhas passam de 12MB **por arquitetura**. O bundle JS, comparado a isso, são
2,1MB de bytecode Hermes.

### Assinatura

Sem segredos configurados, o template do React Native assina o release **com a
chave de debug**. O APK instala e roda — serve para testar e distribuir
internamente —, mas não serve para publicação em loja. O workflow declara isso
no nome do artefato e no resumo da execução, em vez de deixar a descoberta para
depois.

Para assinar de verdade, defina quatro segredos no repositório:

| Segredo | Conteúdo |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | a keystore em base64 (`base64 -w0 release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | senha da keystore |
| `ANDROID_KEY_ALIAS` | alias da chave |
| `ANDROID_KEY_PASSWORD` | senha da chave |

Com eles presentes, a assinatura entra pela API de *injected signing* do Android
Gradle Plugin — sem editar o `build.gradle` que o prebuild acabou de gerar, que
seria justamente o tipo de remendo que quebra em silêncio na próxima geração.

## Testes

```bash
npm test        # pipeline de visão + checagem de worklets
npm run typecheck
```

O pipeline é pura função sobre buffers, então roda no Node sem câmera nem
aparelho. Os testes sintetizam um símbolo, rasterizam num plano Y **com
alinhamento de linha e lixo no padding**, e conferem o que sai.

Vale destacar dois:

- **`autozoom.test.ts` fecha o laço.** Localiza, decide o zoom, re-rasteriza o
  símbolo na escala correspondente (aproximar a lente multiplica o tamanho
  aparente, que é a grandeza que fecha o laço) e repete. É o teste que responde
  *"converge, e em quantos passos?"* sem depender de um aparelho. Converge em 2
  a 3 passos partindo de 1,75px por módulo.
- **`scripts/check-worklets.mjs`.** Compara, arquivo a arquivo, quantas funções
  estão marcadas com `'worklet'` no fonte e quantas o Babel realmente
  transformou. Uma função esquecida compila, empacota, passa no typecheck — e
  quebra no primeiro quadro da câmera. Hoje são 43 funções confirmadas.

### O que **não** foi verificado

Não houve aparelho nesta implementação. O que está comprovado é: os 29 testes do
pipeline, o typecheck contra as tipagens reais do VisionCamera 5.2.3, a
transformação dos worklets, e o empacotamento pelo Metro (1088 módulos).

O que só um aparelho responde:

- **Custo real do localizador por quadro.** No Node é ~11ms; em Hermes, num
  celular, deve ser algumas vezes mais. A análise é limitada a uma a cada 250ms
  justamente por isso, mas o número real ainda não foi medido.
- **`useObjectOutput` no Android.** A tipagem declara implementação Kotlin, mas
  parte da documentação da API marca os objetos escaneados como iOS.
- **Orientação do quadro.** O localizador só usa tamanhos, então rotação de
  sensor não deveria afetá-lo — mas isso não foi confirmado em hardware.

Por isso a mira central é fixa e o contorno exato do símbolo **não** é desenhado:
converter coordenadas do quadro para a tela envolve o recorte do preview e a
rotação do sensor, que variam por aparelho. Um contorno desalinhado informa pior
que nenhum.

## Compatibilidade

A aproximação automática depende de a câmera expor zoom controlável
(`device.minZoom`/`maxZoom`). Quando não expõe, o app continua lendo
normalmente — só sem aproximar. É sempre um bônus, nunca um pré-requisito.
