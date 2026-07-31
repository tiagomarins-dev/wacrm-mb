import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });

  // Colunas extras (fora de phone/name/email/company/tags) viram `extras` —
  // o background do lead usado pelo agente de IA no broadcast.
  it('captures unrecognized columns as extras', () => {
    const csv = `phone,name,objetivo,dificuldade
+15551234567,Alice,Passar no ENEM,"Argumentação, repertório"
+15559876543,Bob,,Tempo de estudo`;

    const { rows } = parseContactCsv(csv);
    expect(rows[0].extras).toEqual({
      objetivo: 'Passar no ENEM',
      dificuldade: 'Argumentação, repertório',
    });
    // Célula extra vazia não vira chave.
    expect(rows[1].extras).toEqual({ dificuldade: 'Tempo de estudo' });
  });

  it('leaves extras undefined when there are no extra columns', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv).rows[0].extras).toBeUndefined();
  });

  it('normalizes extra headers (quotes/whitespace) via the shared header cleanup', () => {
    const csv = `phone," Objetivo "
+15551234567,Passar de ano`;

    expect(parseContactCsv(csv).rows[0].extras).toEqual({
      objetivo: 'Passar de ano',
    });
  });
});
