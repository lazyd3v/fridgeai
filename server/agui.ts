import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { RunStreamEvent } from '@openai/agents';

// Translate public SDK output only. Reasoning and provider metadata stay on the Pi.
export function createAgUiBridge(emit: (event: BaseEvent) => void) {
  let textId: string | null = null;
  let text = '';
  const endText = () => {
    if (textId) emit({ type: EventType.TEXT_MESSAGE_END, messageId: textId } as BaseEvent);
    textId = null;
  };
  return {
    event(event: RunStreamEvent) {
      if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
        if (!textId) { textId = randomUUID(); emit({ type: EventType.TEXT_MESSAGE_START, messageId: textId, role: 'assistant' } as BaseEvent); }
        text += event.data.delta;
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta: event.data.delta } as BaseEvent);
      }
      if (event.type !== 'run_item_stream_event') return;
      const item = event.item.rawItem;
      if (item?.type === 'function_call') {
        endText();
        emit({ type: EventType.TOOL_CALL_START, toolCallId: item.callId, toolCallName: item.name } as BaseEvent);
        emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: item.callId, delta: item.arguments } as BaseEvent);
        emit({ type: EventType.TOOL_CALL_END, toolCallId: item.callId } as BaseEvent);
      }
      if (item?.type === 'function_call_result') {
        emit({ type: EventType.TOOL_CALL_RESULT, messageId: randomUUID(), toolCallId: item.callId, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output), role: 'tool' } as BaseEvent);
      }
    },
    finish(output: string) {
      if (!text && output) {
        textId = randomUUID();
        emit({ type: EventType.TEXT_MESSAGE_START, messageId: textId, role: 'assistant' } as BaseEvent);
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta: output } as BaseEvent);
      }
      endText();
    },
  };
}
