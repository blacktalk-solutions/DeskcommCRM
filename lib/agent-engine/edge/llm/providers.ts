/**
 * Registro de providers da camada agnóstica. ÚNICO lugar (junto do resto de
 * edge/llm/) onde SDK de vendor é importado. Instância POR CHAMADA com a chave
 * BYOK da org: sem pool global de chave, sem fallback silencioso.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { allowlistedFetch, buildAllowlist } from '../egress';

/**
 * provider name → (chave BYOK da org, id do modelo, endpoint opcional) → modelo
 * pronto para generateText.
 *
 * O terceiro parâmetro é o endpoint escolhido no painel de provedores
 * (`ai_purpose_bindings.base_url`). Existe por causa dos dois casos que o
 * registry precisa atender e que não têm endpoint fixo: um gateway
 * OpenAI-compatível na frente da OpenRouter e, no roteiro do produto, um modelo
 * rodando na máquina do próprio cliente. É opcional — os providers canônicos
 * ignoram e continuam indo ao endpoint intrínseco de terem sido escolhidos.
 */
export type ProviderRegistry = Record<
  string,
  (apiKey: string, modelId: string, baseUrl?: string) => LanguageModel
>;

/**
 * Endpoint canônico do provider Anthropic (baseURL default do @ai-sdk/anthropic). NÃO é
 * um knob de política (a allowlist de política é a do egress.ts) — é o destino INTRÍNSECO
 * de ter escolhido o provider anthropic. Se uma org precisar de proxy/baseURL custom, é aqui
 * que ele entra (junto do `fetch` contido), nunca espalhado.
 */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const OPENAI_ENDPOINT = 'https://api.openai.com';
const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com';
/**
 * A OpenRouter fala a API da OpenAI, então o provider `@ai-sdk/openai` conversa
 * com ela sem dependência nova — e os ids dela já vêm no formato
 * `familia/modelo`, o mesmo dos nossos, sem tradução no meio.
 */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

/**
 * Cabeçalhos OPCIONAIS de atribuição da OpenRouter.
 *
 * A doc deles chama `HTTP-Referer` e `X-Title` de "optional headers to identify
 * your app and make it discoverable to users on our site" — servem para
 * atribuição e para o ranking público do site deles, NÃO para a chamada
 * funcionar. Chamada sem eles é atendida normalmente.
 *
 * Por isso eles saem da INSTALAÇÃO e nunca do código: uma URL literal aqui
 * viajaria dentro da imagem que todo self-hoster roda, creditando o consumo de
 * OpenRouter de cada cliente a um site que não é dele. E um título literal com
 * o nome do produto é a marca vazando por fora do resolvedor — a catraca de
 * `tests/unit/branding.test.ts` reprova, e está certa.
 *
 * Sem valor, nenhum header vai: falha aberta na informação, porque a ausência
 * de atribuição não quebra ninguém.
 */
