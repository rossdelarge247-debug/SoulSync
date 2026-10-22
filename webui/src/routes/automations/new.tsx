import { createFileRoute } from '@tanstack/react-router';

import { parseEditorSearch } from './-automations.types';
import { AutomationEditorPage } from './-ui/editor-page';

/** A new automation, in the block editor (`?from=assistant`: from a draft). */
export const Route = createFileRoute('/automations/new')({
  validateSearch: (search: Record<string, unknown>) => parseEditorSearch(search),
  component: NewAutomationPage,
});

function NewAutomationPage() {
  const { from } = Route.useSearch();
  return <AutomationEditorPage automationId={null} fromAssistant={from === 'assistant'} />;
}
