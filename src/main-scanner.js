/**
 * Ponto de entrada da página do leitor (`ler.html`).
 *
 * Cada página carrega só o que usa: o gerador não baixa o pipeline de visão
 * computacional, e o leitor não baixa a montagem do BR Code. Sem bundler, essa
 * separação é feita por ponto de entrada.
 */

import { initScanner } from './ui/scanner.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScanner, { once: true });
} else {
  initScanner();
}
