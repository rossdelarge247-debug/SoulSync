import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, OptionCard, OptionCardGroup } from '@/components/form';
import { Notice } from '@/components/primitives';

import {
  setWishlistRetryProfile,
  WISHLIST_QUERY_KEY,
  wishlistRetryProfileQueryOptions,
} from '../../wishlist/-wishlist.api';
import styles from './wanted-page.module.css';

/**
 * How long a track that keeps not turning up waits between scheduled searches
 * (the old Wishlist "Retry Profile" select). A custom ladder can only be set
 * through the API; when one is active it shows, and can't be picked here.
 */
export function RetryTimingDialog({
  open,
  profileId,
  onClose,
}: {
  open: boolean;
  profileId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ ...wishlistRetryProfileQueryOptions(profileId), enabled: open });
  const active = query.data?.profile?.name ?? '';
  const [choice, setChoice] = useState(active);
  useEffect(() => setChoice(active), [active]);

  const save = useMutation({
    mutationFn: (name: string) => setWishlistRetryProfile(name),
    onSuccess: async (response) => {
      window.showToast?.(
        `Not-found tracks now use ${response.profile?.label ?? 'that'} timing`,
        'success',
      );
      await queryClient.invalidateQueries({ queryKey: [...WISHLIST_QUERY_KEY, 'retry-profile'] });
      onClose();
    },
    onError: (error: Error) => window.showToast?.(`Couldn't change it: ${error.message}`, 'error'),
  });

  const profiles = query.data?.profiles ?? [];
  const chosen = profiles.find((p) => p.name === choice);

  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.dialog}
    >
      <DialogHeader title="How often to try again" />
      <DialogBody>
        <p className={styles.dialogText}>
          A track that isn&apos;t found is searched for again on every scheduled search at first,
          then less often the more times it fails. Search now always tries straight away.
        </p>
        {query.isError ? (
          <Notice tone="danger" role="alert" title="Couldn't load the timings">
            SYNCHRO.S didn&apos;t answer. Nothing changed.
          </Notice>
        ) : (
          <OptionCardGroup>
            {profiles.map((profile) => (
              <OptionCard
                key={profile.name}
                selected={profile.name === choice}
                disabled={profile.name === 'custom'}
                title={
                  profile.name === 'custom'
                    ? `${profile.label} (set through the API)`
                    : profile.label
                }
                description={profile.description}
                onClick={() => setChoice(profile.name)}
              />
            ))}
          </OptionCardGroup>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!chosen || choice === active || save.isPending}
          disabledReason={chosen && choice === active ? 'This is the timing in use.' : undefined}
          onClick={() => chosen && save.mutate(chosen.name)}
        >
          {chosen ? `Use ${chosen.label}` : 'Use this timing'}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
