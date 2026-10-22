import { createFileRoute, redirect } from '@tanstack/react-router';

/** `/automations/12` is the list with that automation selected. */
export const Route = createFileRoute('/automations/$automationId/')({
  beforeLoad: ({ params }) => {
    const id = Number.parseInt(params.automationId, 10);
    throw redirect({
      to: '/automations',
      search: Number.isFinite(id) && id > 0 ? { automation: id } : {},
      replace: true,
    });
  },
});
