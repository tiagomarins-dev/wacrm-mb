import { useTranslation } from "react-i18next";

/**
 * Formatação de datas/números pelo idioma ativo.
 *
 * Centraliza o `Intl.*` para não espalhar `toLocaleDateString('en-US', …)`
 * hardcoded pelas telas. `lib/currency.ts` já cuida de moeda (BRL) — aqui é
 * data e número genérico.
 */

// Mapeia o id interno para um BCP-47 que o Intl entende ("pt-BR" já é válido).
function toIntlLocale(lng: string): string {
  return lng === "en" ? "en-US" : lng;
}

export function formatDate(
  value: Date | string | number,
  lng: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(
    toIntlLocale(lng),
    opts ?? { day: "numeric", month: "short", year: "numeric" },
  ).format(new Date(value));
}

export function formatDateTime(
  value: Date | string | number,
  lng: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(
    toIntlLocale(lng),
    opts ?? { dateStyle: "short", timeStyle: "short" },
  ).format(new Date(value));
}

export function formatNumber(
  value: number,
  lng: string,
  opts?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(toIntlLocale(lng), opts).format(value);
}

// Hook para client components: usa o idioma ativo do i18next.
export function useFormat() {
  const { i18n } = useTranslation();
  const lng = i18n.language;
  return {
    formatDate: (v: Date | string | number, o?: Intl.DateTimeFormatOptions) =>
      formatDate(v, lng, o),
    formatDateTime: (v: Date | string | number, o?: Intl.DateTimeFormatOptions) =>
      formatDateTime(v, lng, o),
    formatNumber: (v: number, o?: Intl.NumberFormatOptions) =>
      formatNumber(v, lng, o),
  };
}
