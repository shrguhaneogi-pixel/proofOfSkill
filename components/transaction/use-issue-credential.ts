"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useReducer } from "react";

import { mapIssueError, type UserError } from "@/lib/errors/mapping";

import { INITIAL_TX_STATE, txReducer } from "./tx-machine";

type IssueResponse = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  credentialPda: string;
  profilePda: string;
};

type IssueDeps = {
  attestation: string;
  onIssued: (result: { signature: string; credentialPda: string }) => void;
};

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Drives the issuer model end to end: the server builds and partially signs,
 * the wallet signs and sends, and the client waits on the real blockhash rather
 * than a fixed timeout. No signature is ever synthesized locally.
 */
export function useIssueCredential({ attestation, onIssued }: IssueDeps) {
  const [state, dispatch] = useReducer(txReducer, INITIAL_TX_STATE);
  const { connection } = useConnection();
  const { connected, publicKey, sendTransaction, signTransaction } = useWallet();

  const issue = useCallback(async () => {
    if (!connected || !publicKey) {
      dispatch({ type: "CONNECT_START" });
      return;
    }

    dispatch({ type: "PREPARE_START" });

    let payload: IssueResponse;
    try {
      const response = await fetch("/api/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attestation, wallet: publicKey.toBase58() }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        throw Object.assign(new Error(body?.error?.message ?? "issue failed"), {
          code: body?.error?.code ?? "ISSUE_FAILED",
          status: response.status,
        });
      }

      payload = (await response.json()) as IssueResponse;
      dispatch({ type: "PREPARED" });
    } catch (error) {
      dispatch({ type: "FAIL", ...toFailure(error) });
      return;
    }

    let signature: string;
    try {
      const transaction = VersionedTransaction.deserialize(base64ToBytes(payload.transaction));
      const signed = signTransaction ? await signTransaction(transaction) : transaction;
      signature = await sendTransaction(signed, connection);
      dispatch({ type: "SIGNED", signature });
    } catch (error) {
      dispatch({ type: "FAIL", ...toFailure(error) });
      return;
    }

    dispatch({ type: "CONFIRM_START" });
    try {
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: payload.blockhash,
          lastValidBlockHeight: payload.lastValidBlockHeight,
        },
        "confirmed",
      );

      if (confirmation.value.err) {
        dispatch({
          type: "FAIL",
          code: "TRANSACTION_FAILED_ONCHAIN",
          message: "The network rejected the transaction. It was not recorded.",
          retryable: true,
          signature,
        });
        return;
      }

      dispatch({ type: "CONFIRMED" });
      onIssued({ signature, credentialPda: payload.credentialPda });
    } catch (error) {
      dispatch({ type: "FAIL", ...toFailure(error, signature) });
    }
  }, [attestation, connected, connection, publicKey, sendTransaction, signTransaction, onIssued]);

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  return { state, issue, reset, retry: issue };
}

function toFailure(error: unknown, signature?: string) {
  const mapped: UserError = mapIssueError(error);
  return {
    code: mapped.code,
    message: mapped.message,
    retryable: mapped.retryable,
    signature,
  };
}
