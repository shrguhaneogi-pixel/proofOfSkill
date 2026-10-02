"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

import { EXPLANATION_RANGE, CODE_RANGE, REPO_URL_PATTERN } from "@/lib/evaluation/limits";

type Props = {
  challengeId: 1 | 2 | 3 | 4 | 5;
  pending: boolean;
  onSubmit: (submission: {
    challengeId: number;
    explanation: string;
    code: string;
    repoUrl?: string;
  }) => Promise<void>;
};

type FieldErrors = { explanation?: string; code?: string; repoUrl?: string };

/**
 * Bounds are shared with the server schema in `lib/evaluation`, so the user is
 * never told a submission is valid that the API will then reject. The server
 * remains authoritative.
 */
export function SubmissionForm({ challengeId, pending, onSubmit }: Props) {
  const [explanation, setExplanation] = useState("");
  const [code, setCode] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const validate = useCallback((): FieldErrors => {
    const next: FieldErrors = {};
    const trimmedExplanation = explanation.trim();
    const trimmedCode = code.trim();

    if (trimmedExplanation.length < EXPLANATION_RANGE.min) {
      next.explanation = `Add more detail — at least ${EXPLANATION_RANGE.min} characters (currently ${trimmedExplanation.length}).`;
    } else if (trimmedExplanation.length > EXPLANATION_RANGE.max) {
      next.explanation = `Trim it to ${EXPLANATION_RANGE.max} characters or fewer.`;
    }
    if (trimmedCode.length < CODE_RANGE.min) {
      next.code = "Include the code or pseudocode you are submitting.";
    } else if (trimmedCode.length > CODE_RANGE.max) {
      next.code = `Trim the snippet to ${CODE_RANGE.max} characters or fewer.`;
    }
    if (repoUrl.trim() !== "" && !REPO_URL_PATTERN.test(repoUrl.trim())) {
      next.repoUrl = "Use a repository URL like https://github.com/owner/repo";
    }
    return next;
  }, [code, explanation, repoUrl]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const found = validate();
      setErrors(found);
      if (Object.keys(found).length > 0) {
        return;
      }
      const trimmedRepo = repoUrl.trim();
      await onSubmit({
        challengeId,
        explanation: explanation.trim(),
        code: code.trim(),
        ...(trimmedRepo.length > 0 ? { repoUrl: trimmedRepo } : {}),
      });
    },
    [challengeId, code, explanation, onSubmit, repoUrl, validate],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="explanation">Written explanation</Label>
        <Textarea
          id="explanation"
          value={explanation}
          onChange={(event) => setExplanation(event.target.value)}
          rows={10}
          aria-invalid={errors.explanation !== undefined}
          aria-describedby={errors.explanation ? "explanation-error" : undefined}
          placeholder="Explain your reasoning in your own words. Cover the rubric criteria explicitly."
          className="font-sans"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {EXPLANATION_RANGE.min}–{EXPLANATION_RANGE.max} characters
          </span>
          <span className="font-mono tabular-nums">{explanation.trim().length}</span>
        </div>
        {errors.explanation && (
          <p id="explanation-error" className="text-xs text-destructive">
            {errors.explanation}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="code">Code or pseudocode</Label>
        <Textarea
          id="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          rows={8}
          spellCheck={false}
          aria-invalid={errors.code !== undefined}
          aria-describedby={errors.code ? "code-error" : undefined}
          placeholder="// paste the snippet you want evaluated"
          className="font-mono text-[0.8125rem]"
        />
        <p id="code-hint" className="text-xs text-muted-foreground">
          Nothing here is executed. It is stored offchain and hashed; only the hash reaches Solana.
        </p>
        {errors.code && (
          <p className="text-xs text-destructive">{errors.code}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="repoUrl">Repository URL (optional)</Label>
        <Input
          id="repoUrl"
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          inputMode="url"
          aria-invalid={errors.repoUrl !== undefined}
          placeholder="https://github.com/owner/repo"
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Recorded and hashed as evidence. The server never fetches it.
        </p>
        {errors.repoUrl && <p className="text-xs text-destructive">{errors.repoUrl}</p>}
      </div>

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Evaluating…" : "Submit for AI evaluation"}
      </Button>
    </form>
  );
}
