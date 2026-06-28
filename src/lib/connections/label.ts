// ============================================================
// Rótulo de exibição de uma conexão. Fonte única reusada no dropdown
// (connection-switcher) e nos cards de settings. Fallback em cadeia:
// label (apelido) → phone_number_id → instance_name (Evolution, fase C)
// → 'Conexão'. Trim no label evita apelido só-espaços virar rótulo.
// ============================================================

// Entrada estrutural mínima — não acopla a WhatsAppConfig/Connection e
// já tolera instance_name (provider Evolution, fase C).
export interface ConnectionLabelInput {
  label?: string | null;
  phone_number_id?: string | null;
  instance_name?: string | null;
}

// Resolve o rótulo amigável de uma conexão (com fallback em cadeia).
export function connectionLabel(c: ConnectionLabelInput): string {
  return c.label?.trim() || c.phone_number_id || c.instance_name || "Conexão";
}
