const noop = () => {};
const noopAsync = async () => {};

export function createNoopTraceRecorder() {
  return {
    finish: noopAsync,
    recordLlmCall: noop,
    recordToolStart: () => "",
    recordToolEnd: noop,
    recordAgentStart: () => "",
    recordAgentEnd: noop,
    traceSpanInfo: () => null,
    currentTraceSpanInfo: () => null,
  };
}
