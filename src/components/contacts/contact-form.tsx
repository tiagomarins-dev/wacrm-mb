'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useActiveConnection } from '@/hooks/use-active-connection';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import { withBrazilCountryCode } from '@/lib/whatsapp/phone-utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle, Search, X } from 'lucide-react';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  contactTags?: ContactTag[];
  onSaved: () => void;
  /** Open an existing contact's detail view — used by the duplicate
   *  notice to jump to the contact that already owns this number. */
  onViewExisting?: (contactId: string) => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  contactTags = [],
  onSaved,
  onViewExisting,
}: ContactFormProps) {
  const supabase = createClient();
  const { t } = useTranslation('contacts');
  const { accountId } = useAuth();
  // Conexão ativa (multi-número, 033): novo contato nasce nela e o dedup
  // é por-conexão (mesmo número em 2 conexões = 2 contatos).
  const { activeConnectionId } = useActiveConnection();
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);

  // Duplicate-phone detection for NEW contacts. `exact` (same digits)
  // hard-blocks the save; a fuzzy trunk-variant match only warns. The
  // DB unique index (migration 022) is the real backstop — this is the
  // friendly heads-up before we get there.
  const [dupMatch, setDupMatch] = useState<
    { contact: ExistingContact; exact: boolean } | null
  >(null);
  const [checkingDup, setCheckingDup] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [tagQuery, setTagQuery] = useState('');

  // Separa as tags escolhidas (sempre visíveis em chips removíveis) das
  // disponíveis, filtradas pela busca. Contas com dezenas de tags precisam
  // disso para o seletor caber numa caixa rolável pequena.
  const selectedTags = useMemo(
    () => tags.filter((tag) => selectedTagIds.includes(tag.id)),
    [tags, selectedTagIds],
  );
  const availableTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return tags.filter(
      (tag) =>
        !selectedTagIds.includes(tag.id) &&
        (!q || tag.name.toLowerCase().includes(q)),
    );
  }, [tags, selectedTagIds, tagQuery]);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setSelectedTagIds(contactTags.map((ct) => ct.tag_id));
      setDupMatch(null);
      setTagQuery('');
      fetchTags();
    }
  }, [open, contact]);

  // Look up an existing contact with this number (new contacts only).
  // Runs on blur so we don't query on every keystroke.
  async function checkDuplicate() {
    if (isEdit || !accountId) return;
    const value = withBrazilCountryCode(phone);
    if (!value) {
      setDupMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      const existing = await findExistingContact(
        supabase,
        accountId,
        value,
        activeConnectionId ?? undefined,
      );
      setDupMatch(
        existing
          ? { contact: existing, exact: isExactMatch(existing, value) }
          : null,
      );
    } finally {
      setCheckingDup(false);
    }
  }

  async function fetchTags() {
    setLoadingTags(true);
    const { data } = await supabase
      .from('tags')
      .select('*')
      .order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!phone.trim()) {
      toast.error('Phone number is required');
      return;
    }

    // Hard-block an exact duplicate on create (the DB unique index is
    // the real backstop; this avoids a round-trip + a raw error toast).
    if (!isEdit && dupMatch?.exact) {
      toast.error('A contact with this phone number already exists');
      return;
    }

    setSaving(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      let contactId = contact?.id;

      if (isEdit && contactId) {
        const { error } = await supabase
          .from('contacts')
          .update({
            name: name.trim() || null,
            // Na edição, o 55 só entra se o atendente mexeu no telefone: um
            // número estrangeiro já gravado (wa_id) não pode ser reescrito ao
            // salvar só o nome.
            phone: phone === contact?.phone ? phone.trim() : withBrazilCountryCode(phone),
            email: email.trim() || null,
            company: company.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contactId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            connection_id: activeConnectionId ?? null,
            name: name.trim() || null,
            phone: withBrazilCountryCode(phone),
            email: email.trim() || null,
            company: company.trim() || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        contactId = data.id;
      }

      // Sync tags
      if (contactId) {
        await supabase
          .from('contact_tags')
          .delete()
          .eq('contact_id', contactId);

        if (selectedTagIds.length > 0) {
          const tagRows = selectedTagIds.map((tag_id) => ({
            contact_id: contactId!,
            tag_id,
          }));
          const { error: tagError } = await supabase
            .from('contact_tags')
            .insert(tagRows);
          if (tagError) throw tagError;
        }
      }

      toast.success(isEdit ? 'Contact updated' : 'Contact created');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      // The unique index (migration 022) rejects a duplicate phone that
      // slipped past the on-blur check (race, or a format that
      // normalizes equal). Surface it as the friendly duplicate notice
      // and, for new contacts, point the user at the existing record.
      if (isUniqueViolation(err)) {
        toast.error('A contact with this phone number already exists');
        if (!isEdit && accountId) {
          const existing = await findExistingContact(
            supabase,
            accountId,
            withBrazilCountryCode(phone),
            activeConnectionId ?? undefined,
          );
          if (existing) setDupMatch({ contact: existing, exact: true });
        }
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to save contact';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Altura limitada à viewport: os campos rolam por dentro e o rodapé
          com Cancelar/Criar fica sempre visível em tela baixa. */}
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? 'Edit Contact' : 'Add Contact'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit
              ? 'Update the contact details below.'
              : 'Fill in the details to create a new contact.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <div className="space-y-2">
              <Label htmlFor="cf-name" className="text-muted-foreground">
                Name
              </Label>
              <Input
                id="cf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Doe"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-phone" className="text-muted-foreground">
                Phone <span className="text-red-400">*</span>
              </Label>
              <Input
                id="cf-phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (dupMatch) setDupMatch(null);
                }}
                onBlur={checkDuplicate}
                placeholder="+1 234 567 8900"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              {dupMatch ? (
                <div
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                    dupMatch.exact
                      ? 'border-red-500/40 bg-red-500/10 text-red-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <div className="space-y-1">
                    <p>
                      {dupMatch.exact
                        ? 'A contact with this phone number already exists.'
                        : 'A contact with a very similar number already exists.'}
                    </p>
                    {onViewExisting && (
                      <button
                        type="button"
                        onClick={() => onViewExisting(dupMatch.contact.id)}
                        className="font-medium underline underline-offset-2 hover:no-underline"
                      >
                        View {dupMatch.contact.name || dupMatch.contact.phone}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Include country code, e.g. +1 for US
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-email" className="text-muted-foreground">
                Email
              </Label>
              <Input
                id="cf-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cf-company" className="text-muted-foreground">
                Company
              </Label>
              <Input
                id="cf-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Acme Inc."
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Tags</Label>
              {loadingTags ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="size-3 animate-spin" />
                  Loading tags...
                </div>
              ) : tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No tags available. Create tags in Settings.
                </p>
              ) : (
                <div className="space-y-2">
                  {selectedTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedTags.map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          aria-label={t('removeTagAria', { name: tag.name })}
                          className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-current cursor-pointer"
                          style={{ backgroundColor: tag.color + '20', color: tag.color }}
                        >
                          {tag.name}
                          <X className="size-3" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={tagQuery}
                      onChange={(e) => setTagQuery(e.target.value)}
                      // Enter na busca não pode enviar o formulário do contato.
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      placeholder={t('tagSearchPlaceholder')}
                      className="h-8 pl-8 bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                  {availableTags.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {tagQuery.trim() ? t('tagNoMatch') : t('tagAllSelected')}
                    </p>
                  ) : (
                    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-border p-2">
                      {availableTags.map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium opacity-70 transition-opacity hover:opacity-100 cursor-pointer"
                          style={{ backgroundColor: tag.color + '20', color: tag.color }}
                        >
                          {tag.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || checkingDup || (!isEdit && !!dupMatch?.exact)}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
