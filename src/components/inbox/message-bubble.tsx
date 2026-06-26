"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Download,
} from "lucide-react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { withConversation } from "@/lib/whatsapp/media-url";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

// Bolha de áudio com botão "Ler transcrição". A transcrição é preenchida
// assíncrono (gatilho/cron) e chega via realtime — quando transcription_status
// vira done/empty, o botão aparece. Render como TEXTO PURO (React escapa).
function AudioMessage({ message }: { message: Message }) {
  const { t } = useTranslation("inbox");
  const [open, setOpen] = useState(false);
  const st = message.transcription_status;
  return (
    <div>
      {message.media_url ? (
        <audio
          src={withConversation(message.media_url, message.conversation_id)}
          controls
          className="max-w-60"
        />
      ) : (
        <MediaUnavailable label="Audio" />
      )}
      {(st === "done" || st === "empty") && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs underline opacity-80 hover:opacity-100"
          >
            {open ? t("hideTranscription") : t("readTranscription")}
          </button>
          {open && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {st === "empty" ? t("audioNoContent") : message.transcription}
            </p>
          )}
        </div>
      )}
      {(st === "pending" || st === "running") && (
        <p className="mt-1 text-xs opacity-60">{t("transcribing")}</p>
      )}
    </div>
  );
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} unavailable</span>
    </div>
  );
}

// Renderiza a imagem do anexo: carrega via fetch autenticado (proxy),
// abre em lightbox no clique e oferece download com a extensão correta.
function MediaImage({
  url,
  alt,
  conversationId,
  downloadBase,
}: {
  url: string;
  alt: string;
  conversationId?: string;
  downloadBase: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [mime, setMime] = useState<string>(""); // MIME real p/ extensão do download
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false); // lightbox aberto?

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        // anexa o conversationId p/ o proxy escolher o token certo (multi-número)
        const res = await fetch(withConversation(url, conversationId));
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        setMime(blob.type);
        setSrc(URL.createObjectURL(blob));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url, conversationId]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // extensão a partir do MIME real (image/png -> png), fallback jpg
  const ext = mime.startsWith("image/") ? mime.slice(6).split("+")[0] : "jpg";
  const downloadName = `${downloadBase}.${ext || "jpg"}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block cursor-zoom-in"
      >
        <img
          src={src ?? ""}
          alt={alt}
          className="max-h-64 max-w-60 rounded-lg object-cover"
          onError={() => setError(true)}
        />
      </button>

      {/* Lightbox: reusa o mesmo src (blobUrl), sem novo fetch */}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[92vw] sm:max-w-3xl">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <DialogDescription className="sr-only">
            Imagem em tamanho original
          </DialogDescription>
          <img
            src={src ?? ""}
            alt={alt}
            className="max-h-[80vh] w-full object-contain"
          />
          <a
            href={src ?? "#"}
            download={downloadName}
            className={buttonVariants({
              variant: "secondary",
              size: "sm",
              className: "w-fit",
            })}
          >
            <Download className="size-4" />
            Baixar
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MessageContent({ message }: { message: Message }) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage
              url={message.media_url}
              alt="Shared image"
              conversationId={message.conversation_id}
              downloadBase={`imagem-${message.message_id ?? "anexo"}`}
            />
          ) : (
            <MediaUnavailable label="Image" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={withConversation(message.media_url, message.conversation_id)}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label="Video" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return <AudioMessage message={message} />;

    case "document": {
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || "Document"} />;
      }
      // content_text pode trazer / ou quebras de linha — sanitiza p/ nome de arquivo
      const docName = (message.content_text || "documento").replace(
        /[/\\\r\n]+/g,
        "_",
      );
      const href = withConversation(message.media_url, message.conversation_id);
      return (
        <div className="flex items-center gap-2">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
          >
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {message.content_text || "Document"}
            </span>
          </a>
          <a
            href={href}
            download={docName}
            aria-label="Baixar documento"
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <Download className="size-4" />
          </a>
        </div>
      );
    }

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            Template
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Location shared"}</span>
        </div>
      );

    case "interactive": {
      // Customer tapped a reply button or list row on a message the bot
      // sent. We show the tapped option's title (already in content_text,
      // set by parseMessageContent in the webhook) with a small affordance
      // so agents reading the inbox can tell at a glance that this is a
      // tap rather than the customer typing the same words.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <CornerDownLeft className="h-3 w-3" />
            Button reply
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "[Interactive reply]"}
          </p>
        </div>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || "[Unsupported message type]"}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
