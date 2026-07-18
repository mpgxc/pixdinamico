/**
 * Ponto de entrada da aplicação (carregado como `<script type="module">`).
 *
 * Scripts de módulo são `defer` por padrão, então normalmente o DOM já está
 * pronto; ainda assim, tratamos o caso de o documento ainda estar carregando.
 */

import { init } from './ui/app.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
