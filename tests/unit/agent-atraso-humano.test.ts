import { describe, expect, it, vi } from "vitest";

import {
  ATRASO_MAXIMO_MS,
  ATRASO_MINIMO_MS,
  calcularAtrasoHumano,
  esperarComoHumano,
} from "@/lib/agent-engine/agent/atraso-humano";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Logger de teste — guarda as linhas em vez de escrever em stdout. */
function logDeTeste(): Logger & { linhas: Array<{ nivel: string; msg: string }> } {
  const linhas: Array<{ nivel: string; msg: string }> = [];
  return {
    linhas,
    info: (msg) => linhas.push({ nivel: "info", msg }),
    warn: (msg) => linhas.push({ nivel: "warn", msg }),
    error: (msg) => linhas.push({ nivel: "error", msg }),
  };
}

describe("calcularAtrasoHumano", () => {
  it("resposta de duas palavras espera o PISO, não uma eternidade", () => {
    // O defeito que este módulo conserta é o oposto (resposta instantânea), mas
    // a correção não pode criar o defeito simétrico: "Oi, tudo bem?" com 8s de
    // espera lê como travamento, não como humano.
    expect(calcularAtrasoHumano("Oi, tudo bem?")).toBe(ATRASO_MINIMO_MS);
  });

  it("parágrafo longo é limitado pelo TETO", () => {
    const paragrafo = "a".repeat(4000);
    expect(calcularAtrasoHumano(paragrafo)).toBe(ATRASO_MAXIMO_MS);
  });

  it("entre piso e teto, o atraso CRESCE com o tamanho do texto", () => {
    const curta = calcularAtrasoHumano("Temos sim, o sítio está livre nessa data.");
    const media = calcularAtrasoHumano(
      "Temos sim, o sítio está livre nessa data. O pacote de casamento inclui " +
        "a cerimônia no jardim, o salão climatizado e a suíte dos noivos.",
    );
    expect(media).toBeGreaterThan(curta);
    expect(media).toBeLessThanOrEqual(ATRASO_MAXIMO_MS);
  });

  it("o piso não fica abaixo do piso anti-ban de 1,2s", () => {
    // Doutrina WAHA (CLAUDE.md): throttle 1 msg/1.2s. Um atraso "humano" menor
    // que o piso do anti-ban seria decoração que não protege nada.
    expect(ATRASO_MINIMO_MS).toBeGreaterThanOrEqual(1200);
    expect(calcularAtrasoHumano("")).toBeGreaterThanOrEqual(1200);
  });

  it("devolve inteiro de milissegundos (é argumento de setTimeout)", () => {
    expect(Number.isInteger(calcularAtrasoHumano("um texto de tamanho médio aqui"))).toBe(true);
  });
});

