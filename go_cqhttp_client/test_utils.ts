import { MessageOfGroupEvent, MessageOfPrivateEvent } from "./events.ts";
import { MessagePiece } from "./message_piece.ts";

export function _test_makeMessageOfGroupEvent(
  sender: { qq: number; groupCard?: string; nickname?: string },
  groupId: number,
  message: MessagePiece[],
  args: {
    timestamp?: number;
  } = {},
) {
  return new MessageOfGroupEvent({
    post_type: "message",
    message_type: "group",
    message_id: 0,
    time: args.timestamp ?? 0,
    group_id: groupId,
    user_id: sender.qq,
    sender: {
      card: sender.groupCard ?? "",
      nickname: sender.nickname ?? "",
    },
    message,
    raw_message: null as unknown as any,
  });
}

export function _test_makeMessageOfPrivateEvent(
  sender: { qq: number },
  message: MessagePiece[],
  args: {
    subType?: "friend";
    timestamp?: number;
  } = {},
) {
  return new MessageOfPrivateEvent({
    post_type: "message",
    message_type: "private",
    sub_type: args.subType ?? "friend",
    message_id: 0,
    time: args.timestamp ?? 0,
    user_id: sender.qq,
    message,
    raw_message: null as unknown as any,
  });
}
