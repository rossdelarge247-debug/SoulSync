/**
 * A mix set's chip (26i): the step line ends with the set's chip and who
 * chose it, always shown in a set, DJ mix or not, because it's part of the
 * set (it plays this way, and Traktor's export notes it). With DJ mix off
 * it's dimmed, with a line saying what plays instead (26g's last state);
 * Play as a mix plays it with its chips whatever the setting (28e).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { Step, Transition } from '@/features/sets/sets.api';

import { useAnalysis } from '@/features/dj/analysis-line';

import { TransitionChip } from './mix-chip';
import { AUTO_CHOICE, planFor, planKey, type Choice } from './plans';
import { usePrefs } from './prefs';

export function SetStepChip({
  transition,
  step,
  from,
  to,
  fromId,
  toId,
  onChange,
}: {
  transition: Transition | null | undefined;
  step: Step;
  from: string;
  to: string;
  fromId: string | null;
  toId: string | null;
  onChange: (next: Transition) => void;
}) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const choice: Choice = transition?.style
    ? { style: transition.style, bars: transition.bars ?? null }
    : AUTO_CHOICE;
  const ok = Boolean(fromId && toId);
  const plan = useQuery({
    queryKey: planKey(fromId ?? '', toId ?? '', choice, prefs.lean),
    queryFn: () => planFor(fromId!, toId!, choice, prefs.lean),
    enabled: ok,
    staleTime: 60_000,
    retry: false,
  });
  const auto = useQuery({
    queryKey: planKey(fromId ?? '', toId ?? '', AUTO_CHOICE, prefs.lean),
    queryFn: () => planFor(fromId!, toId!, AUTO_CHOICE, prefs.lean),
    enabled: ok && open && choice.style !== 'auto',
    staleTime: 60_000,
    retry: false,
  });
  const dimmed =
    prefs.between === 'dj' ? null : 'Auto mix is off: plays straight on (Play as a mix plays this)';
  const data = plan.isError ? null : (plan.data ?? null);
  // Waiting: the track it waits for shows its step (the set's page asks for them)
  const waitingId =
    data?.status === 'waiting' ? (data.waiting_for === 'from' ? fromId : toId) : null;
  const progress = useAnalysis([waitingId]);
  return (
    <TransitionChip
      transition={transition}
      step={step}
      from={from}
      to={to}
      plan={data}
      autoPlan={choice.style === 'auto' ? data : (auto.data ?? null)}
      dimmed={dimmed}
      progress={waitingId ? (progress[waitingId] ?? null) : null}
      onOpenChange={setOpen}
      onChange={onChange}
    />
  );
}
