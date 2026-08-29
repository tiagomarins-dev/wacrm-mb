"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Trampolim do link "Enviar mensagem" da Plataforma MB: recebe o telefone do
// aluno, resolve contato + conversa na conexão de Suporte e joga direto na
// thread. Fica sob /inbox de propósito — assim o guard de sessão do middleware
// (que casa por prefixo) já protege a rota e monta o ?next= sozinho.
//
// É página e não Route Handler porque a resolução ESCREVE (cria contato e
// conversa): num GET, qualquer pré-carregamento de link — scanner corporativo,
// antivírus de e-mail, prefetch do navegador — criaria registros fantasma.
//
// Sem <Suspense>: o layout raiz já é dinâmico (lê cookie de idioma), então
// useSearchParams aqui não força prerender, igual à página do inbox.

/** Mapeia o `code` da API para a chave de tradução da mensagem. */
function chaveDoErro(code: string | undefined, status: number): string {
  if (code === "invalid_phone") return "openLinkInvalidPhone";
  if (code === "support_connection_unavailable")
    return "openLinkNoSupportConnection";
  if (status === 429) return "openLinkRateLimited";
  return "openLinkFailed";
}

export default function AbrirConversaPage() {
  const { t } = useTranslation("inbox");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [erro, setErro] = useState<string | null>(null);

  // O StrictMode roda effects duas vezes em desenvolvimento. A idempotência do
  // banco cobre o duplo POST, mas o guard evita gastar cota do limite de uso.
  const disparado = useRef(false);

  const tel = searchParams.get("tel");
  const nome = searchParams.get("nome");

  // Link sem telefone é erro de montagem do link, não de execução: resolve no
  // render em vez de virar setState dentro do effect.
  const erroExibido = tel ? erro : "openLinkInvalidPhone";

  useEffect(() => {
    if (disparado.current || !tel) return;
    disparado.current = true;

    (async () => {
      try {
        // connection_id não é enviado: o servidor decide, e é sempre o Suporte.
        const res = await fetch("/api/conversations/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: tel, nome }),
        });

        if (res.status === 401) {
          // Sessão caiu no meio do caminho: volta pro login guardando ESTA url,
          // não o /inbox — senão o destino do aluno se perde.
          const destino = `/inbox/abrir?${searchParams.toString()}`;
          router.replace(`/login?next=${encodeURIComponent(destino)}`);
          return;
        }

        if (!res.ok) {
          const corpo = await res.json().catch(() => ({}));
          setErro(chaveDoErro(corpo?.code, res.status));
          return;
        }

        const { conversation_id } = await res.json();
        // replace: tira a URL com o telefone do histórico e impede que o Voltar
        // caia aqui de novo e redispare a abertura.
        router.replace(`/inbox?c=${conversation_id}`);
      } catch {
        setErro("openLinkFailed");
      }
    })();
  }, [tel, nome, router, searchParams]);

  if (erroExibido) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-sm text-muted-foreground">{t(erroExibido)}</p>
        <Link
          href="/inbox"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          {t("openLinkBackToInbox")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{t("openLinkLoading")}</p>
    </div>
  );
}