export function cabecalhosDeAtribuicaoOpenRouter(): Record<string, string> | undefined {
  const url = process.env.OPENROUTER_APP_URL?.trim();
  const titulo = process.env.OPENROUTER_APP_TITLE?.trim();
  const headers: Record<string, string> = {};
  if (url) headers['HTTP-Referer'] = url;
  if (titulo) headers['X-Title'] = titulo;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Providers reais do lançamento. Sonnet (Anthropic) é o default RECOMENDADO —
 * recomendação vive em .env.example/docs; o id do modelo é sempre config da org.
 *
 * O `fetch` INTERNO do provider (generateText) também roteia pela allowlist
 * (`allowlistedFetch`) — sem isso o egress do SDK escapava da contenção. A
 * allowlist do provider = seu endpoint canônico + hosts extra de config
 * (`allowedHosts`, ex.: proxy corporativo). Testes usam o registry fake
 * (createFakeRegistry, sem fetch real); este caminho só é exercitado pelo smoke
 * (rede real → endpoint canônico do provider allowlistado).
 */
/**
 * `stable-prefix.ts` monta `providerOptions.anthropic.cacheControl` (F2-17,
 * regra 15) — mas o provider REAL usado aqui pra OpenRouter é `@ai-sdk/openai`
 * (endpoint OpenAI-compatível, ver comentário de `OPENROUTER_ENDPOINT` acima).
 * O `@ai-sdk/openai` instalado (4.0.56) não tem NENHUMA noção de `cacheControl`
 * — não é que ele traduza errado, é que o campo nem existe nos tipos dele, e o
 * SDK descarta o `providerOptions.anthropic.*` antes de montar o corpo HTTP.
 * Resultado medido em produção: `cache_read_tokens`/`cache_write_tokens` = 0
 * em TODA chamada, sempre — não é a alavanca de custo que parecia ser.
 *
 * O conserto não é no SDK (não dá pra ensinar tipo alheio a reconhecer campo
 * novo sem fork): é aqui, no fetch que já existe pra allowlist de egress.
 * A OpenRouter documenta cache automático via UM campo `cache_control` na RAIZ
 * do corpo da requisição (https://openrouter.ai/docs/features/prompt-caching)
 * — ela mesma escolhe o último bloco cacheável, sem precisar remontar
 * `messages`/`tools` pra colocar o campo em cada bloco à mão.
 *
 * Só entra na chamada 'openrouter': é sintaxe da OpenRouter, e OpenAI/Google/
 * Anthropic direto não a reconhecem (na Anthropic direta, `stable-prefix.ts`
 * já funciona pelo `providerOptions.anthropic` de verdade).
 */
function comCacheAutomaticoDaOpenRouter(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      try {
        const corpo: unknown = JSON.parse(init.body);
        if (corpo !== null && typeof corpo === 'object' && !('cache_control' in corpo)) {
          init = {
            ...init,
            body: JSON.stringify({ ...corpo, cache_control: { type: 'ephemeral' } }),
          };
        }
      } catch {
        // Corpo não era JSON — não deveria acontecer neste caminho, mas
        // seguir sem cache é sempre mais seguro que derrubar a chamada.
      }
    }
    return fetchFn(input, init);
  };
}

export function createDefaultRegistry(opts?: { allowedHosts?: string[] }): ProviderRegistry {
  const extra = opts?.allowedHosts ?? [];
  const contain = (endpoint: string): typeof fetch => {
    const allow = buildAllowlist([endpoint, ...extra]);
    return (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      return allowlistedFetch(url, init, { allowlist: allow });
    };
  };
  return {
    anthropic: (apiKey, modelId) =>
      createAnthropic({ apiKey, fetch: contain(ANTHROPIC_ENDPOINT) })(modelId),
    openai: (apiKey, modelId) =>
      createOpenAI({ apiKey, fetch: contain(OPENAI_ENDPOINT) })(modelId),
    google: (apiKey, modelId) =>
      createGoogleGenerativeAI({ apiKey, fetch: contain(GOOGLE_ENDPOINT) })(modelId),
    /**
     * O `baseUrl` do painel é honrado aqui, e a allowlist do egress passa a ser
     * a DELE — não a da OpenRouter mais um furo. Apontar para um gateway
     * próprio é escolha legítima do operador; deixar a allowlist fixa no
     * endpoint canônico faria o egress bloquear a própria configuração que a
     * tela ofereceu, com erro de rede que ninguém liga ao painel.
     */
    openrouter: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? OPENROUTER_ENDPOINT;
      return createOpenAI({
        apiKey,
        baseURL: endpoint,
        headers: cabecalhosDeAtribuicaoOpenRouter(),
        fetch: comCacheAutomaticoDaOpenRouter(contain(endpoint)),
      })(modelId);
    },
  };
}

/**
 * Registry FAKE para testes: provider 'anthropic' (e alias 'fake') respondendo
 * com o MockLanguageModelV3 do SDK v6 instalado — zero rede, zero chave real.
 * O doGenerate default devolve `text` com usage fixo; injete o seu para cenários
 * de tool-call/erro.
 */
type MockDoGenerate = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doGenerate'];

export function createFakeRegistry(
  doGenerate?: MockDoGenerate,
  opts?: { text?: string },
): ProviderRegistry {
  const factory = (_apiKey: string, modelId: string): LanguageModel =>
    new MockLanguageModelV3({
      modelId,
      doGenerate:
        doGenerate ??
        {
          content: [{ type: 'text', text: opts?.text ?? 'ok' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
    });
  return { anthropic: factory, fake: factory };
}
