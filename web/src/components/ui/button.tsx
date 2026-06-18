import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      intent: {
        primary: 'bg-slate-900 text-white hover:bg-slate-700',
        success: 'bg-emerald-600 text-white hover:bg-emerald-500',
        ghost: 'bg-transparent text-slate-700 hover:bg-slate-100'
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4'
      }
    },
    defaultVariants: {
      intent: 'primary',
      size: 'md'
    }
  }
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, intent, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ intent, size }), className)} {...props} />;
}
