import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";

interface PlanReviewDialogProps {
  errorMessage: string | null;
  footer: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  plan: string;
  planFilePath: string | null;
}

export function PlanReviewDialog({
  errorMessage,
  footer,
  onOpenChange,
  open,
  plan,
  planFilePath,
}: PlanReviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(90dvh,72rem)] w-full max-w-none flex-col gap-0 overflow-hidden p-0 md:w-[min(96vw,72rem)]"
        data-testid="plan-review-dialog"
      >
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-border px-5 py-3 pr-12">
          <DialogTitle className="text-sm font-medium">Plan review</DialogTitle>
          <DialogDescription
            className={planFilePath ? "break-all font-mono text-xs" : "sr-only"}
          >
            {planFilePath ?? "Full-size view of the proposed plan."}
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">
          <MarkdownPreview content={plan} className="text-sm" />
        </div>
        {errorMessage ? (
          <div
            aria-live="polite"
            className="mx-5 mb-2 rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
          >
            {errorMessage}
          </div>
        ) : null}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}
