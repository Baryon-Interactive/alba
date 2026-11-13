import { Textarea } from '@/components/ui/input';

export function OrderBodyEditor({ value, onChange }: { value: string; onChange: (body: string) => void }) {
  return <Textarea aria-label="Work order body" value={value} onChange={e => onChange(e.target.value)} className="min-h-64 font-mono text-[13px]" />;
}
