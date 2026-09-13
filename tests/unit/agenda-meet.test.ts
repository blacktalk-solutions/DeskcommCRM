import { describe, expect, it } from "vitest";
import { meetVideoUrl, observeMeeting } from "@/lib/agenda/google/meet";
import { localProjection } from "@/lib/agenda/google/sync-model";
describe("recibo da conferência", () => {
  const req = "6222ae88-2a55-4ae4-908f-7d30c50a845e";
  const event = (status: string) => ({
    conferenceData: {
      createRequest: { requestId: req, status: { statusCode: status } },
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
    },
  });
  it("pending não é ready, failure recebido é diferente de desconhecido", () => {
    expect(observeMeeting(event("pending"), req)).toMatchObject({
      state: "pending",
      received: true,
      url: null,
    });
    expect(observeMeeting(event("failure"), req)).toMatchObject({
      state: "failed",
      received: true,
      error: "google_failure",
    });
    expect(observeMeeting(event("success"), req)).toMatchObject({
      state: "ready",
      received: true,
      url: "https://meet.google.com/abc-defg-hij",
    });
    expect(observeMeeting(event("success"), "outra-intencao")).toBeNull();
  });
  it("não transforma htmlLink, conferenceId, phone ou solução alheia em URL", () => {
    expect(
      observeMeeting(
        {
          conferenceData: {
            createRequest: { requestId: req, status: { statusCode: "success" } },
            conferenceSolution: { key: { type: "hangoutsMeet" } },
            entryPoints: [{ entryPointType: "phone", uri: "tel:123" }],
          },
        },
        req,
      ),
    ).toMatchObject({ state: "failed", error: "invalid" });
    expect(
      observeMeeting(
        {
          conferenceData: {
            createRequest: { requestId: req },
            conferenceSolution: { key: { type: "outro" } },
          },
          hangoutLink: "https://meet.google.com/abc-defg-hij",
        },
        req,
      ),
    ).toMatchObject({ state: "failed" });
    for (const url of [
      "http://meet.google.com/abc-defg-hij",
      "https://meet.google.com.evil/abc",
      "https://user:pass@meet.google.com/abc",
      "https://calendar.google.com/event/abc",
      "javascript:alert(1)",
    ])
      expect(meetVideoUrl(url)).toBeNull();
  });
  it("conferência antiga válida pode ser adotada sem criar outra sala", () => {
    expect(observeMeeting(event("success"), "novo", true)).toMatchObject({
      state: "ready",
      received: false,
    });
  });
  it("chegada da URL não altera projeção local", () => {
    const a = {
      id: req,
      organization_id: req,
      title: "Reunião",
      starts_at: "2030-01-01T12:00:00Z",
      ends_at: "2030-01-01T13:00:00Z",
      time_zone: "UTC",
      status: "confirmed" as const,
      location_kind: "google_meet" as const,
    };
    expect(localProjection({ ...a, meeting_url: "https://meet.google.com/abc-defg-hij" })).toEqual(
      localProjection(a),
    );
  });
});

it("spinning compara texto minimizado sem conservar credencial da sala", async () => {
  const { normalizeCopy, hashNormalized, decideSpinning } =
    await import("@/lib/agent-engine/spinning/engine");
  const { SPINNING_DEFAULTS } = await import("@/lib/agent-engine/spinning/defaults");
  const body = "Sua reunião: https://meet.google.com/abc-defg-hij";
  const normalized = normalizeCopy(body);
  expect(normalized).not.toContain("abc-defg-hij");
  expect(normalized).toContain("[meet-link]");
  const result = decideSpinning({
    candidate: body,
    knobs: { ...SPINNING_DEFAULTS, allowlistMaxLength: 0 },
    window: Array.from({ length: 20 }, () => ({
      normalizedText: normalized,
      normalizedHash: hashNormalized(normalized),
    })),
  });
  expect(result.allow).toBe(false);
});

