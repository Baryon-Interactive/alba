import { useId, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorBox } from '@/components/common';
import { errorText } from '@/lib/queries';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** A list of words as chips: type and press Enter (or a comma) to add, the cross to take one out. `options` are offered as you type. */
export function ChipsInput({ value, onChange, options, placeholder, label, className }: { value: string[]; onChange: (next: string[]) => void; options?: string[]; placeholder?: string; label: string; className?: string }) {
  const [text, setText] = useState('');
  const list = useId();
  const add = (raw: string) => {
    const items = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (items.length) onChange([...value, ...items.filter((x, i) => !value.includes(x) && items.indexOf(x) === i)]);
    setText('');
  };
  return (
    <div className={cn('flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1 shadow-xs focus-within:border-ring', className)}>
      {value.map(v => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pr-1 pl-2 font-mono text-xs">
          {v}
          <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t('Remove {name}', { name: v })} onClick={() => onChange(value.filter(x => x !== v))}><X className="size-3" /></button>
        </span>
      ))}
      <input
        list={options?.length ? list : undefined} value={text} aria-label={label} placeholder={value.length ? undefined : placeholder}
        className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        onChange={e => (e.target.value.endsWith(',') ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(text); }
          else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => add(text)}
      />
      {!!options?.length && <datalist id={list}>{options.filter(o => !value.includes(o)).map(o => <option key={o} value={o} />)}</datalist>}
    </div>
  );
}

/** Two or three choices side by side; the chosen one is filled. */
export function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-card p-0.5">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', value === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>{o.label}</button>
      ))}
    </div>
  );
}

/** A labelled field of an edit form, with what is wrong with it under it. */
export function Field({ label, hint, problem, children, className }: { label: string; hint?: string; problem?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid content-start gap-1', className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      {problem && <span className="text-xs text-destructive">{problem}</span>}
    </div>
  );
}

/**
 * One section of a configuration file being edited: its fields, then Cancel and Save. Save sends the section's edits in one write;
 * what the server refused is shown here, under the fields. `problems`: what is wrong before anything is sent.
 */
export function EditCard({ title, description, children, dirty, pending, error, problems = [], onSave, onCancel, saveLabel }: {
  title: ReactNode; description?: ReactNode; children: ReactNode; dirty: boolean; pending: boolean; error?: unknown; problems?: string[]; onSave: () => void; onCancel: () => void; saveLabel?: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-4">
        <div>
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {children}
        {problems.length > 0 && <div className="grid gap-0.5 text-xs text-destructive">{problems.map((p, i) => <div key={i}>{p}</div>)}</div>}
        {!!error && <ErrorBox error={errorText(error)} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={!dirty || pending} onClick={onCancel}>{t('Cancel')}</Button>
          <Button disabled={!dirty || pending || problems.length > 0} onClick={onSave}>{pending ? t('Working…') : saveLabel ?? t('Save')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
