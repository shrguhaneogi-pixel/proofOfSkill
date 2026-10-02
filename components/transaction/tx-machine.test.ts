import { describe, expect, it } from "vitest";

import { INITIAL_TX_STATE, isBusy, signatureOf, txReducer, type TxState } from "./tx-machine";

const step = (state: TxState, action: Parameters<typeof txReducer>[1]) => txReducer(state, action);

describe("tx machine happy path", () => {
  it("walks disconnected to success and only exposes a signature after signing", () => {
    let state: TxState = INITIAL_TX_STATE;
    state = step(state, { type: "CONNECT_START" });
    expect(state.status).toBe("connecting");
    state = step(state, { type: "CONNECTED" });
    expect(state.status).toBe("connected");
    state = step(state, { type: "PREPARE_START" });
    expect(state.status).toBe("preparing");
    state = step(state, { type: "PREPARED" });
    expect(state.status).toBe("signing");

    // No signature exists yet, so nothing can render a fake Explorer link.
    expect(signatureOf(state)).toBeUndefined();

    state = step(state, { type: "SIGNED", signature: "5realSig" });
    expect(state).toEqual({ status: "submitted", signature: "5realSig" });
    state = step(state, { type: "CONFIRM_START" });
    expect(state).toEqual({ status: "confirming", signature: "5realSig" });
    state = step(state, { type: "CONFIRMED" });
    expect(state).toEqual({ status: "success", signature: "5realSig" });
    expect(isBusy(state)).toBe(false);
    expect(signatureOf(state)).toBe("5realSig");
  });
});

describe("tx machine guards", () => {
  it("ignores out-of-order transitions instead of inventing state", () => {
    expect(step(INITIAL_TX_STATE, { type: "CONFIRMED" }).status).toBe("disconnected");
    expect(step(INITIAL_TX_STATE, { type: "PREPARE_START" }).status).toBe("disconnected");
    expect(step({ status: "connected" }, { type: "CONFIRM_START" }).status).toBe("connected");
    expect(step({ status: "connected" }, { type: "SIGNED", signature: "x" }).status).toBe(
      "connected",
    );
  });

  it("refuses to re-enter connecting from a connected wallet", () => {
    expect(step({ status: "connected" }, { type: "CONNECT_START" }).status).toBe("connected");
  });

  it("keeps the signature on a failed submission so the UI can show what happened", () => {
    const state = step(
      { status: "confirming", signature: "5abc" },
      { type: "FAIL", code: "BLOCKHASH_EXPIRED", message: "try again", retryable: true },
    );
    expect(state).toEqual({
      status: "failed",
      code: "BLOCKHASH_EXPIRED",
      message: "try again",
      retryable: true,
      signature: "5abc",
    });
    expect(signatureOf(state)).toBe("5abc");
  });

  it("resets a failure back to connected, and never out of success", () => {
    const failed: TxState = { status: "failed", code: "X", message: "y", retryable: true };
    expect(step(failed, { type: "RESET" }).status).toBe("connected");
    expect(step({ status: "success", signature: "s" }, { type: "RESET" }).status).toBe("success");
    expect(step({ status: "disconnected" }, { type: "RESET" }).status).toBe("disconnected");
  });

  it("reports busy for every in-flight state", () => {
    expect(isBusy({ status: "preparing" })).toBe(true);
    expect(isBusy({ status: "signing" })).toBe(true);
    expect(isBusy({ status: "submitted", signature: "s" })).toBe(true);
    expect(isBusy({ status: "confirming", signature: "s" })).toBe(true);
    expect(isBusy({ status: "disconnected" })).toBe(false);
    expect(isBusy({ status: "connected" })).toBe(false);
  });

  it("disconnect always wins, so a locked UI can recover", () => {
    expect(step({ status: "signing" }, { type: "DISCONNECT" }).status).toBe("disconnected");
  });
});
