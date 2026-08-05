/**
 * Aproximação automática da câmera (auto zoom).
 *
 * O recorte ampliado (ver `warp`) espalha os pixels que já existem — ele
 * endireita e facilita a vida do decodificador, mas não inventa detalhe. Abaixo
 * de uns 3 pixels por módulo a informação simplesmente não está no sensor, e
 * ampliar não adianta. O zoom, sim, traz informação nova: é a única coisa que
 * transforma um QR longe demais num QR legível sem pedir para o usuário andar.
 *
 * Por isso o gatilho é preciso, e não um "aproxima até dar certo": só se
 * aproxima quando o símbolo **foi localizado mas não decodificado**. Nesse
 * momento sabemos exatamente o tamanho do módulo em pixels, então dá para
 * calcular de quanto é o zoom necessário em vez de tatear.
 *
 * Duas salvaguardas evitam o modo de falha clássico dessa funcionalidade:
 *
 * - **Não aproximar além do que cabe no quadro.** Um símbolo grande (muitos
 *   módulos) atinge o alvo de nitidez só quando já transbordou as bordas — e aí
 *   o localizador o perde, o campo reabre, ele reaparece, e o zoom entra em
 *   oscilação. O teto vem do próprio tamanho do símbolo.
 * - **Reabrir o campo sozinho.** Aproximado e sem achar nada, o usuário fica
 *   preso num campo estreito sem entender por quê. Depois de um tempo sem
 *   localizar nada, o zoom recua.
 *
 * Módulo puro: recebe a câmera por injeção (`apply`), então roda no Node.
 */

/**
 * Parâmetros da política de aproximação. Exportados porque são o *contrato*
 * observável do módulo — é por eles que se explica (e se testa) o comportamento.
 */
export const ZOOM_TUNING = Object.freeze({
  /**
   * Tamanho de módulo perseguido, em pixels do vídeo original. Acima de ~8px
   * por módulo a leitura sai direto do quadro, sem precisar nem do recorte.
   */
  TARGET_MODULE_PIXELS: 8,

  /** Ignora ajustes menores que isto — não vale sacudir a imagem por 10%. */
  MIN_CHANGE_RATIO: 1.15,

  /** Teto por ajuste. Aproximar em degraus deixa o laço se corrigir. */
  MAX_STEP_RATIO: 2,

  /** Quanto o campo reabre a cada recuo. */
  WIDEN_STEP_RATIO: 1.6,

  /** Tempo sem localizar nada antes de começar a reabrir o campo. */
  WIDEN_AFTER_MS: 1500,

  /** Intervalo mínimo entre dois ajustes: a lente leva tempo para responder. */
  ADJUST_COOLDOWN_MS: 500,
});

/**
 * @typedef {Object} ZoomRange
 * @property {number} min
 * @property {number} max
 * @property {number} step  `0` quando a câmera aceita valores contínuos.
 *
 * @typedef {Object} SymbolMetrics
 * @property {number} moduleSize     Módulo medido, em pixels do vídeo original.
 * @property {number} maxModuleSize  Módulo máximo que ainda cabe no quadro.
 */

/**
 * Nível de zoom necessário para o símbolo alcançar o tamanho alvo.
 *
 * @param {number} current Nível atual.
 * @param {SymbolMetrics} symbol
 * @param {ZoomRange|null} range
 * @returns {number|null} `null` quando não há ajuste que valha a pena.
 */
export function zoomToReach(current, symbol, range) {
  if (!range || !symbol || !(symbol.moduleSize > 0)) return null;

  // O alvo cede para o teto do quadro: de nada adianta um módulo nítido num
  // símbolo que não cabe mais na imagem.
  const ceiling = symbol.maxModuleSize > 0 ? symbol.maxModuleSize : Number.POSITIVE_INFINITY;
  const target = Math.min(ZOOM_TUNING.TARGET_MODULE_PIXELS, ceiling);
  if (symbol.moduleSize >= target) return null;

  const wanted = current * (target / symbol.moduleSize);
  const stepped = Math.min(wanted, current * ZOOM_TUNING.MAX_STEP_RATIO);
  const next = snapToRange(stepped, range);

  return next / current >= ZOOM_TUNING.MIN_CHANGE_RATIO ? next : null;
}

