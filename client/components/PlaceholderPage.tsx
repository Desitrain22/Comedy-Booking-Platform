import { Construction } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { PageHeader } from './ui/PageHeader';

export interface PlaceholderPageProps {
  title: string;
  description?: ReactNode;
  /** What will live here, e.g. "F1 builds the month calendar here." */
  note?: ReactNode;
}

/** Foundation placeholder for feature pages that haven't been built yet. */
export function PlaceholderPage({ title, description, note }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <EmptyState icon={Construction} title="Coming soon" description={note} />
      </Card>
    </>
  );
}
