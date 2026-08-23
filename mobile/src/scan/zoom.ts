/**
 * Política de aproximação automática.
 *
 * O gatilho é preciso, e não um "aproxima até dar certo": só se aproxima quando
 * o símbolo foi **localizado mas não decodificado**. Nesse momento o tamanho do
 * módulo é conhecido, então o fator necessário é calculado em vez de tateado.
 *
 * A política é um **redutor puro**: recebe o estado e um evento, devolve o
 * próximo estado. Não é preciosismo — no frame processor o código roda numa
 * thread de worklets, onde closures são capturadas por valor a cada quadro e
 * qualquer estado guardado dentro delas se perderia. Estado explícito é o que
 * funciona lá, e de quebra torna toda a máquina testável no Node.
 */

export type ZoomRange = {
  min: number;
  max: number;
  /** `0` quando a câmera aceita valores contínuos. */
  step: number;
};

export type SymbolMetrics = {
  /** Módulo medido, em pixels do quadro original. */
  moduleSize: number;
  /** Módulo máximo que ainda mantém o símbolo dentro do quadro. */
  maxModuleSize: number;
};

export type ZoomState = {
  level: number;
  /** Instante do último ajuste aceito. */
  lastChangeAt: number;
  /** Desde quando nada é localizado; `null` quando algo foi visto. */
  missingSince: number | null;
};

export type ZoomEvent =
  /** Símbolo confirmado e medido: dá para calcular o zoom exato. */
  | { type: 'located'; symbol: SymbolMetrics }
  /** Há estrutura de QR na cena, pequena demais para confirmar e medir. */
  | { type: 'partial' }
  /** Nada de QR na cena. */
  | { type: 'missing' };

/**
 * Parâmetros da política. Exportados porque são o *contrato* observável do
 * módulo — é por eles que se explica (e se testa) o comportamento.
 */
export const ZOOM_TUNING = {
  /**
   * Tamanho de módulo perseguido, em pixels do quadro. Acima de ~8px por módulo
   * qualquer decodificador lê sem esforço.
   */
  TARGET_MODULE_PIXELS: 8,
  /** Ignora ajustes menores que isto — não vale sacudir a imagem por 10%. */
  MIN_CHANGE_RATIO: 1.15,
  /** Teto por ajuste. Aproximar em degraus deixa o laço se corrigir. */
  MAX_STEP_RATIO: 2,
  /** Quanto o campo reabre a cada recuo. */
  WIDEN_STEP_RATIO: 1.6,
  /** Passo da aproximação exploratória, quando só há detecção parcial. */
  EXPLORE_STEP_RATIO: 1.6,
  /**
   * Teto da exploração, como múltiplo do zoom mínimo. Sem medida do símbolo não
   * há como saber quanto falta, e além disso o campo fica tão estreito que
   * enquadrar vira sorte — melhor parar e deixar o usuário aproximar.
   */
  EXPLORE_MAX_FACTOR: 4,
  /** Tempo sem localizar nada antes de começar a reabrir o campo. */
  WIDEN_AFTER_MS: 1500,
  /** Intervalo mínimo entre ajustes: a lente leva tempo para responder. */
  ADJUST_COOLDOWN_MS: 500,
} as const;

/** Estado inicial, com o campo totalmente aberto. */
export function initialZoomState(range: ZoomRange | null): ZoomState {
  'worklet';
  return {
    level: range ? range.min : 1,
    lastChangeAt: Number.NEGATIVE_INFINITY,
    missingSince: null,
  };
}

/**
 * Avança a máquina de estados.
 *
 * Compare `next.level` com `state.level` para saber se a câmera precisa ser
 * ajustada — o redutor não toca em hardware.
 */
export function reduceZoom(
  state: ZoomState,
  event: ZoomEvent,
  range: ZoomRange | null,
  now: number,
): ZoomState {
  'worklet';
  if (event.type === 'located') {
    const settled = { ...state, missingSince: null };
    if (!range) return settled;
    return commit(settled, zoomToReach(state.level, event.symbol, range), now);
  }

  // Detecção parcial: sabemos que há um QR, mas não o tamanho dele. Aproxima em
  // degraus fixos até o teto de exploração — é o que tira o laço do lugar
  // quando o símbolo é pequeno demais para ser medido.
  if (event.type === 'partial') {
    const settled = { ...state, missingSince: null };
    if (!range) return settled;
    return commit(settled, zoomToExplore(state.level, range), now);
  }

  // Nada localizado. A contagem é por tempo, e não por quadros, para não
  // depender da taxa de análise — que varia com a carga do aparelho.
  if (!range || state.level <= range.min) return state;

  const missingSince = state.missingSince === null ? now : state.missingSince;
  if (now - missingSince < ZOOM_TUNING.WIDEN_AFTER_MS) return { ...state, missingSince };

  const widened = commit({ ...state, missingSince }, zoomToWiden(state.level, range), now);
  return widened.level === state.level ? widened : { ...widened, missingSince: now };
}

/** Aplica um nível novo respeitando a espera entre ajustes. */
function commit(state: ZoomState, next: number | null, now: number): ZoomState {
  'worklet';
  if (next === null) return state;
  if (now - state.lastChangeAt < ZOOM_TUNING.ADJUST_COOLDOWN_MS) return state;
  return { ...state, level: next, lastChangeAt: now };
}

/**
 * Próximo degrau da aproximação exploratória.
 *
 * @returns `null` quando o teto de exploração já foi alcançado.
 */
export function zoomToExplore(current: number, range: ZoomRange | null): number | null {
  'worklet';
  if (!range) return null;

  const ceiling = Math.min(range.max, range.min * ZOOM_TUNING.EXPLORE_MAX_FACTOR);
  if (current >= ceiling) return null;

  const next = snapToRange(
    Math.min(current * ZOOM_TUNING.EXPLORE_STEP_RATIO, ceiling),
    range,
  );
  return next > current ? next : null;
}

/**
 * Nível necessário para o símbolo alcançar o tamanho alvo.
 *
 * @returns `null` quando não há ajuste que valha a pena.
 */
export function zoomToReach(
  current: number,
  symbol: SymbolMetrics,
  range: ZoomRange | null,
): number | null {
  'worklet';
  if (!range || !(symbol.moduleSize > 0)) return null;

  // O alvo cede para o teto do quadro: de nada adianta um módulo nítido num
  // símbolo que não cabe mais na imagem.
  const ceiling =
    symbol.maxModuleSize > 0 ? symbol.maxModuleSize : Number.POSITIVE_INFINITY;
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
 * @returns `null` quando já está totalmente aberto.
 */
export function zoomToWiden(current: number, range: ZoomRange | null): number | null {
  'worklet';
  if (!range || current <= range.min) return null;

  const next = snapToRange(current / ZOOM_TUNING.WIDEN_STEP_RATIO, range);
  return next < current ? next : null;
}

/** Encaixa o valor no intervalo e no passo aceitos pela câmera. */
function snapToRange(value: number, range: ZoomRange): number {
  'worklet';
  const clamped = Math.min(range.max, Math.max(range.min, value));
  if (!(range.step > 0)) return round(clamped);

  const snapped = range.min + Math.round((clamped - range.min) / range.step) * range.step;
  return round(Math.min(range.max, Math.max(range.min, snapped)));
}

/** Passos fracionários acumulam lixo binário; 4 casas bastam para uma lente. */
function round(value: number): number {
  'worklet';
  return Number(value.toFixed(4));
}
