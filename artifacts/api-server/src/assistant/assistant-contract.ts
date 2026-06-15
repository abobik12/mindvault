export type AssistantSelectableIntent =
  | "create_note"
  | "create_list"
  | "create_reminder"
  | "cancel";

export type AssistantActionButton = {
  label: string;
  pendingActionId: string;
  selectedIntent?: AssistantSelectableIntent;
  selectedItemId?: number;
  confirm?: boolean;
  cancel?: boolean;
};

export type PendingAssistantAction = {
  id: string;
  kind: "choose_intent" | "choose_target" | "confirm_action";
  originalMessage: string;
  intent?: string;
  possibleIntents?: AssistantSelectableIntent[];
  targetCandidates?: Array<{
    id: number;
    type: "note" | "list" | "reminder" | "file";
    title: string;
  }>;
  payload: Record<string, unknown>;
  status: "pending";
  createdAt: string;
  expiresAt: string;
};

export type AssistantActionSelection = {
  pendingActionId?: string;
  selectedIntent?: AssistantSelectableIntent;
  selectedItemId?: number;
  confirm?: boolean;
  cancel?: boolean;
};

