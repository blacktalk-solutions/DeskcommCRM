/**
 * O TEMPO QUE UMA PESSOA LEVA PARA RESPONDER — e por que ele é feature.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O agente responde no instante em que o modelo termina de gerar. Do lado do
 * cliente, no WhatsApp, isso é inconfundível: a resposta chega junto com o "✓✓"
 * da mensagem que ele acabou de mandar. Nenhum atendente humano lê, pensa e
 * digita um parágrafo em 200ms — e o cliente sabe disso. Reportado pelo dono de
 * um tenant real (sítio de eventos): "responde rápido demais, parece robô".
 *
 * O produto é um agente que ATENDE junto com humanos. Ser identificável como
 * máquina na primeira troca é perda de conversão, não detalhe estético.
 *
 * ─── A fórmula, e por que estes números ─────────────────────────────────────
 *
 *   atraso = clamp(NOTAR + POR_CARACTERE × comprimento, MINIMO, MAXIMO)
 *
 * `NOTAR` (900ms) é a parcela que NÃO depende do texto: ver a notificação,
 * abrir a conversa, ler o que o cliente escreveu. Ela existe separada do termo
 * proporcional porque mesmo um "Sim!" tem esse custo — sem ela, respostas
 * curtas voltariam a sair instantâneas, que é exatamente o defeito.
 *
 * `POR_CARACTERE` (22ms ≈ 45 caracteres/s) é digitação DELIBERADAMENTE mais
 * rápida que a real (um bom digitador faz ~8 c/s no celular). Não é erro de
 * calibração: em velocidade real, um parágrafo de 400 caracteres pediria 50
 * segundos, e um cliente esperando 50s conclui que ninguém vai responder.
 * O objetivo é "não é instantâneo", não "é indistinguível de humano" — a
 * segunda meta custa o atendimento.
 *
 * `MINIMO` (1200ms) é o piso do throttle anti-ban do canal (CLAUDE.md: 1 msg /
 * 1.2s). Um atraso "humano" menor que o piso que o anti-ban já impõe seria
 * decoração que não muda nada. `MAXIMO` (7500ms) é o teto: acima disso o
 * silêncio deixa de ler como "está digitando" e passa a ler como "caiu".
 *
 * ─── Onde ele NÃO entra ─────────────────────────────────────────────────────
 *
 * Este atraso é do TURNO, antes da PRIMEIRA bolha. O intervalo ENTRE bolhas
 * continua sendo o jitter anti-ban (1.2s + ≤800ms) que já existia — são coisas
 * diferentes com donos diferentes, e somá-las numa só apagaria o throttle que
 * protege o número de banimento.
 *
 * ─── Configurável por agente (issue #5) ─────────────────────────────────────
 *
 * Os quatro números eram constantes fixas — o dono de uma organização não
 * tinha como ajustar, só editando este arquivo e reconstruindo a imagem.
 * `ai_agent_versions.human_delay_*` (migration 0233) guarda o override por
 * agente publicado; `null` em qualquer um dos quatro usa a constante daqui.
 * As constantes continuam sendo o DEFAULT e o fallback — não algo que este
 * arquivo pare de possuir.
 */
import type { Logger } from '../obs/logger';

/** Ver o cabeçalho: a parcela que não depende do tamanho do texto. */
export const ATRASO_NOTAR_MS = 900;

/** ≈45 caracteres/s — rápido de propósito; ver o cabeçalho. */
export const MS_POR_CARACTERE = 22;

/** Piso do throttle anti-ban do canal (CLAUDE.md). Abaixo dele o atraso não significa nada. */
export const ATRASO_MINIMO_MS = 1200;

/** Acima disto o silêncio lê como queda, não como digitação. */
export const ATRASO_MAXIMO_MS = 7500;

/**
 * Override por agente (issue #5) — todo campo omitido ou `null` cai na
 * constante correspondente. Vem de `ai_agent_versions.human_delay_*`; quem
 * monta este objeto (inbound-turn.ts, a partir de `agentConfig`) já recebeu
 * os valores validados pelas CHECK constraints da coluna (>= 0, min <= max).
 */
export interface ConfigDeAtrasoHumano {
  notarMs?: number | null;
  msPorCaractere?: number | null;
  minimoMs?: number | null;
  maximoMs?: number | null;
}

/**
 * Quanto esperar antes de mandar `texto`, em ms. Pura — é o que a torna
 * testável sem relógio e sem canal.
 *
 * `Math.max(0, ...)` nos overrides é a última linha de defesa, não a
 * primeira: a CHECK constraint do banco já recusa negativo e min > max na
 * origem (`ai_agent_versions.human_delay_*`, migration 0233). Existe aqui
 * porque esta função também é chamada direto em teste, sem passar pela
 * coluna — uma função pura não deveria confiar em quem a chama para nunca
 * mandar um número fora do domínio dela.
 */
export function calcularAtrasoHumano(texto: string, config?: ConfigDeAtrasoHumano): number {
  const notar = Math.max(0, config?.notarMs ?? ATRASO_NOTAR_MS);
  const porCaractere = Math.max(0, config?.msPorCaractere ?? MS_POR_CARACTERE);
  const minimo = Math.max(0, config?.minimoMs ?? ATRASO_MINIMO_MS);
  const maximo = Math.max(0, config?.maximoMs ?? ATRASO_MAXIMO_MS);

  const comprimento = (texto ?? '').trim().length;
  const bruto = notar + porCaractere * comprimento;
  return Math.min(maximo, Math.max(minimo, bruto));
}

export interface EsperaHumanaArgs {
  /** O corpo que vai sair — é o tamanho DELE que dita a espera. */
  texto: string;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  /**
   * Acende o "digitando…" no aparelho do cliente. OPCIONAL: canal que não sabe
   * sinalizar presença simplesmente espera, e o ganho principal (não responder
   * instantaneamente) continua valendo.
   */
  sinalizarDigitando?: () => Promise<void>;
  /** Override por agente (issue #5) — omitido = todas as constantes do sistema. */
  config?: ConfigDeAtrasoHumano;
}

/**
 * Acende o "digitando…" e espera. Devolve os ms esperados.
 *
 * ⚠️ A PRESENÇA FALHA MACIO, E ISSO NÃO É NEGOCIÁVEL. "digitando…" é decoração;
 * a mensagem é o produto. Transporte fora do ar, sessão que não está saudável ou
 * canal que não implementa presença viram uma linha de log e o envio segue — deixar
 * uma chamada decorativa derrubar entrega seria trocar o produto pelo enfeite.
 *
 * A ordem também é o produto: sinalizar DEPOIS de esperar entregaria ao cliente
 * os segundos de silêncio sem a explicação visual que os torna naturais.
 */
export async function esperarComoHumano(args: EsperaHumanaArgs): Promise<number> {
  const ms = calcularAtrasoHumano(args.texto, args.config);

  if (args.sinalizarDigitando !== undefined) {
    try {
      await args.sinalizarDigitando();
    } catch (err) {
      // Sem corpo de erro e sem texto da mensagem: `lib/logger.ts` proíbe
      // conteúdo de conversa no log, e a resposta do canal pode carregá-lo.
      args.log.warn('não consegui sinalizar "digitando" (segue o envio)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  await args.sleep(ms);
  return ms;
}