it("mensagem determinística usa texto e data do destinatário", async () => {
  const { meetingDeliveryBody } = await import("@/lib/agent-engine/agent/meet-delivery");
  const at = "2030-01-02T13:05:00Z",
    url = "https://meet.google.com/abc-defg-hij";
  expect(meetingDeliveryBody(at, "UTC", url, "es")).toBe(
    `¡Tu reunión está confirmada!\n\n*Fecha y hora:* 2/1/30, 13:05 (UTC)\n*Enlace de Google Meet:* ${url}`,
  );
  expect(meetingDeliveryBody(at, "America/Sao_Paulo", url, "pt-BR")).toBe(
    `Sua reunião está confirmada!\n\n*Data e hora:* 02/01/2030, 10:05 (America/Sao_Paulo)\n*Link do Google Meet:* ${url}`,
  );
});

it("mensagem com nome do contato e título do compromisso — issue agendamento formatado", async () => {
  const { meetingDeliveryBody } = await import("@/lib/agent-engine/agent/meet-delivery");
  const at = "2030-01-02T13:05:00Z",
    url = "https://meet.google.com/abc-defg-hij";
  expect(
    meetingDeliveryBody(at, "America/Sao_Paulo", url, "pt-BR", "Thie", "Diagnóstico gratuito"),
  ).toBe(
    `Oi, Thie! Sua reunião está confirmada!\n\n*Data e hora:* 02/01/2030, 10:05 (America/Sao_Paulo)\n*Assunto:* Diagnóstico gratuito\n*Link do Google Meet:* ${url}`,
  );
  // nome/título ausentes (null) tem de se comportar igual a omitidos — mesmo
  // texto do teste "determinística" acima, sem nenhum pedaço extra sobrando.
  expect(meetingDeliveryBody(at, "America/Sao_Paulo", url, "pt-BR", null, null)).toBe(
    `Sua reunião está confirmada!\n\n*Data e hora:* 02/01/2030, 10:05 (America/Sao_Paulo)\n*Link do Google Meet:* ${url}`,
  );
});

it("descrição do convite do Google — rótulos em negrito HTML, nome/assunto/link", async () => {
  const { descricaoDoConvite } = await import("@/lib/agent-engine/agent/meet-delivery");
  const at = "2030-01-02T13:05:00Z",
    url = "https://meet.google.com/abc-defg-hij";
  expect(
    descricaoDoConvite("Thie", "Diagnóstico gratuito", at, "America/Sao_Paulo", url, "pt-BR"),
  ).toBe(
    "<b>Nome:</b> Thie<br>\n" +
      "<b>Data e hora:</b> 02/01/2030, 10:05 (America/Sao_Paulo)<br>\n" +
      "<b>Assunto:</b> Diagnóstico gratuito<br>\n" +
      `<b>Link do Google Meet:</b> ${url}`,
  );
  // sem nome (contato sem cadastro) — a linha some, o resto segue igual.
  expect(
    descricaoDoConvite(null, "Diagnóstico gratuito", at, "America/Sao_Paulo", url, "pt-BR"),
  ).toBe(
    "<b>Data e hora:</b> 02/01/2030, 10:05 (America/Sao_Paulo)<br>\n" +
      "<b>Assunto:</b> Diagnóstico gratuito<br>\n" +
      `<b>Link do Google Meet:</b> ${url}`,
  );
  // nome/título com `<`, `>` ou `&` não quebram o HTML da descrição.
  expect(
    descricaoDoConvite("A & B <script>", "x < y", at, "America/Sao_Paulo", url, "pt-BR"),
  ).toContain("<b>Nome:</b> A &amp; B &lt;script&gt;<br>");
  // idioma segue o contato — mesmo guardrail que meetingDeliveryBody já respeita.
  expect(descricaoDoConvite("Thie", "Diagnóstico", at, "UTC", url, "es")).toContain(
    "<b>Nombre:</b> Thie<br>\n<b>Fecha y hora:</b> ",
  );
});
