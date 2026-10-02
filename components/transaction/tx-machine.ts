/**
 * Transaction state machine for the issue-credential flow.
 *
 * Kept as a pure reducer (no React, no wallet imports) so every transition is
 * unit-testable and the UI cannot invent a state that skips a real step. A
 * signature only ever exists in states that require one to have been produced.
 */

export type TxState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "preparing" }
  | { status: "signing" }
  | { status: "submitted"; signature: string }
  | { status: "confirming"; signature: string }
  | { status: "success"; signature: string }
  | { status: "failed"; code: string; message: string; retryable: boolean; signature?: string };

export type TxAction =
  | { type: "CONNECT_START" }
  | { type: "CONNECTED" }
  | { type: "DISCONNECT" }
  | { type: "PREPARE_START" }
  | { type: "PREPARED" }
  | { type: "SIGN_START" }
  | { type: "SIGNED"; signature: string }
  | { type: "CONFIRM_START" }
  | { type: "CONFIRMED" }
  | { type: "FAIL"; code: string; message: string; retryable: boolean; signature?: string }
  | { type: "RESET" };

export const INITIAL_TX_STATE: TxState = { status: "disconnected" };

/** In-flight states a retry must not silently restart, to avoid double signing. */
const IN_FLIGHT: TxState["status"][] = ["preparing", "signing", "submitted", "confirming"];

export function txReducer(state: TxState, action: TxAction): TxState {
  switch (action.type) {
    case "CONNECT_START":
      return state.status === "disconnected" ? { status: "connecting" } : state;
    case "CONNECTED":
      return state.status === "connecting" ? { status: "connected" } : state;
    case "DISCONNECT":
      return { status: "disconnected" };
    case "PREPARE_START":
      return state.status === "connected" ? { status: "preparing" } : state;
    case "PREPARED":
      return state.status === "preparing" ? { status: "signing" } : state;
    case "SIGN_START":
      return state.status === "connected" || state.status === "preparing"
        ? { status: "signing" }
        : state;
    case "SIGNED":
      return state.status === "signing" ? { status: "submitted", signature: action.signature } : state;
    case "CONFIRM_START":
      return state.status === "submitted"
        ? { status: "confirming", signature: state.signature }
        : state;
    case "CONFIRMED":
      return state.status === "confirming" ? { status: "success", signature: state.signature } : state;
    case "FAIL": {
      // A signature produced before the failure stays visible: the transaction
      // may still land, and hiding the real id would be worse than showing a
      // failed state that references it.
      const carried = "signature" in state ? state.signature : undefined;
      return {
        status: "failed",
        code: action.code,
        message: action.message,
        retryable: action.retryable,
        signature: action.signature ?? carried,
      };
    }
    case "RESET":
      if (state.status === "failed" || IN_FLIGHT.includes(state.status)) {
        return { status: "connected" };
      }
      return state;
    default:
      return state;
  }
}

export function isBusy(state: TxState): boolean {
  return (
    state.status === "connecting" ||
    state.status === "preparing" ||
    state.status === "signing" ||
    state.status === "submitted" ||
    state.status === "confirming"
  );
}

export function signatureOf(state: TxState): string | undefined {
  return "signature" in state ? state.signature : undefined;
}
