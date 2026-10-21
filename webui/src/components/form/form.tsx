import { Button as BaseButton } from '@base-ui/react/button';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Field } from '@base-ui/react/field';
import { Input as BaseInput } from '@base-ui/react/input';
import { Slider } from '@base-ui/react/slider';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import clsx from 'clsx';
import {
  forwardRef,
  useId,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ButtonHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import styles from './form.module.css';

export interface FormFieldProps {
  children: ReactNode;
  className?: string;
  error?: ReactNode;
  helperText?: ReactNode;
  htmlFor?: string;
  label: ReactNode;
}

export function FormField({
  children,
  className,
  error,
  helperText,
  htmlFor,
  label,
}: FormFieldProps) {
  return (
    // invalid marks a Base UI control inside (TextInput) with aria-invalid,
    // which draws the danger border; native selects take aria-invalid directly
    <Field.Root className={clsx(styles.field, className)} invalid={error ? true : undefined}>
      <div className={styles.fieldHeader}>
        {htmlFor ? (
          <label className={styles.fieldLabel} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <Field.Label className={styles.fieldLabel}>{label}</Field.Label>
        )}
        {helperText ? (
          <Field.Description className={styles.fieldHelper}>{helperText}</Field.Description>
        ) : null}
      </div>
      <div className={styles.fieldControl}>{children}</div>
      {error ? <FormError message={error} /> : null}
    </Field.Root>
  );
}

type BaseInputProps = ComponentPropsWithoutRef<typeof BaseInput>;

export type TextInputProps = Omit<BaseInputProps, 'className'> & {
  className?: string;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, ...props },
  ref,
) {
  return <BaseInput ref={ref} className={clsx(styles.textInput, className)} {...props} />;
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={clsx(styles.textArea, className)} {...props} />;
});

/** `lg` is the 44px select the step editor's sentences use. */
export type SelectSize = 'sm' | 'md' | 'lg';

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'size'> & {
  className?: string;
  size?: SelectSize;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = 'md', ...props },
  ref,
) {
  return (
    <select ref={ref} className={clsx(styles.select, className)} data-size={size} {...props} />
  );
});

type BaseCheckboxProps = ComponentPropsWithoutRef<typeof BaseCheckbox.Root>;

export type CheckboxProps = Omit<BaseCheckboxProps, 'className' | 'children'> & {
  className?: string;
};

export const Checkbox = forwardRef<HTMLElement, CheckboxProps>(function Checkbox(
  { className, ...props },
  ref,
) {
  return (
    <BaseCheckbox.Root ref={ref} className={clsx(styles.checkbox, className)} {...props}>
      <BaseCheckbox.Indicator className={styles.checkboxIndicator}>
        <span className={styles.checkboxIcon} aria-hidden="true">
          ✓
        </span>
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
});

type BaseSwitchProps = ComponentPropsWithoutRef<typeof BaseSwitch.Root>;

export type SwitchProps = Omit<BaseSwitchProps, 'className' | 'children'> & {
  className?: string;
};

export const Switch = forwardRef<HTMLElement, SwitchProps>(function Switch(
  { className, ...props },
  ref,
) {
  return (
    <BaseSwitch.Root ref={ref} className={clsx(styles.switch, className)} {...props}>
      <BaseSwitch.Thumb className={styles.switchThumb} />
    </BaseSwitch.Root>
  );
});

export interface RangeInputProps {
  className?: string;
  disabled?: boolean;
  defaultValue?: number;
  label?: ReactNode;
  max?: number;
  min?: number;
  name?: string;
  step?: number;
  style?: CSSProperties;
  value?: number;
  onValueChange?: (value: number) => void;
}

export const RangeInput = forwardRef<HTMLDivElement, RangeInputProps>(function RangeInput(
  {
    className,
    defaultValue,
    disabled,
    label,
    max = 100,
    min = 0,
    name,
    onValueChange,
    step = 1,
    style,
    value,
  },
  ref,
) {
  return (
    <Slider.Root
      ref={ref}
      className={clsx(styles.rangeRoot, className)}
      min={min}
      max={max}
      thumbAlignment="edge"
      style={style}
      disabled={disabled}
      name={name}
      step={step}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(nextValue) => {
        onValueChange?.(Array.isArray(nextValue) ? nextValue[0] : nextValue);
      }}
    >
      <Slider.Control className={styles.rangeControl}>
        <Slider.Track className={styles.rangeTrack}>
          <Slider.Indicator className={styles.rangeIndicator} />
          <Slider.Thumb
            aria-label={typeof label === 'string' ? label : undefined}
            className={styles.rangeThumb}
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
});

export function OptionCardGroup({
  className,
  children,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx(styles.optionCardGroup, className)}>{children}</div>;
}

export interface OptionCardProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'title' | 'value'
> {
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  title?: ReactNode;
  value?: string;
}

export const OptionCard = forwardRef<HTMLButtonElement, OptionCardProps>(function OptionCard(
  { className, children, description, icon, selected = false, title, type = 'button', ...props },
  ref,
) {
  return (
    <BaseToggle
      ref={ref}
      pressed={selected}
      className={clsx(styles.optionCard, className)}
      data-selected={selected ? 'true' : undefined}
      type={type}
      {...props}
    >
      {children ?? (
        <>
          {icon ? <div className={styles.optionCardIcon}>{icon}</div> : null}
          <div className={styles.optionCardBody}>
            {title ? <div className={styles.optionCardTitle}>{title}</div> : null}
            {description ? <div className={styles.optionCardDescription}>{description}</div> : null}
          </div>
        </>
      )}
    </BaseToggle>
  );
});

export type OptionButtonGroupSize = 'sm' | 'md';

export interface OptionButtonGroupProps {
  children: ReactNode;
  className?: string;
  size?: OptionButtonGroupSize;
}

export function OptionButtonGroup({ className, children, size = 'md' }: OptionButtonGroupProps) {
  return (
    <div className={clsx(styles.optionButtonGroup, className)} data-size={size}>
      {children}
    </div>
  );
}

export type OptionButtonVariant = 'default' | 'ghost';

export interface OptionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  className?: string;
  selected?: boolean;
  variant?: OptionButtonVariant;
  value?: string;
}

