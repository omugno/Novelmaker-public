// Results of the continuity check per scene (in memory: they are gone after a reload,
// and a fixed passage drops out by itself because its quote is no longer in the text).
import { create } from 'zustand';
import type { ContinuityIssue } from '@novelmaker/shared';

export interface ContinuityResult {
  issues: ContinuityIssue[];
  /** 'scene' = the whole scene, 'selection' = only the selected text */
  scope: 'scene' | 'selection';
  checkedAt: string;
  /** Model answer that could not be read as JSON */
  raw?: string;
  error?: string;
}

interface ContinuityStore {
  results: Record<string, ContinuityResult>;
  setResult: (sceneId: string, r: ContinuityResult) => void;
  dismiss: (sceneId: string, issue: ContinuityIssue) => void;
  clear: (sceneId: string) => void;
}

export const useContinuity = create<ContinuityStore>((set) => ({
  results: {},
  setResult: (sceneId, r) => set((s) => ({ results: { ...s.results, [sceneId]: r } })),
  dismiss: (sceneId, issue) =>
    set((s) => {
      const r = s.results[sceneId];
      return r ? { results: { ...s.results, [sceneId]: { ...r, issues: r.issues.filter((i) => i !== issue) } } } : s;
    }),
  clear: (sceneId) =>
    set((s) => {
      const results = { ...s.results };
      delete results[sceneId];
      return { results };
    }),
}));

const NONE: ContinuityIssue[] = [];
/** Issues of a scene (stable empty array when there are none). */
export const useSceneIssues = (sceneId: string) => useContinuity((s) => s.results[sceneId]?.issues ?? NONE);
