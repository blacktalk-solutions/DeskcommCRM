"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { useT } from "@/hooks/i18n/useT";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` — a mesma lista única da tela de
 * Credenciais e da rota. Como literal aqui, o seletor de modelo do agente não
 * conseguia representar um agente publicado em OpenRouter.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

export interface ModelOption {
  provider: Provider;
  model_id: string;
  display_name: string;
  context_window: number | null;
  is_default_for_provider: boolean;
}

interface Props {
  provider: Provider;
  value: string;
  onChange: (modelId: string, ctx?: { contextWindow: number | null }) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Texto do estado "nada escolhido". Existe porque nem todo uso deste seletor
   * trata vazio como erro: no papel Operador, vazio SIGNIFICA "usa o mesmo
   * modelo que conversa", e chamar isso de "Selecione um modelo" mentiria.
   */
  placeholder?: string;
}

interface ApiResponse {
  data: { models: ModelOption[] };
}

/** Abaixo disto a lista já cabe na tela sem rolar — a busca só atrapalharia. */
const MINIMO_PARA_MOSTRAR_BUSCA = 8;

/** O fabricante é o prefixo antes de "/" no model_id (ex.: "anthropic/claude-..."). */
function fabricanteDe(modelId: string): string {
  return modelId.split("/")[0] ?? "";
}

/**
 * Ordena por fabricante e depois por nome — a OpenRouter devolve ~437 modelos
 * na ordem crua da própria API, sem previsibilidade nenhuma pra achar algo
 * (issue #2). Os `is_default_for_provider` sobem pro topo do fabricante deles.
 */
function ordenarModelos(models: ReadonlyArray<ModelOption>): ModelOption[] {
  return [...models].sort((a, b) => {
    const fa = fabricanteDe(a.model_id);
    const fb = fabricanteDe(b.model_id);
    if (fa !== fb) return fa.localeCompare(fb);
    if (a.is_default_for_provider !== b.is_default_for_provider) {
      return a.is_default_for_provider ? -1 : 1;
    }
    return a.display_name.localeCompare(b.display_name);
  });
}

function filtrarModelos(models: ReadonlyArray<ModelOption>, busca: string): ModelOption[] {
  const termo = busca.trim().toLowerCase();
  if (!termo) return [...models];
  return models.filter(
    (m) =>
      m.display_name.toLowerCase().includes(termo) || m.model_id.toLowerCase().includes(termo),
  );
}

export function ModelPicker({ provider, value, onChange, disabled, id, placeholder }: Props) {
  const t = useT();
  const [busca, setBusca] = React.useState("");
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });

  const models = query.data ?? [];
  const modelosOrdenados = React.useMemo(() => ordenarModelos(query.data ?? []), [query.data]);
  const modelosFiltrados = React.useMemo(
    () => filtrarModelos(modelosOrdenados, busca),
    [modelosOrdenados, busca],
  );

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {models.length > MINIMO_PARA_MOSTRAR_BUSCA ? (
        <Input
          type="text"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar por nome ou fabricante…")}
          aria-label={t("Buscar modelo")}
          disabled={disabled}
        />
      ) : null}
      <Select
        value={value || undefined}
        onValueChange={(v) => {
          const m = models.find((m) => m.model_id === v);
          onChange(v, { contextWindow: m?.context_window ?? null });
        }}
        disabled={disabled || query.isLoading}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))} />
        </SelectTrigger>
        <SelectContent>
          {modelosFiltrados.map((m) => (
            <SelectItem key={m.model_id} value={m.model_id}>
              {m.display_name}
              {m.is_default_for_provider ? ` · ${t("default")}` : ""}
            </SelectItem>
          ))}
          {modelosFiltrados.length === 0 ? (
            <SelectItem value="__none__" disabled>
              {query.isLoading
                ? t("Carregando…")
                : busca
                  ? t("Nenhum modelo encontrado para essa busca")
                  : t("Nenhum modelo disponível")}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}

export function useModelMeta(provider: Provider, modelId: string): ModelOption | null {
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });
  return (query.data ?? []).find((m) => m.model_id === modelId) ?? null;
}
