/**
 * Localização do símbolo num quadro da câmera.
 *
 * Compõe as etapas puras — plano Y -> luminância reduzida -> binarização ->
 * finder patterns -> quadrilátero — e devolve o que a aproximação automática
 * precisa saber: onde o símbolo está e quantos pixels do sensor cada módulo
 * ocupa.
 *
 * Roda dentro do frame processor, na thread de worklets: o quadro não é
 * copiado para a thread de JS e a UI não trava enquanto a análise acontece.
 */

import { binarize } from './binarize.ts';
import { findFinderPatterns, measureModuleSize, selectFinderTriple } from './finder.ts';
import type { Point } from './geometry.ts';
import { yPlaneToLuma } from './luma.ts';
import { estimateSymbolQuad } from './quad.ts';

/**
 * Larguras da imagem de trabalho, tentadas nesta ordem.
 *
 * Duas, e não uma, porque o ponto cego do localizador é **fase de aliasing**, e
 * não resolução: medindo um mesmo símbolo a 4px por módulo no sensor, a redução
 * para 960px o faz sumir enquanto a redução para 640px — que preserva *menos*
 * detalhe — o encontra sem esforço. Razões de redução diferentes erram em
 * lugares diferentes, então uma cobre o ponto cego da outra.
 *
 * A segunda passagem custa ~5ms e só acontece quando a primeira não confirmou
 * nada.
 */
export const WORK_WIDTHS = [960, 640];

/**
 * Fração da largura do quadro que o símbolo pode ocupar. Serve de teto para a
 * aproximação: passar disso é perder o símbolo pelas bordas quando a mão tremer.
 */
const MAX_FRAME_FILL = 0.8;

/** Zona de silêncio considerada ao calcular o teto (a norma pede 4 módulos). */
const QUIET_ZONE_MODULES = 4;

/**
 * O que a análise de um quadro concluiu.
 *
 * O estado `partial` é o que torna a aproximação automática capaz de sair do
 * lugar. Confirmar os três finder patterns exige uns 3 pixels por módulo; abaixo
 * disso a confirmação falha, mas um ou dois candidatos ainda aparecem. E como as
 * verificações cruzadas (vertical, horizontal e diagonal) praticamente não
 * produzem falso positivo — uma cena sem QR devolve zero candidatos —, qualquer
 * candidato é evidência de que há um símbolo ali, pequeno demais para medir.
 *
 * Sem esse meio-termo restaria varrer o zoom às cegas, que é justamente o que
 * não queremos: a câmera ficaria aproximando e afastando sozinha apontada para
 * o nada.
 */
export type LocateResult =
  | ({ kind: 'symbol' } & LocatedSymbol)
  | { kind: 'partial'; candidates: number }
  | { kind: 'none' };

export type LocatedSymbol = {
  /** Cantos no espaço da imagem de trabalho, em ordem horária a partir do topo-esquerda. */
  corners: Point[];
  /** Dimensões da imagem de trabalho, para converter os cantos para a tela. */
  work: { width: number; height: number };
  /** Tamanho do módulo em pixels do quadro original — a unidade do zoom. */
  moduleSize: number;
  /** Maior módulo que ainda mantém o símbolo dentro do quadro. */
  maxModuleSize: number;
  /** Dimensão do símbolo, em módulos. */
  modules: number;
};

/**
 * Procura um QR Code no plano Y de um quadro, tentando cada razão de redução
 * até confirmar um símbolo.
 */
export function locateSymbol(
  plane: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
): LocateResult {
  'worklet';
  let bestPartial = 0;

  for (let i = 0; i < WORK_WIDTHS.length; i += 1) {
    const result = locateAt(plane, width, height, bytesPerRow, WORK_WIDTHS[i]);
    if (result.kind === 'symbol') return result;
    if (result.kind === 'partial' && result.candidates > bestPartial) {
      bestPartial = result.candidates;
    }
  }

  return bestPartial > 0 ? { kind: 'partial', candidates: bestPartial } : { kind: 'none' };
}

/** Uma passagem de busca, numa razão de redução específica. */
function locateAt(
  plane: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  workWidth: number,
): LocateResult {
  'worklet';
  const luma = yPlaneToLuma(plane, width, height, bytesPerRow, workWidth);
  const binary = binarize(luma);

  const candidates = findFinderPatterns(binary, luma.width, luma.height);
  const patterns = selectFinderTriple(candidates);
  if (!patterns) {
    return candidates.length > 0
      ? { kind: 'partial', candidates: candidates.length }
      : { kind: 'none' };
  }

  const measured = measureModuleSize(binary, luma.width, luma.height, patterns);
  const quad = estimateSymbolQuad(patterns, measured);

  // A imagem de trabalho é uma redução do quadro; o zoom age sobre o sensor,
  // então o módulo precisa voltar para a escala original.
  const toSource = width / luma.width;

  return {
    kind: 'symbol',
    corners: quad.corners,
    work: { width: luma.width, height: luma.height },
    moduleSize: quad.moduleSize * toSource,
    maxModuleSize: (MAX_FRAME_FILL * width) / (quad.modules + 2 * QUIET_ZONE_MODULES),
    modules: quad.modules,
  };
}
