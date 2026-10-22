/**
 * "Set a quality target" (boards 2q, 2r): the four presets as cards with how
 * much of your library already meets each, what the choice means for new
 * searches and for what you already have, and one primary that names the
 * target. Writes through PUT /api/quality/target, which edits the default
 * quality profile the way Settings → Quality does.
 *
 * "Upgrade what I already have" shows only when an enabled "Apply Quality
 * Upgrades" automation can act on it, and opens on what the profile does now.
 * A 409 (the profile was saved somewhere else meanwhile) is the dialog failure
 * pattern of board 2s: a warning Notice, the cards faded, and a primary that
 * shows the new numbers.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { LoadingState, Notice, Skeleton } from '@/components/primitives';

import type { QualityPresets, SetTargetFailure } from './quality.api';
import type { PresetKey } from './quality.model';

import styles from './quality-dialog.module.css';
import {
  automationsPausedQueryOptions,
  automationsQueryOptions,
  putQualityTarget,
  QUALITY_PRESETS_KEY,
  qualityPresetsQueryOptions,
  SetTargetError,
} from './quality.api';
import { PRESET_COPY } from './quality.model';
import {
  consequence,
  findUpgradeHelper,
  footerText,
  initialPreset,
  isUnchanged,
  meetsLine,
  shortLine,
  subtitle,
} from './quality.view';

export interface SetQualityTargetDialogProps {
  open: boolean;
  onClose: () => void;
  /** After a save, with the new numbers (Home refreshes its Quality card). */
  onSaved?: (presets: QualityPresets) => void;
  /** Only an admin can save (PUT /api/quality/target is admin only). */
  isAdmin: boolean;
}

function CardSkeletons() {
  return (
    <div className={styles.cards} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div className={styles.cardSkeleton} key={i}>
          <Skeleton className={styles.skelTitle} />
          <Skeleton className={styles.skelLine} />
          <Skeleton className={styles.skelMeta} />
        </div>
      ))}
    </div>
  );
}

