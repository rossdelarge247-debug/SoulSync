import clsx from 'clsx';

import formStyles from '@/components/form/form.module.css';

import styles from './activity-page.module.css';
import { AppLink, type AppLinkProps } from './app-link';

/**
 * A link that looks like the shared Button at 44px (lg): the filled
 * secondary by default, or ghost, or the primary (Review on the quarantine). For actions that go to another page
 * ("Choose", "Preview again", "Run Setup check"), which are links, not
 * buttons, to assistive tech and for open-in-new-tab.
 */
export function LinkButton({
  className,
  variant = 'default',
  ...props
}: AppLinkProps & { variant?: 'default' | 'ghost' | 'primary' }) {
  return (
    <AppLink
      className={clsx(formStyles.button, styles.linkButton, className)}
      data-variant={variant}
      data-size="lg"
      {...props}
    />
  );
}
