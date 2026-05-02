import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Canonical Button. Variants are wired to the Vina design tokens (see
 * `src/theme/tokens.css`) rather than the stock shadcn theme — `default` is
 * the electric-lime call-to-action, `destructive` maps to danger, etc.
 *
 * `asChild` defers rendering to the child element via Radix Slot, so a
 * <Button asChild><Link>…</Link></Button> renders as a styled <a>.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-surface-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed',
        destructive: 'bg-danger text-ink-inverse hover:bg-danger/90',
        outline:
          'border border-border bg-surface-raised text-ink-primary hover:bg-surface-overlay',
        secondary: 'bg-surface-sunken text-ink-primary hover:bg-surface-overlay',
        ghost: 'text-ink-primary hover:bg-surface-overlay',
        link: 'text-ink-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