/**
 * Próximo nível ao reabrir o campo.
 *
 * @param {number} current
 * @param {ZoomRange|null} range
 * @returns {number|null} `null` quando já está totalmente aberto.
 */
export function zoomToWiden(current, range) {
  if (!range || current <= range.min) return null;

  const next = snapToRange(current / ZOOM_TUNING.WIDEN_STEP_RATIO, range);
  return next < current ? next : null;
}

/**
 * Cria o controlador de aproximação para uma sessão de câmera.
 *
 * A câmera entra por injeção: `range` descreve o que ela aceita e `apply`
 * efetiva a mudança. Assim a política fica testável sem navegador, e a página
 * do leitor não precisa saber nada sobre `applyConstraints`.
 *
 * @param {Object} options
 * @param {ZoomRange|null} options.range   `null` se a câmera não tem zoom.
 * @param {(value: number) => Promise<boolean>} options.apply
 * @param {number} [options.initial]       Nível em que a câmera já está.
 * @param {() => number} [options.now]     Relógio (injetável para teste).
 */
export function createZoomController({ range, apply, initial, now = defaultNow }) {
  const supported = Boolean(range);
  let level = clampInitial(initial, range);
  let lastChangeAt = Number.NEGATIVE_INFINITY;
  let missingSince = null;
  let applying = false;

  /** Efetiva um nível, respeitando a espera entre ajustes. */
  async function change(next) {
    if (next === null || applying) return false;
    if (now() - lastChangeAt < ZOOM_TUNING.ADJUST_COOLDOWN_MS) return false;

    applying = true;
    try {
      if (!(await apply(next))) return false;
      level = next;
      lastChangeAt = now();
      return true;
    } finally {
      applying = false;
    }
  }

  return {
    /** A câmera aceita zoom? */
    get supported() {
      return supported;
    },
    /** Nível atual. */
    get level() {
      return level;
    },
    /** Nível mínimo (campo totalmente aberto). */
    get min() {
      return range?.min ?? level;
    },

    /**
     * Símbolo localizado e ainda não lido: aproxima se estiver pequeno demais.
     *
     * @param {SymbolMetrics} symbol
     * @returns {Promise<boolean>} `true` se o zoom mudou.
     */
    async onLocated(symbol) {
      missingSince = null;
      if (!supported) return false;
      return change(zoomToReach(level, symbol, range));
    },

    /**
     * Nada localizado neste quadro. Reabre o campo se isso já dura tempo
     * demais — a contagem é por tempo, e não por quadros, para não depender da
     * taxa de análise.
     *
     * @returns {Promise<boolean>} `true` se o zoom mudou.
     */
    async onMissed() {
      if (!supported || level <= range.min) return false;

      const instant = now();
      if (missingSince === null) missingSince = instant;
      if (instant - missingSince < ZOOM_TUNING.WIDEN_AFTER_MS) return false;

      const changed = await change(zoomToWiden(level, range));
      if (changed) missingSince = instant;
      return changed;
    },

    /** Leitura concluída: o zoom cumpriu o papel, zera a contagem. */
    onDecoded() {
      missingSince = null;
    },
  };
}

/** Encaixa o valor no intervalo e no passo aceitos pela câmera. */
function snapToRange(value, { min, max, step }) {
  const clamped = Math.min(max, Math.max(min, value));
  if (!(step > 0)) return round(clamped);

  const snapped = min + Math.round((clamped - min) / step) * step;
  return round(Math.min(max, Math.max(min, snapped)));
}

/** Passos fracionários acumulam lixo binário; 4 casas bastam para uma lente. */
function round(value) {
  return Number(value.toFixed(4));
}

function clampInitial(initial, range) {
  if (!range) return initial > 0 ? initial : 1;
  if (!(initial > 0)) return range.min;
  return Math.min(range.max, Math.max(range.min, initial));
}

function defaultNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
