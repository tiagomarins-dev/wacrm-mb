"use client";

import { Check, Languages, Moon, Palette, SunMoon, Sun, Type } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/hooks/use-theme";
import { useLanguage } from "@/hooks/use-language";
import {
  FONT_SCALES_META,
  MODES,
  THEMES,
  type FontScale,
  type Mode,
  type ThemeId,
} from "@/lib/themes";
import { LANGUAGES_META, type Language } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Appearance panel — light/dark mode + accent-color picker.
 *
 * Two independent controls: a mode toggle (light / dark) and the
 * accent grid. Either applies + persists immediately. No save button:
 * each change is a single attribute swap on <html>, there's nothing
 * to roll back.
 *
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays both choices before first paint on subsequent
 * loads.
 */
export function AppearancePanel() {
  const { theme, setTheme, mode, setMode, fontScale, setFontScale } = useTheme();
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation(["settings", "common"]);
  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      {/* Idioma — primeiro controle: define o idioma de toda a UI. */}
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Languages className="size-4 text-muted-foreground" />
          {t("language")}
        </h3>

        <div
          role="radiogroup"
          aria-label={t("languageAria")}
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {LANGUAGES_META.map((l) => (
            <LanguageCard
              key={l.id}
              id={l.id}
              name={l.name}
              isActive={l.id === language}
              onPick={() => setLanguage(l.id)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SunMoon className="size-4 text-muted-foreground" />
          {t("mode")}
        </h3>

        <div
          role="radiogroup"
          aria-label={t("modeAria")}
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {MODES.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              isActive={m === mode}
              onPick={() => setMode(m)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Type className="size-4 text-muted-foreground" />
          {t("fontSize")}
        </h3>
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("fontSizeDesc")}
        </p>

        <div
          role="radiogroup"
          aria-label={t("fontSize")}
          className="grid max-w-md grid-cols-3 gap-3"
        >
          {FONT_SCALES_META.map((f) => (
            <FontScaleCard
              key={f.id}
              id={f.id}
              name={t(`fontScale_${f.id}`, { defaultValue: f.name })}
              hint={f.hint}
              sample={f.sample}
              isActive={f.id === fontScale}
              onPick={() => setFontScale(f.id)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Palette className="size-4 text-muted-foreground" />
          {t("accentColor")}
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((th) => (
            <ThemeCard
              key={th.id}
              id={th.id}
              name={th.name}
              tagline={th.tagline}
              swatch={th.swatch}
              isActive={th.id === theme}
              onPick={() => setTheme(th.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ModeCard({
  mode,
  isActive,
  onPick,
}: {
  mode: Mode;
  isActive: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const isLight = mode === "light";
  const Icon = isLight ? Sun : Moon;
  const label = t(isLight ? "modeLight" : "modeDark");
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={t("useModeAria", { mode: label })}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 text-sm font-semibold text-foreground">
        {label}
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          {t("common:active")}
        </span>
      )}
    </button>
  );
}

// Card do picker de idioma — espelha o ModeCard (radio, ring no ativo, chip).
function LanguageCard({
  id,
  name,
  isActive,
  onPick,
}: {
  id: Language;
  name: string;
  isActive: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={name}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="flex-1 text-sm font-semibold text-foreground">
        {name}
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          {t("active")}
        </span>
      )}
      <span className="sr-only">{id}</span>
    </button>
  );
}

function FontScaleCard({
  id,
  name,
  hint,
  sample,
  isActive,
  onPick,
}: {
  id: FontScale;
  name: string;
  hint: string;
  sample: number;
  isActive: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={t("fontSizeAria", { name })}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg border bg-card p-4 text-center transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      {/* Amostra em px fixo só para o preview — não usa rem, então não
          escala junto com o resto da UI; mostra a diferença relativa. */}
      <span
        aria-hidden
        className="font-semibold leading-none text-foreground"
        style={{ fontSize: `${sample}px` }}
      >
        Aa
      </span>
      <span className="text-sm font-medium text-foreground">{name}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
      {isActive && (
        <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          {t("common:active")}
        </span>
      )}
      <span className="sr-only">{id}</span>
    </button>
  );
}

function ThemeCard({
  id,
  name,
  tagline,
  swatch,
  isActive,
  onPick,
}: {
  id: ThemeId;
  name: string;
  tagline: string;
  swatch: string;
  isActive: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={isActive}
      aria-label={`Use ${name} theme`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-full"
          style={{
            background: swatch,
            boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.15)",
          }}
        />
        {isActive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3" />
            {t("active")}
          </span>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{name}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {tagline}
        </div>
      </div>
      <div
        className="mt-1 flex h-2 overflow-hidden rounded-full"
        aria-hidden
      >
        <span className="flex-1" style={{ background: swatch }} />
        <span className="w-3 bg-muted-foreground/60" />
        <span className="w-3 bg-muted" />
        <span className="w-3 bg-card" />
      </div>
      <span className="sr-only">Theme id: {id}</span>
    </button>
  );
}
