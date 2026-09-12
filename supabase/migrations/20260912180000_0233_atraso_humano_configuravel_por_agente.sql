-- ============================================================================
-- 0233 — ATRASO "HUMANO" ANTES DA 1ª BOLHA VIRA CONFIGURÁVEL POR AGENTE
--
-- lib/agent-engine/agent/atraso-humano.ts calcula o atraso antes da primeira
-- mensagem sair com uma fórmula de constantes FIXAS no código:
--
--   atraso = clamp(900ms + 22ms × nº de caracteres, 1200ms, 7500ms)
--
-- Não existia campo nenhum, em tela ou banco, para o dono de uma organização
-- ajustar esses quatro números. Medido em uso real (11/09/2026): o dono achou
-- o tempo de resposta do agente "meio demorado" e não tinha como encurtar —
-- só editando o código-fonte e reconstruindo a imagem, o que não é caminho
-- nenhum pra quem opera o produto, só pra quem o desenvolve.
--
-- ─── Por que colunas em `ai_agent_versions`, e não `organizations.settings`
--     (a sugestão original da issue #5) ──────────────────────────────────────
--
-- `split_messages`/`split_max_chars` já são exatamente este tipo de "knob de
-- comportamento do turno" nesta MESMA tabela — uma coluna tipada e limitada
-- por linha, não um jsonb solto em outra tabela. Um agente publicado é a
-- unidade que já carrega tom, modelo e demais comportamentos; times com mais
-- de um agente (ex.: um de suporte rápido, outro de vendas mais pausado)
-- ficariam sem poder diferenciar se o knob fosse por ORGANIZAÇÃO. Seguir o
-- padrão que já existe na tabela bate as duas necessidades sem inventar um
-- segundo mecanismo de configuração para o mesmo tipo de coisa.
--
-- ─── Por que as quatro são NULLABLE, e null não é "zero" ────────────────────
--
-- null = "usa o default do sistema" (as mesmas constantes de hoje). Toda
-- linha existente recebe null nas quatro colunas nesta migration — nenhum
-- agente publicado muda de comportamento até que alguém explicitamente
-- configure um valor diferente pela tela. É a mesma semântica de
-- `operator_model` (null = "herda", não "zero").
-- ============================================================================

alter table public.ai_agent_versions
  add column if not exists human_delay_base_ms integer null,
  add column if not exists human_delay_ms_per_char integer null,
  add column if not exists human_delay_min_ms integer null,
  add column if not exists human_delay_max_ms integer null;

comment on column public.ai_agent_versions.human_delay_base_ms is
  'Parcela fixa do atraso "humano" antes da 1ª bolha, em ms. null = default do sistema (ver atraso-humano.ts).';
comment on column public.ai_agent_versions.human_delay_ms_per_char is
  'Parcela proporcional ao tamanho do texto, em ms/caractere. null = default do sistema.';
comment on column public.ai_agent_versions.human_delay_min_ms is
  'Piso do atraso, em ms — não pode ficar abaixo do throttle anti-ban do canal. null = default do sistema.';
comment on column public.ai_agent_versions.human_delay_max_ms is
  'Teto do atraso, em ms — acima disso o silêncio deixa de ler como "digitando". null = default do sistema.';

alter table public.ai_agent_versions
  add constraint ai_agent_versions_human_delay_base_ms_check
    check (human_delay_base_ms is null or human_delay_base_ms >= 0),
  add constraint ai_agent_versions_human_delay_ms_per_char_check
    check (human_delay_ms_per_char is null or human_delay_ms_per_char >= 0),
  add constraint ai_agent_versions_human_delay_min_ms_check
    check (human_delay_min_ms is null or human_delay_min_ms >= 0),
  add constraint ai_agent_versions_human_delay_max_ms_check
    check (human_delay_max_ms is null or human_delay_max_ms >= 0),
  -- A checagem cruzada mora AQUI, não no schema zod (versionShapeSchema não
  -- pode virar ZodEffects sem perder `.partial()`, que versionPatchSchema
  -- usa) — o banco é quem garante mesmo com um client desatualizado ou uma
  -- chamada direta à API.
  add constraint ai_agent_versions_human_delay_min_le_max_check
    check (
      human_delay_min_ms is null
      or human_delay_max_ms is null
      or human_delay_min_ms <= human_delay_max_ms
    );

-- Recria o trigger de imutabilidade incluindo as quatro colunas novas — sem
-- isto, alterar o atraso de uma versao PUBLICADA passaria batido pelo mesmo
-- trigger que barra qualquer outra mudanca de conteudo (system_prompt, model,
-- etc.), quebrando a doutrina de 'publicado = imutavel, mudanca = draft novo'
-- so para estas quatro colunas.
create or replace function public.fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.human_delay_base_ms    is distinct from old.human_delay_base_ms
    or new.human_delay_ms_per_char is distinct from old.human_delay_ms_per_char
    or new.human_delay_min_ms     is distinct from old.human_delay_min_ms
    or new.human_delay_max_ms     is distinct from old.human_delay_max_ms
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % e imutavel (status=%): mudanca de conteudo = versao draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function public.fn_ai_agent_version_content_immutable();

notify pgrst, 'reload schema';
