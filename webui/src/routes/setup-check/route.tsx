import { createFileRoute } from '@tanstack/react-router';

import { guardPageAccess } from '@/platform/shell/route-guard';

import { SetupCheckPage } from './-ui/setup-check-page';

// No loader: the full check can take 25 seconds, so the page renders at once
// and shows the fast folder results while slskd and the media server answer.
export const Route = createFileRoute('/setup-check')({
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'setup-check');
  },
  component: SetupCheckPage,
});