export const OptionButton = forwardRef<HTMLButtonElement, OptionButtonProps>(function OptionButton(
  { className, children, selected = false, type = 'button', variant = 'default', ...props },
  ref,
) {
  return (
    <BaseToggle
      ref={ref}
      pressed={selected}
      className={clsx(styles.optionButton, className)}
      data-selected={selected ? 'true' : undefined}
      data-variant={variant}
      type={type}
      {...props}
    >
      {children}
    </BaseToggle>
  );
});

type BaseButtonProps = ComponentPropsWithoutRef<typeof BaseButton>;

export type ButtonProps = Omit<BaseButtonProps, 'className'> & {
  className?: string;
  /**
   * Why the button is disabled, written beside it ("Tick 'I checked the
   * list' to move the files."). Used only while `disabled`: the button then
   * stays focusable (`aria-disabled`, not `disabled`), points at the reason
   * with `aria-describedby`, and the reason renders as a sibling right after
   * the button (`data-slot="disabled-reason"`), so the parent's layout places
   * it.
   */
  disabledReason?: ReactNode;
  /** `lg` is 44px tall, the touch target; use it for page and dialog actions. */
  size?: 'sm' | 'md' | 'lg' | 'icon';
  variant?: 'default' | 'primary' | 'secondary' | 'ghost';
};

/**
 * The shared button. Disabled is neutral for every variant, never a faded
 * accent: 62% text at full opacity, on a 6% fill and 16% border for the
 * primary (quieter for the others). It should come with a reason: pass
 * `disabledReason`, or `focusableWhenDisabled` when the reason is already on
 * screen.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    disabled,
    disabledReason,
    focusableWhenDisabled,
    size = 'md',
    type = 'button',
    variant = 'default',
    ...props
  },
  ref,
) {
  const reasonId = useId();
  const showReason = Boolean(disabled) && disabledReason != null && disabledReason !== false;
  const describedBy = showReason
    ? clsx(props['aria-describedby'], reasonId) || undefined
    : props['aria-describedby'];
  const button = (
    <BaseButton
      ref={ref}
      className={clsx(styles.button, disabled && styles.disabledNeutral, className)}
      data-variant={variant}
      data-size={size}
      type={type}
      disabled={disabled}
      focusableWhenDisabled={focusableWhenDisabled || showReason}
      {...props}
      aria-describedby={describedBy}
    />
  );
  if (!showReason) return button;
  return (
    <>
      {button}
      <span id={reasonId} className={styles.disabledReason} data-slot="disabled-reason">
        {disabledReason}
      </span>
    </>
  );
});

export function FormError({ className, message }: { className?: string; message?: ReactNode }) {
  if (!message) return null;

  return (
    <div className={clsx(styles.formError, className)} role="alert">
      {message}
    </div>
  );
}

export function FormActions({ className, children }: { children: ReactNode; className?: string }) {
  return <div className={clsx(styles.formActions, className)}>{children}</div>;
}
