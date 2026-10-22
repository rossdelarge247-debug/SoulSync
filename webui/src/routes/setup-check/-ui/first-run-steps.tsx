import clsx from 'clsx';

import { appURL } from '@/platform/url-base';

import type { FirstRunStep } from '../-setup-check.types';

import { STEP_WORD, plural } from '../-setup-check.helpers';
import { TickIcon } from './icons';
import styles from './setup-check-page.module.css';

/**
 * Shown only while first-run setup isn't finished (GET /api/setup/status).
 * Each step's state comes from the check results, so nothing here is stored.
 */
export function FirstRunSteps({ steps, problems }: { steps: FirstRunStep[]; problems: number }) {
  const settled = (s: FirstRunStep) => s.state === 'done' || s.state === 'not-needed';
  const doneCount = steps.filter(settled).length;
  const current = steps.findIndex((s) => !settled(s));
  const summary =
    doneCount === steps.length
      ? `All ${steps.length} steps done.`
      : `${doneCount} of ${steps.length} steps done.`;
  const left = problems ? ` ${plural(problems, 'problem')} left to fix.` : '';

  return (
    <section aria-labelledby="setup-check-steps" className={styles.steps}>
      <div className={styles.stepsHead}>
        <h2 id="setup-check-steps" className={styles.stepsTitle}>
          First-run setup
        </h2>
        <p className={styles.stepsSummary}>
          {summary}
          {left}
        </p>
      </div>
      <ol className={styles.stepList}>
        {steps.map((step, index) => {
          const isCurrent = index === current;
          return (
            <li
              key={step.id}
              className={clsx(styles.step, isCurrent && styles.stepCurrent)}
              data-state={step.state}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className={styles.stepBadge} aria-hidden="true">
                {settled(step) ? <TickIcon size={18} /> : index + 1}
              </span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{step.title}</span>
                <span className={styles.stepState}>
                  Step {index + 1} · {STEP_WORD[step.state]}
                  {isCurrent ? ' · you are here' : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className={styles.stepsNote}>
        The setup wizard opens each time SYNCHRO.S starts until you finish it.{' '}
        {/* a full load: init.js opens the wizard for ?setup=1 before the app starts */}
        <a className={styles.link} href={appURL('/setup-check?setup=1')}>
          Open the setup wizard
        </a>
      </p>
    </section>
  );
}
