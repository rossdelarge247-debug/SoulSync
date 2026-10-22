import { createFileRoute } from '@tanstack/react-router';

import { parseEditorSearch } from '../-automations.types';
import { AutomationEditorPage } from '../-ui/editor-page';

/** One automation, in the block editor (`/automations/12/edit`). */
export const Route = createFileRoute('/automations/$automationId/edit')({
  validateSearch: (search: Record<string, unknown>) => parseEditorSearch(search),
  component: EditAutomationPage,
});

function EditAutomationPage() {
  const { automationId } = Route.useParams();
  const { from } = Route.useSearch();
  const id = Number.parseInt(automationId, 10);
  return (
    <AutomationEditorPage
      key={automationId}
      automationId={Number.isFinite(id) ? id : -1}
      fromAssistant={from === 'assistant'}
    />
  );
}
