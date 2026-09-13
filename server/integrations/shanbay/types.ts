import type { LexicalSense } from "../../types.js";

export const SHANBAY_STATES = ["unlearned", "learning", "simple_learned"] as const;
export type ShanbaySourceState = (typeof SHANBAY_STATES)[number];

export interface ShanbayBook {
  id: string;
  name: string;
  is_current: boolean;
}

export interface ShanbayWord {
  normalized: string;
  display: string;
  ipa_us: string | null;
  ipa_uk: string | null;
  senses: LexicalSense[];
  source_state: ShanbaySourceState;
  position: number;
}

export interface ShanbayPage { objects: unknown[] }
