import type pg from "pg";
import { reconcileAcceptedSend } from "../edge/crm/send-ledger";
import type { JobRow } from "../queue/queue";
import { claimOfJob } from "../queue/claim";
import type { CrmEdgeConfig } from "../edge/crm/mcp-client";
import { createRuntimeSendChannel, type RuntimeSendChannel } from "@/lib/channels/runtime";
import type { Logger } from "../obs/logger";
import { runBeforeSend } from "../guardrails/before-send";
import { deriveLgpdFromContact, type LgpdContactFields } from "../guardrails/lgpd/legal-basis";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  assertMeetingDeliveryPg,
  assertMeetingDeliveryReceiptPg,
  MeetingDeliveryBlockedError,
} from "@/lib/agenda/meet-delivery";
import { meetVideoUrl } from "@/lib/agenda/google/meet";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export function createMeetDeliveryHandler(deps: {
  crmCfg: CrmEdgeConfig;
  log: Logger;
  channel?: (pool: pg.Pool) => RuntimeSendChannel;
  sleep?: (ms: number) => Promise<void>;
}) {
  return async (job: JobRow, pool: pg.Pool) => {
    const claim = claimOfJob(job);
    if (!claim || !job.contact_id || job.kind !== "transactional_delivery")
      throw new StaleServiceBoundaryError();
    const context = { organizationId: job.organization_id, jobId: job.id, jobClaim: claim };
    const settle = async (state: string, retryAt?: Date) => {
      await pool.query("select fn_meet_delivery_settle($1,$2,$3,$4,$5,$6)", [
        job.organization_id,
        job.id,
        claim.worker_id,
        claim.acquired_at,
        state,
        retryAt?.toISOString() ?? null,
      ]);
    };
    try {
      await withServiceJob(pool, job, async () => {
        await assertMeetingDeliveryReceiptPg(pool, context);
        if (
          await reconcileAcceptedSend(pool, {
            tenantId: job.organization_id,
            jobId: job.id,
            seq: 1,
          })
        ) {
          await settle("sent");
          return;
        }
        await assertMeetingDeliveryPg(pool, context);
        const boundary = parseServiceBoundary(job.payload.service_boundary)!;
        const { rows } = await pool.query<
          LgpdContactFields & {
            meeting_url: string;
            starts_at: string;
            time_zone: string;
            channel_session_id: string;
            daily_message_limit: number | null;
            archived_at: string | null;
            contact_locale: string | null;
            organization_locale: string;
            contact_name: string | null;
            title: string;
          }
        >(
          `select a.meeting_url,a.starts_at,a.time_zone,a.title,c.source,c.consent,c.is_anonymized,c.locale as contact_locale,coalesce(c.display_name,c.name) as contact_name,o.locale as organization_locale,v.channel_session_id,s.daily_message_limit,to_jsonb(s)->>'archived_at' as archived_at
           from calendar_appointments a join contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
           join organizations o on o.id=a.organization_id
           join conversations v on v.organization_id=a.organization_id and v.contact_id=c.id and v.id=$3
           join channel_sessions s on s.organization_id=v.organization_id and s.id=v.channel_session_id
           where a.organization_id=$1 and a.id=$2 and a.contact_id=$4`,
          [
            job.organization_id,
            job.payload.appointment_id,
            boundary.conversation_id,
            job.contact_id,
          ],
        );
        const row = rows[0];
        const url = meetVideoUrl(row?.meeting_url);
        if (!row || !url || row.archived_at) {
          await settle("blocked:channel");
          return;
        }
        const idioma = normalizarIdioma(row.contact_locale ?? row.organization_locale);
        // Independente do WhatsApp (gates de guardrail podem vetar/adiar a
        // mensagem ao cliente): o convite do Google já pode ganhar o link. Um
        // simples UPDATE de `description` já dispara `fn_google_projection_stamp`
        // (compara old/new e sobe `google_local_revision`), que é o mesmo gatilho
        // que qualquer edição manual usa — nenhum campo de sincronismo é mexido
        // aqui, só o texto público do compromisso.
        await pool.query(
          `update calendar_appointments set description = $3
           where organization_id = $1 and id = $2 and description is distinct from $3`,
          [
            job.organization_id,
            job.payload.appointment_id,
            descricaoDoConvite(row.contact_name, row.title, row.starts_at, row.time_zone, url, idioma),
          ],
        );
        const channel =
          deps.channel?.(pool) ??
          createRuntimeSendChannel(pool, {
            ...deps.crmCfg,
            agentActorId: "agent-engine:meet-delivery",
          });
        const result = await runBeforeSend({
          pool,
          log: deps.log,
          tenantId: job.organization_id,
          leadId: job.contact_id!,
          jobId: job.id,
          meetingDelivery: context,
          channelSessionId: row.channel_session_id,
          crmDailyLimit: row.daily_message_limit,
          body: meetingDeliveryBody(row.starts_at, row.time_zone, url, idioma, row.contact_name, row.title),
          optedOutThisTurn: false,
          now: new Date(),
          lgpd: deriveLgpdFromContact(row, false),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          send: async (body) => {
            await assertMeetingDeliveryPg(pool, context);
            return channel.send({
              tenantId: job.organization_id,
              leadId: job.contact_id,
              jobId: job.id,
              jobClaim: claim,
              seq: 1,
              conversationId: boundary.conversation_id,
              body,
            });
          },
        });
        if (result.status === "vetoed") {
          const reason =
            result.code === "contato_bloqueado"
              ? "opt_out"
              : result.code.startsWith("lgpd_")
                ? "lgpd"
                : result.code === "messaging_window_closed"
                  ? "limits"
                  : "guardrail";
          await settle(result.nextAllowedAt ? "queued" : `blocked:${reason}`, result.nextAllowedAt);
          return;
        }
        switch (result.outcome.kind) {
          case "sent":
          case "already_sent":
            await settle("sent");
            break;
          case "queued":
            await settle("queued");
            break;
          case "blocked":
            await assertMeetingDeliveryPg(pool, context);
            await settle("blocked:opt_out");
            break;
          default:
            await assertMeetingDeliveryPg(pool, context);
            await settle("retry");
        }
      });
    } catch (error) {
      await settle(
        error instanceof MeetingDeliveryBlockedError
          ? `blocked:${error.reason}`
          : error instanceof StaleServiceBoundaryError
            ? "stale"
            : "retry",
      );
    }
  };
}