describe("esperarComoHumano", () => {
  it("sinaliza 'digitando' ANTES de esperar — a ordem é o produto", async () => {
    const ordem: string[] = [];
    const sinalizarDigitando = vi.fn(async () => {
      ordem.push("digitando");
    });
    const sleep = vi.fn(async () => {
      ordem.push("espera");
    });

    await esperarComoHumano({
      texto: "Claro! Vou conferir a agenda do sítio para essa data.",
      sleep,
      log: logDeTeste(),
      sinalizarDigitando,
    });

    // Esperar primeiro e só depois mostrar "digitando" entregaria os três
    // segundos de silêncio que o dono do produto reclamou.
    expect(ordem).toEqual(["digitando", "espera"]);
  });

  it("espera exatamente o que a fórmula calculou", async () => {
    const texto = "Claro! Vou conferir a agenda do sítio para essa data.";
    const sleep = vi.fn(async () => undefined);

    await esperarComoHumano({ texto, sleep, log: logDeTeste() });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(calcularAtrasoHumano(texto));
  });

  it("presença que FALHA não derruba o envio nem encurta a espera", async () => {
    // "digitando" é decoração; a mensagem é o produto. Um WAHA fora do ar, uma
    // sessão que não está WORKING ou um engine que não implementa presença não
    // podem virar mensagem não entregue.
    const texto = "Claro! Vou conferir a agenda do sítio para essa data.";
    const sleep = vi.fn(async () => undefined);
    const log = logDeTeste();

    await expect(
      esperarComoHumano({
        texto,
        sleep,
        log,
        sinalizarDigitando: async () => {
          throw new Error("waha_500");
        },
      }),
    ).resolves.toBeDefined();

    expect(sleep).toHaveBeenCalledWith(calcularAtrasoHumano(texto));
    expect(log.linhas.some((l) => l.nivel === "warn")).toBe(true);
  });

  it("canal que não sabe sinalizar presença apenas espera", async () => {
    const sleep = vi.fn(async () => undefined);
    await esperarComoHumano({ texto: "Bom dia!", sleep, log: logDeTeste() });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("devolve os ms esperados, para o log do turno poder afirmá-los", async () => {
    const texto = "Uma resposta de tamanho médio para o cliente do sítio.";
    const ms = await esperarComoHumano({ texto, sleep: async () => undefined, log: logDeTeste() });
    expect(ms).toBe(calcularAtrasoHumano(texto));
  });
});

describe("calcularAtrasoHumano — override por agente (issue #5)", () => {
  it("sem config, usa as constantes do sistema (comportamento de sempre)", () => {
    expect(calcularAtrasoHumano("Oi, tudo bem?")).toBe(
      calcularAtrasoHumano("Oi, tudo bem?", undefined),
    );
    expect(calcularAtrasoHumano("Oi, tudo bem?", {})).toBe(ATRASO_MINIMO_MS);
  });

  it("campo omitido ou null no config cai na constante — não é um valor de zero", () => {
    const comNull = calcularAtrasoHumano("texto de tamanho médio para o teste aqui", {
      notarMs: null,
      msPorCaractere: null,
      minimoMs: null,
      maximoMs: null,
    });
    const semConfig = calcularAtrasoHumano("texto de tamanho médio para o teste aqui");
    expect(comNull).toBe(semConfig);
  });

  it("minimoMs configurado sobe o piso de uma resposta curta", () => {
    const piso = calcularAtrasoHumano("Oi!", { minimoMs: 3000 });
    expect(piso).toBe(3000);
  });

  it("maximoMs configurado corta o teto de um texto longo", () => {
    const paragrafo = "a".repeat(4000);
    const teto = calcularAtrasoHumano(paragrafo, { maximoMs: 4000 });
    expect(teto).toBe(4000);
  });

  it("notarMs configurado muda a parcela fixa, mesmo em texto vazio", () => {
    // minimoMs alto o bastante para não mascarar a mudança no clamp.
    const atraso = calcularAtrasoHumano("", { notarMs: 5000, minimoMs: 0, maximoMs: 15000 });
    expect(atraso).toBe(5000);
  });

  it("msPorCaractere configurado muda a taxa de crescimento com o texto", () => {
    const texto = "a".repeat(100);
    const lento = calcularAtrasoHumano(texto, { msPorCaractere: 1, minimoMs: 0, maximoMs: 15000 });
    const rapido = calcularAtrasoHumano(texto, {
      msPorCaractere: 50,
      minimoMs: 0,
      maximoMs: 15000,
    });
    expect(rapido).toBeGreaterThan(lento);
  });

  it("configurar só um dos quatro campos não reseta os outros três pro zero", () => {
    // Regressão do tipo de bug mais fácil de escrever aqui: um objeto parcial
    // devolvendo `undefined` nos campos que ninguém tocou, e `?? valor` sendo
    // trocado por algo que trata `undefined` como zero em vez de "use o default".
    const soMinimo = calcularAtrasoHumano("Oi, tudo bem?", { minimoMs: 1200 });
    expect(soMinimo).toBe(ATRASO_MINIMO_MS);
  });
});

describe("esperarComoHumano — override por agente (issue #5)", () => {
  it("repassa o config pra calcularAtrasoHumano — a espera de verdade muda", async () => {
    const texto = "Oi!";
    const sleep = vi.fn(async () => undefined);

    await esperarComoHumano({ texto, sleep, log: logDeTeste(), config: { minimoMs: 4000 } });

    expect(sleep).toHaveBeenCalledWith(4000);
  });
});