export function SetQualityTargetDialog({
  open,
  onClose,
  onSaved,
  isAdmin,
}: SetQualityTargetDialogProps) {
  const queryClient = useQueryClient();
  const presets = useQuery({ ...qualityPresetsQueryOptions(), enabled: open });
  const automations = useQuery({ ...automationsQueryOptions(), enabled: open });
  const paused = useQuery({ ...automationsPausedQueryOptions(), enabled: open });

  const [selected, setSelected] = useState<PresetKey | null>(null);
  const [upgrade, setUpgrade] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<SetTargetFailure | null>(null);

  // a fresh dialog opens on the target you have
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setUpgrade(null);
      setFailure(null);
    }
  }, [open]);

  const data = presets.data;
  const current = data?.current;
  const choice: PresetKey = selected ?? initialPreset(current);
  const helper = useMemo(
    () => findUpgradeHelper(automations.data, paused.data === true, Date.now()),
    [automations.data, paused.data],
  );
  const view = data ? consequence(data, choice, helper) : null;
  const upgradeChecked = upgrade ?? Boolean(current?.upgrade_existing);
  const canUpgrade = Boolean(view?.canUpgrade);
  const unchanged = isUnchanged(current, choice, upgradeChecked, canUpgrade);
  const conflict = failure?.kind === 'changed';

  const save = useMutation({
    mutationFn: () =>
      putQualityTarget({
        preset: choice,
        // nothing can honour it: leave the profile's policy as it is
        upgradeExisting: canUpgrade ? upgradeChecked : Boolean(current?.upgrade_existing),
        basedOn: current?.updated_at ?? null,
      }),
    onMutate: () => setFailure(null),
    onSuccess: (body) => {
      queryClient.setQueryData(QUALITY_PRESETS_KEY, body);
      window.showToast?.(
        `Quality target set to ${body.current?.name ?? PRESET_COPY[choice].title}`,
        'success',
      );
      onSaved?.(body);
      onClose();
    },
    onError: (error) => {
      setFailure(
        error instanceof SetTargetError
          ? error.failure
          : { kind: 'failed', message: "SYNCHRO.S couldn't save the target. Nothing changed." },
      );
    },
  });

  const showNewNumbers = () => {
    setFailure(null);
    setSelected(null);
    setUpgrade(null);
    void presets.refetch();
  };

  let primary: React.ReactNode;
  if (conflict) {
    primary = (
      <Button size="lg" variant="primary" onClick={showNewNumbers}>
        Show the new numbers
      </Button>
    );
  } else {
    const reason = !data
      ? null
      : !isAdmin
        ? 'Only an admin can change the quality target.'
        : unchanged
          ? 'This is already your target.'
          : null;
    primary = (
      <Button
        size="lg"
        variant="primary"
        disabled={!data || Boolean(reason) || save.isPending}
        disabledReason={reason}
        focusableWhenDisabled
        onClick={() => {
          if (!save.isPending) save.mutate();
        }}
      >
        {save.isPending ? 'Setting target…' : `Set target to ${PRESET_COPY[choice].title}`}
      </Button>
    );
  }

  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.popup}
    >
      <DialogHeader title="Quality target">
        <p className={styles.subtitle}>
          <span className={styles.wideOnly}>{subtitle(helper)}</span>
          <span className={styles.phoneOnly}>The least you’ll accept.</span>
        </p>
      </DialogHeader>
      <DialogBody>
        {presets.isPending ? (
          <LoadingState label="Counting your library…">
            <CardSkeletons />
          </LoadingState>
        ) : !data ? (
          <>
            <Notice
              tone="danger"
              role="alert"
              title="Couldn’t count your library"
              actions={
                <Button size="lg" onClick={() => void presets.refetch()}>
                  {presets.isFetching ? 'Trying…' : 'Try again'}
                </Button>
              }
            >
              SYNCHRO.S didn’t answer, so the dialog can’t say how much of your library meets each
              target. Your target hasn’t changed.
            </Notice>
            <CardSkeletons />
          </>
        ) : (
          <>
            {conflict ? (
              <Notice tone="warning" role="alert" title="The target changed while this was open">
                {failure?.message} Show the new numbers, then choose again.
              </Notice>
            ) : failure ? (
              <Notice tone="danger" role="alert" title="That didn’t go through">
                {failure.message}
              </Notice>
            ) : null}
            <fieldset
              className={styles.cards}
              data-faded={conflict ? 'true' : undefined}
              disabled={conflict}
            >
              <legend className={styles.srOnly}>Quality target</legend>
              {data.presets.map((preset) => {
                const isSelected = preset.key === choice;
                return (
                  <label
                    key={preset.key}
                    className={styles.card}
                    data-selected={isSelected ? 'true' : undefined}
                    data-testid={`preset-${preset.key}`}
                  >
                    <span className={styles.cardHead}>
                      <span className={styles.cardTitle}>{PRESET_COPY[preset.key].title}</span>
                      <input
                        type="radio"
                        name="quality-target"
                        className={styles.radio}
                        value={preset.key}
                        checked={isSelected}
                        onChange={() => setSelected(preset.key)}
                      />
                    </span>
                    <span className={`${styles.cardText} ${styles.wideOnly}`}>
                      {PRESET_COPY[preset.key].long}
                    </span>
                    <span className={`${styles.cardMeta} ${styles.wideOnly}`}>
                      {meetsLine(preset)}
                    </span>
                    <span className={`${styles.cardText} ${styles.phoneOnly}`}>
                      {shortLine(preset)}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {view ? (
              <div
                className={styles.panel}
                data-faded={conflict ? 'true' : undefined}
                data-testid="quality-consequence"
              >
                <p className={`${styles.panelText} ${styles.wideOnly}`}>
                  <strong>{view.lead}</strong> {view.searches} {view.belowText}
                </p>
                <p className={`${styles.panelText} ${styles.phoneOnly}`}>{view.short}</p>
                {view.canUpgrade ? (
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={upgradeChecked}
                      disabled={conflict}
                      onChange={(event) => setUpgrade(event.target.checked)}
                    />
                    <span className={styles.wideOnly}>
                      Upgrade what I already have, as better copies turn up
                    </span>
                    <span className={styles.phoneOnly}>Upgrade what I already have</span>
                  </label>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {current ? <span className={styles.footMeta}>{footerText(current)}</span> : null}
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        {primary}
      </DialogFooter>
    </DialogFrame>
  );
}