export function meetingDeliveryBody(
  startsAt: string,
  timeZone: string,
  url: string,
  idioma: Idioma,
  /** Nome do contato, se houver — vira a saudação. `undefined`/`null` = sem nome (compat). */
  contactName?: string | null,
  /** Título do compromisso, se houver — vira a linha "Assunto". */
  title?: string | null,
): string {
  const when = new Intl.DateTimeFormat(tagDeIdioma(idioma), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(startsAt));
  const saudacao = contactName ? `${traduzir("Oi,", idioma)} ${contactName}! ` : "";
  const linhas = [
    `*${traduzir("Data e hora:", idioma)}* ${when} (${timeZone})`,
    ...(title ? [`*${traduzir("Assunto:", idioma)}* ${title}`] : []),
    `*${traduzir("Link do Google Meet:", idioma)}* ${url}`,
  ];
  return `${saudacao}${traduzir("Sua reunião está confirmada!", idioma)}\n\n${linhas.join("\n")}`;
}

/** Escapa o mínimo pro HTML que a descrição do Google aceita não quebrar com `<`/`&` no nome ou título. */
function escapeHtml(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Corpo HTML da descrição do EVENTO do Google (não da mensagem de WhatsApp) —
 * mesmos 4 dados, rótulo em negrito, mas com `<b>`/`<br>` em vez de `*`/`\n`:
 * é o que a UI do Google Calendar (e o corpo do e-mail de convite) renderiza.
 */
export function descricaoDoConvite(
  contactName: string | null,
  title: string,
  startsAt: string,
  timeZone: string,
  url: string,
  idioma: Idioma,
): string {
  const when = new Intl.DateTimeFormat(tagDeIdioma(idioma), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(startsAt));
  const linhas = [
    ...(contactName ? [`<b>${traduzir("Nome:", idioma)}</b> ${escapeHtml(contactName)}`] : []),
    `<b>${traduzir("Data e hora:", idioma)}</b> ${when} (${timeZone})`,
    `<b>${traduzir("Assunto:", idioma)}</b> ${escapeHtml(title)}`,
    `<b>${traduzir("Link do Google Meet:", idioma)}</b> ${url}`,
  ];
  return linhas.join("<br>\n");
}
