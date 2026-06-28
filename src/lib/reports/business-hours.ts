// ============================================================
// business-hours.ts — clipping de horário de atendimento (mirror puro testável).
// ⚠️ ESPELHA supabase/migrations/049_business_hours.sql (business_seconds_between).
//    Mudou a aritmética aqui? Mude também na função SQL — e vice-versa.
// Conta os segundos DENTRO do expediente entre 2 instantes; sem schedule = 24/7.
// Janela same-day (open<close); overnight (ex. 22:00–02:00) não suportado na v1.
// ============================================================

// Uma entrada do horário semanal. dow 0=dom..6=sáb; open/close em 'HH:MM'.
export type ScheduleEntry = { dow: number; enabled: boolean; open: string; close: string };

// Offset (ms) tal que: horário_local = utc + offset, para o instante dado no fuso.
function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// Converte um "relógio de parede" (y/mo/d hh:mm) no fuso `tz` para o instante UTC.
// Refina 1x p/ acertar a borda de DST (offset pode mudar no próprio dia).
function wallToUtc(tz: string, y: number, mo: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let off = tzOffsetMs(tz, new Date(guess));
  off = tzOffsetMs(tz, new Date(guess - off));
  return guess - off;
}

// Data-calendário (y/mo/d) de um instante no fuso `tz`.
function zonedYMD(tz: string, instant: Date): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day };
}

// Soma os segundos dentro do expediente entre start e end (clipping).
export function businessSecondsBetween(
  start: Date, end: Date, schedule: ScheduleEntry[] | null | undefined, tz: string,
): number {
  if (end.getTime() <= start.getTime()) return 0;
  // sem janela definida: comporta como 24/7 (diferença bruta)
  if (!schedule || schedule.length === 0) {
    return Math.ceil((end.getTime() - start.getTime()) / 1000);
  }
  let total = 0;
  const s = zonedYMD(tz, start);
  const e = zonedYMD(tz, end);
  // itera cada dia-calendário (no fuso) tocado pelo intervalo
  let cur = Date.UTC(s.y, s.mo - 1, s.d);
  const last = Date.UTC(e.y, e.mo - 1, e.d);
  while (cur <= last) {
    const c = new Date(cur);
    const y = c.getUTCFullYear(), mo = c.getUTCMonth() + 1, d = c.getUTCDate();
    const dow = c.getUTCDay(); // 0=dom..6=sáb (depende só da data, não do fuso)
    const entry = schedule.find((x) => x.dow === dow && x.enabled);
    if (entry) {
      const [oh, om] = entry.open.split(":").map(Number);
      const [ch, cm] = entry.close.split(":").map(Number);
      const winOpen = wallToUtc(tz, y, mo, d, oh, om);
      const winClose = wallToUtc(tz, y, mo, d, ch, cm);
      const segStart = Math.max(winOpen, start.getTime());
      const segEnd = Math.min(winClose, end.getTime());
      if (segEnd > segStart) total += Math.ceil((segEnd - segStart) / 1000);
    }
    cur += 86_400_000; // +1 dia (UTC midnight, sem DST)
  }
  return total;
}
