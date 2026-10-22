import { createFileRoute } from '@tanstack/react-router';

import { AutomationEditorPage } from './-ui/editor-page';

/** A new automation, in the full-page editor. */
export const Route = createFileRoute('/automations/new')({
  component: NewAutomationPage,
});

function NewAutomationPage() {
  return <AutomationEditorPage automationId={null} />;
}
