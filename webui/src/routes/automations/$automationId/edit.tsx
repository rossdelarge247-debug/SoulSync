import { createFileRoute } from '@tanstack/react-router';

import { AutomationEditorPage } from '../-ui/editor-page';

/** One automation, in the full-page editor (`/automations/12/edit`). */
export const Route = createFileRoute('/automations/$automationId/edit')({
  component: EditAutomationPage,
});

function EditAutomationPage() {
  const { automationId } = Route.useParams();
  const id = Number.parseInt(automationId, 10);
  return <AutomationEditorPage key={automationId} automationId={Number.isFinite(id) ? id : -1} />;
}
