export interface StudyKeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export function shouldSubmitSingleLine(input: StudyKeyInput): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

export function shouldSubmitMultiline(input: StudyKeyInput): boolean {
  return input.key === "Enter" && (input.ctrlKey || input.metaKey) && !input.isComposing;
}
